// PCB CAM workspace, laid out like FlatCAM: a menu bar and toolbar, a side
// panel with Project / Selected / Tool tabs, the plot area and a status bar.
// Workflow: open Gerber / Excellon objects → create Geometry objects from them
// (one project operation each) → create CNC Job objects from geometries and
// load their G-code into gSender. All board logic lives in ../core; every
// project change goes through its command layer.

import { storage, gcode, getWorkspaceState } from '@sienci/gsender-plugin-sdk';
import {
    loadFile, createProject, applyCommand, validateProject, inspectBoard, componentOf, netOf, isPlated,
    createToolDb, setTool, removeTool, findTool, widthAtDepth, regionMask, multiDepth, drillMethod, geometry as G,
} from '../core/index.js';
import { DEFAULT_TOOLS, operationDefaults, standardJob, pickTool, OP_TOOL_TYPES } from './defaults.js';
import { createEngine } from './engine.js';
import { installIcons, icon } from './icons.js';
import { createView, toolpathPath } from './view.js';
import { session, savedHandle, fileApi, pickSaveFile, pickOpenFile, writePermission, writeFile, readFile } from './persist.js';

// gSender records sessions with PostHog when usage data collection is on, and
// the recorder also captures same-origin plugin iframes. Opt the page out.
document.body.classList.add('ph-no-capture');
try {
    window.frameElement?.classList.add('ph-no-capture');
} catch { /* not same-origin */ }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ROLES = ['copper', 'outline', 'drill', 'other'];
const SIDES = ['top', 'bottom', null];
const COLORS = { 'copper-top': '#d4893f', 'copper-bottom': '#4a90e2', copper: '#c0a060', outline: '#e6c229', drill: '#f0f0f0', other: '#8b949e' };
const OP_COLORS = ['#0ef6ae', '#ff7edb', '#5ab0ff', '#ffd166', '#c792ea', '#ff8a65', '#7ee787', '#f2cc60'];
const OP_LABEL = { isolation: 'Isolation', drilling: 'Drilling', cutout: 'Cutout', clearing: 'Copper clearing' };
const OP_ICON = { isolation: 'b-isolation', drilling: 'b-drill', cutout: 'b-cutout', clearing: 'b-clearing' };
const TOOL_ICON = { vbit: 't-vbit', endmill: 't-endmill', drill: 't-drill' };
const OP_SUFFIX = { isolation: 'iso', drilling: 'drill', cutout: 'cutout', clearing: 'ncc' };
const TOOL_LABEL = { vbit: 'V-bit', endmill: 'End mill', drill: 'Drill' };

const state = {
    side: 'project',     // side panel tab: project | selected | tool
    main: 'plot',        // plot area tab: plot | prefs | code
    code: null,          // { title, text, file } shown in the code tab
    menu: null,          // open menu bar menu
    project: createProject('Board'),
    layers: {},          // input id → parsed layer
    texts: {},           // input id → { name, text } of the board file (autosaved)
    meta: {},            // input id → { guess, visible, open }
    rejected: [],
    report: null,
    tooldb: createToolDb(DEFAULT_TOOLS),
    editTool: null,      // tool id being edited, or 'new:<type>'
    toolErrors: null,
    sel: [],             // selected objects: { kind: 'input' | 'geo' | 'job', id }
    drafts: {},          // `${inputId}:${type}` → settings for a geometry not created yet
    open: {},            // collapsible sections and tree groups → open?
    regionPicker: null,  // { target, kind: 'component' | 'net' }
    drawing: null,       // { target } while drawing a rectangle region
    geo: {},             // operation id → preview { key, ok, op, transform, issues, analysis, busy }
    hidden: {},          // 'geo:<id>' / 'job:<id>' → hidden on the plot
    jobs: [],            // CNC jobs: { id, name, ops, result?, key?, busy? }
    selIssue: null,
    openGroups: {},      // problem group key → expanded
    selected: null,      // highlighted component
    filter: '',
    pick: null,
    status: null,
    exportText: null,    // { title, text } shown for copying
    toolChangeOption: null,
    file: null,          // project file on disk: { handle, name, status: saved | dirty | saving | paused | error, error }
    lastFileName: null,  // project file used before gSender restarted
};

const engine = createEngine();

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'className') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const fmt = (v, d = 2) => (v === null || v === undefined ? '–' : Number(v).toFixed(d));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fileBase = (name) => String(name).replace(/\.[^.]+$/, '');

function setStatus(text, err = false) {
    state.status = text ? { text, err } : null;
    renderStatus();
}

/** Applies a project command; shows the error and returns null when it fails. */
function command(name, args, { quiet = false } = {}) {
    const r = applyCommand(state.project, { name, args });
    if (!r.ok) {
        const detail = r.error.errors ? `: ${r.error.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}` : '';
        if (!quiet) setStatus(`${r.error.message}${detail}`, true);
        return null;
    }
    state.project = r.project;
    saveProject();
    scheduleGeometry();
    return r.result ?? {};
}

function uniqueId(list, base) {
    const slug = String(base).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
    const used = new Set(list.map((x) => x.id));
    if (!used.has(slug)) return slug;
    for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

// ---------------------------------------------------------------------------
// Persistence. gSender unloads this iframe when you leave the CAM page, so the
// workspace is saved continuously, in three places by size:
//  - gSender's plugin storage (its settings file, kept in memory and rewritten
//    on every change): only the small parts, under a size cap: project
//    settings, the CNC job list, UI state, tool library.
//  - the browser session (persist.js): board files and the G-code of jobs whose
//    geometry was deleted. Survives leaving the page, not quitting gSender.
//  - the project file on disk, once the project was saved to one: everything,
//    autosaved after each change. It is what survives a restart.
// Toolpaths and live jobs' G-code are not stored; they are regenerated.
// Plugin storage values are JSON strings because storage.set deep-merges
// objects; a string replaces the old value in one message (delete-then-set
// lost the project when the page unloaded between the two).
// ---------------------------------------------------------------------------

const MAX_SETTINGS_VALUE = 256 * 1024; // characters per plugin storage key
const KEYS = { project: 'project.json', jobs: 'jobs.json', ui: 'ui.json', tooldb: 'tooldb.json' };
const pending = new Map(); // key → value waiting for its debounce
let flushTimer = null;

function queueSave(key, value, ms = 300) {
    pending.set(key, value);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushSaves, ms);
}
function flushSaves() {
    clearTimeout(flushTimer);
    for (const [key, value] of pending) {
        const text = JSON.stringify(value);
        if (text.length > MAX_SETTINGS_VALUE) {
            setStatus(`Not saved: ${key} is ${Math.round(text.length / 1024)} KB, too large for gSender's settings. Save the project to a file.`, true);
            continue;
        }
        storage.set(key, text).catch((e) => console.warn(`PCB CAM: save ${key}`, e));
    }
    pending.clear();
}
async function readStored(key, legacy) {
    const v = await storage.get(key, null);
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    if (!legacy) return null;
    const old = await storage.get(legacy, null);
    if (old !== null) storage.delete(legacy).catch(() => {}); // rewritten under `key` on the next save
    return old;
}

/** What a frozen job keeps of its result (no toolpaths). */
const keptResult = (r) => r && { ok: r.ok, issues: r.issues, files: r.files, stats: r.stats };

const saveProject = () => { queueSave(KEYS.project, state.project); markDirty(); };
const saveToolDb = () => queueSave(KEYS.tooldb, state.tooldb, 0);
function saveJobs() {
    queueSave(KEYS.jobs, state.jobs.map(({ id, name, ops, result, frozen }) => ({ id, name, ops, hadResult: !!result, ...(frozen ? { frozen } : {}) })));
    const code = Object.fromEntries(state.jobs.filter((j) => j.frozen && j.result).map((j) => [j.id, keptResult(j.result)]));
    if (!session.set('frozen', code) && !state.file) warnOnce('frozen', 'The G-code of jobs whose geometry was deleted is too large to keep when you leave this page. Save the project to a file (File → Save project) to keep it.');
    markDirty();
}
function saveFiles() {
    if (!session.set('files', state.texts) && !state.file) warnOnce('files', 'The board files are too large to keep when you leave this page. Save the project to a file (File → Save project) to keep them.');
    markDirty();
}
const warned = new Set();
function warnOnce(key, text) {
    if (warned.has(key)) return;
    warned.add(key);
    setStatus(text, true);
}

let uiReady = false; // don't save the UI before the saved one is applied
function saveUi() {
    if (!uiReady) return;
    queueSave(KEYS.ui, {
        side: state.side, main: state.main === 'code' ? 'plot' : state.main, sel: state.sel, hidden: state.hidden, open: state.open,
        visible: Object.fromEntries(Object.entries(state.meta).map(([id, m]) => [id, m.visible])), view: view.getView(),
        fileName: state.file?.name ?? null,
    }, 1000);
}
// Leaving the page: send what is still waiting.
const leaving = () => { saveUi(); flushSaves(); if (diskTimer) writeToDisk(); };
window.addEventListener('pagehide', leaving);
document.addEventListener('visibilitychange', () => { if (document.hidden) leaving(); });

// --- Project file on disk ---------------------------------------------------

const PROJECT_FORMAT = 'pcb-cam-project';
let diskTimer = null;

/** The whole workspace as one document: the project file's content. */
function projectDoc() {
    const boardFiles = {};
    for (const f of Object.values(state.texts)) boardFiles[f.name] = f.text;
    return {
        format: PROJECT_FORMAT, version: 1, project: state.project, boardFiles,
        jobs: state.jobs.map((j) => ({ id: j.id, name: j.name, ops: j.ops, hadResult: !!j.result, ...(j.frozen ? { frozen: j.frozen, result: keptResult(j.result) } : {}) })),
    };
}

function markDirty() {
    if (!state.file || state.file.status === 'paused') return;
    if (state.file.status !== 'saving') setFileStatus('dirty');
    clearTimeout(diskTimer);
    diskTimer = setTimeout(writeToDisk, 1500);
}
function setFileStatus(status, error = null) {
    if (!state.file) return;
    state.file.status = status;
    state.file.error = error;
    renderFileState();
}
async function writeToDisk() {
    clearTimeout(diskTimer);
    diskTimer = null;
    const f = state.file;
    if (!f || f.status === 'paused') return;
    setFileStatus('saving');
    try {
        await writeFile(f.handle, JSON.stringify(projectDoc()));
        if (state.file === f && !diskTimer) setFileStatus('saved');
    } catch (e) {
        console.warn('PCB CAM: write project file', e);
        if (state.file === f) setFileStatus('error', e.message);
    }
}

/** File → Save project (as). Must run straight from a click (file picker). */
async function saveProjectFile({ as = false } = {}) {
    if (!fileApi) { showExport('Project JSON', projectDoc()); return; }
    try {
        let handle = !as && state.file?.handle;
        if (!handle) {
            handle = await pickSaveFile(`${(state.project.name || 'board').replace(/[^\w.-]+/g, '-')}.pcbcam.json`);
            if (!handle) return;
        } else if (await writePermission(handle, true) !== 'granted') {
            setStatus(`gSender did not allow writing to ${handle.name}. Use File → Save project as… to pick a file.`, true);
            return;
        }
        state.file = { handle, name: handle.name, status: 'saving', error: null };
        savedHandle.set(handle);
        await writeToDisk();
        if (state.file?.status === 'saved') setStatus(`Saved to ${handle.name}. Changes are saved there automatically.`);
        saveUi();
    } catch (e) {
        console.error(e);
        setStatus(`Could not save the project file: ${e.message}. File → Export project JSON shows it for copying.`, true);
    }
}

/** File → Open project. Must run straight from a click (file picker). */
async function openProjectFile() {
    if (!fileApi) { openPicker('.json,application/json'); return; }
    try {
        const handle = await pickOpenFile();
        if (!handle) return;
        const text = await readFile(handle);
        if (!importJson(handle.name, text)) return;
        const perm = await writePermission(handle, true);
        state.file = { handle, name: handle.name, status: perm === 'granted' ? 'saved' : 'paused', error: null };
        savedHandle.set(handle);
        saveUi();
        renderFileState();
    } catch (e) {
        console.error(e);
        setStatus(`Could not open the project file: ${e.message}`, true);
    }
}

function forgetProjectFile() {
    clearTimeout(diskTimer);
    diskTimer = null;
    state.file = null;
    savedHandle.set(null);
}

// --- Restore ----------------------------------------------------------------

let restoredUi = null;
async function restore() {
    let frozen = session.get('frozen') ?? {};
    try {
        const db = await readStored(KEYS.tooldb, 'tooldb');
        if (db && Array.isArray(db.tools)) state.tooldb = db;
        const p = await readStored(KEYS.project, 'project');
        if (p && p.version === 1) {
            const issues = validateProject(p).filter((i) => i.code === 'schema');
            if (!issues.length) state.project = p;
        }
        // Board files were kept in plugin storage for a short while; move them out.
        const oldFiles = await storage.get('files.json', null);
        if (oldFiles !== null) {
            storage.delete('files.json').catch(() => {});
            if (!session.get('files') && typeof oldFiles === 'string') { try { session.set('files', JSON.parse(oldFiles)); } catch { /* drop */ } }
        }
        attachKeptFiles(session.get('files') ?? {});
        const jobs = await readStored(KEYS.jobs, 'jobs');
        if (Array.isArray(jobs)) state.jobs = restoreJobs(jobs, (j) => frozen[j.id]);
        restoredUi = await readStored(KEYS.ui);
    } catch (e) {
        state.status = { err: true, text: `Storage unavailable: ${e.message}` };
    }
    // The project file, when one is open in this gSender session, fills in what
    // the session couldn't keep.
    const handle = await savedHandle.get();
    if (handle && fileApi) {
        const perm = await writePermission(handle);
        state.file = { handle, name: handle.name, status: perm === 'granted' ? 'saved' : 'paused', error: null };
        const needFiles = state.project.inputs.some((i) => !state.layers[i.id]);
        const needCode = state.jobs.some((j) => j.frozen && !j.result);
        if (perm !== 'denied' && (needFiles || needCode)) {
            try {
                const doc = JSON.parse(await readFile(handle));
                if (doc?.format === PROJECT_FORMAT) {
                    const byName = doc.boardFiles ?? {};
                    attachKeptFiles(Object.fromEntries(state.project.inputs.filter((i) => typeof byName[i.file] === 'string').map((i) => [i.id, { name: i.file, text: byName[i.file] }])));
                    frozen = Object.fromEntries((doc.jobs ?? []).filter((j) => j.frozen && j.result).map((j) => [j.id, j.result]));
                    for (const j of state.jobs) if (j.frozen && !j.result && frozen[j.id]) j.result = frozen[j.id];
                }
            } catch (e) {
                console.warn('PCB CAM: read project file', e);
            }
        }
    }
    try {
        const ws = await getWorkspaceState();
        state.toolChangeOption = ws?.toolChangeOption ?? null;
        applyTheme(ws);
    } catch { /* outside gSender */ }
}

/** Attaches kept board files ({ inputId: { name, text } }) to inputs still missing them. */
function attachKeptFiles(files) {
    for (const input of state.project.inputs) {
        const f = files[input.id];
        if (!state.layers[input.id] && f && f.name === input.file && typeof f.text === 'string') attachFile(input.id, f.name, f.text);
    }
}

/** Job list from storage or a project file; `resultOf(j)` gives a frozen job's kept result. */
function restoreJobs(list, resultOf) {
    const ids = new Set(state.project.operations.map((o) => o.id));
    return list.filter((j) => j && j.id && Array.isArray(j.ops))
        .map((j) => (j.frozen
            ? { id: j.id, name: j.name || j.id, ops: [], frozen: j.frozen, result: resultOf(j) ?? null }
            : { id: j.id, name: j.name || j.id, ops: j.ops.filter((o) => ids.has(o)), rerun: !!j.hadResult }))
        .filter((j) => j.frozen || j.ops.length);
}

/** Puts back the side tab, selection, visibility and zoom saved by saveUi. */
function applyRestoredUi() {
    const u = restoredUi;
    if (!u) return false;
    if (['project', 'selected', 'tool'].includes(u.side)) state.side = u.side;
    if (['plot', 'prefs'].includes(u.main)) state.main = u.main;
    const exists = (s) => (s.kind === 'input' ? inputOf(s.id) : s.kind === 'geo' ? opOf(s.id) : state.jobs.some((j) => j.id === s.id));
    if (Array.isArray(u.sel)) state.sel = u.sel.filter((s) => s && exists(s));
    if (u.hidden && typeof u.hidden === 'object') state.hidden = u.hidden;
    if (u.open && typeof u.open === 'object') state.open = u.open;
    for (const [id, v] of Object.entries(u.visible ?? {})) if (state.meta[id]) state.meta[id].visible = v !== false;
    state.lastFileName = typeof u.fileName === 'string' ? u.fileName : null;
    return !!u.view && view.setView(u.view);
}

function applyTheme(ws) {
    if (typeof ws?.enableDarkMode === 'boolean') document.documentElement.dataset.theme = ws.enableDarkMode ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const isSel = (kind, id) => state.sel.some((s) => s.kind === kind && s.id === id);
const primary = () => state.sel[state.sel.length - 1] ?? null;

function selectObj(kind, id, { add = false, show = false } = {}) {
    if (add) {
        state.sel = isSel(kind, id) ? state.sel.filter((s) => !(s.kind === kind && s.id === id)) : [...state.sel, { kind, id }];
    } else {
        state.sel = [{ kind, id }];
    }
    if (show) state.side = 'selected';
    state.selIssue = null;
    cancelDraw();
    state.regionPicker = null;
    render();
    updateScene();
}

function dropFromSelection(kind, id) {
    state.sel = state.sel.filter((s) => !(s.kind === kind && s.id === id));
}

function deleteSelected() {
    if (!state.sel.length) { setStatus('Select an object in the Project tab first.'); return; }
    const sel = [...state.sel];
    const order = { job: 0, geo: 1, input: 2 };
    sel.sort((a, b) => order[a.kind] - order[b.kind]);
    const done = [];
    for (const s of sel) {
        if (s.kind === 'job') { removeJob(s.id); done.push(s.id); }
        else if (s.kind === 'geo') { if (removeOperation(s.id)) done.push(s.id); }
        else if (removeInput(s.id)) done.push(s.id);
    }
    if (done.length === sel.length) setStatus(`Deleted ${done.length} object${done.length > 1 ? 's' : ''}.`);
    render();
    updateScene();
}

// ---------------------------------------------------------------------------
// Files (Gerber and Excellon objects)
// ---------------------------------------------------------------------------

async function openFiles(files) {
    files = [...files];
    if (!files.length) return;
    let n = 0;
    let added = null;
    for (const file of files) {
        n++;
        setStatus(`Reading ${file.name} (${n}/${files.length})…`);
        await nextFrame();
        try {
            const text = await file.text();
            if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) {
                importJson(file.name, text);
                continue;
            }
            const loaded = loadFile(file.name, text);
            if (!loaded.layer) {
                state.rejected.push({ name: file.name, reason: loaded.guess.reason });
                continue;
            }
            // A saved project's input waiting for this file?
            let id = state.project.inputs.find((i) => i.file === file.name && !state.layers[i.id])?.id;
            if (!id) {
                const g = loaded.guess;
                const role = ROLES.includes(g.role) ? g.role : 'other';
                const side = (role === 'copper' || role === 'other') && SIDES.includes(g.side) ? g.side : role === 'copper' ? 'top' : null;
                const args = { file: file.name, role, side };
                if (role === 'drill' && typeof g.plated === 'boolean') args.plated = g.plated;
                const r = command('input.add', args);
                if (!r) continue;
                id = r.id;
            }
            attachFile(id, file.name, text, loaded);
            added = id;
        } catch (e) {
            setStatus(`${file.name}: ${e.message}`, true);
            console.error(e);
            return;
        }
    }
    if (added) saveFiles();
    const rejected = state.rejected.length;
    if (added) setStatus(`Opened ${n - rejected} file(s). Double-click a Gerber or Excellon object to make geometry from it.`);
    else if (rejected) setStatus('No Gerber or Excellon file found; see "Not loaded" in the Project tab.', true);
    state.side = 'project';
    refresh({ fit: true });
    scheduleGeometry();
}

/** Attaches a board file's text to project input `id` (parsing it unless `loaded` is given). */
function attachFile(id, name, text, loaded) {
    loaded = loaded ?? loadFile(name, text);
    if (!loaded.layer) return false;
    state.layers[id] = loaded.layer;
    state.texts[id] = { name, text };
    state.meta[id] = { guess: loaded.guess, visible: true, open: loaded.layer.issues.some((i) => i.severity === 'error') };
    engine.load(id, name, text).catch((e) => console.warn('PCB CAM worker load', e));
    return true;
}

/** Opens a project file or tool library from JSON text; true when a project was opened. */
function importJson(name, text) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { setStatus(`${name}: not valid JSON (${e.message})`, true); return false; }
    if (Array.isArray(doc.tools) && doc.revision !== undefined && !doc.operations) {
        importToolDb(doc, name);
        return false;
    }
    // A project file ({ format, project, boardFiles, jobs }), or a bare project
    // (older exports, optionally with boardFiles).
    const isFile = doc?.format === PROJECT_FORMAT;
    const { boardFiles, ...bare } = doc;
    const project = isFile ? doc.project : bare;
    const issues = validateProject(project).filter((i) => i.severity === 'error');
    if (issues.length) { setStatus(`${name}: not a PCB CAM project (${issues[0].message})`, true); return false; }
    forgetProjectFile();
    clearWorkspace();
    state.project = project;
    saveProject();
    let attached = 0;
    for (const input of project.inputs) {
        const text = boardFiles?.[input.file];
        if (typeof text === 'string' && attachFile(input.id, input.file, text)) attached++;
    }
    if (attached) saveFiles();
    if (isFile && Array.isArray(doc.jobs)) {
        state.jobs = restoreJobs(doc.jobs, (j) => j.result);
        for (const job of state.jobs) if (job.rerun) { delete job.rerun; runJob(job); }
        saveJobs();
    }
    const missing = project.inputs.length - attached;
    setStatus(missing
        ? `Opened project "${project.name}". Now open its board files to attach them (${missing} missing).`
        : `Opened project "${project.name}".`);
    state.side = 'project';
    refresh({ fit: true });
    scheduleGeometry();
    return true;
}

function clearWorkspace() {
    state.layers = {};
    state.texts = {};
    state.meta = {};
    state.rejected = [];
    state.sel = [];
    state.drafts = {};
    state.geo = {};
    state.jobs = [];
    state.selected = null;
    state.pick = null;
    state.code = null;
    if (state.main === 'code') state.main = 'plot';
    engine.clear();
    saveJobs();
    saveFiles();
}

function removeInput(id) {
    const users = state.project.operations.filter((o) => o.input === id);
    if (users.length) {
        setStatus(`${inputOf(id)?.file ?? id} is used by ${users.map(opName).join(', ')}. Delete those geometries first.`, true);
        return false;
    }
    if (!command('input.remove', { id })) return false;
    delete state.layers[id];
    delete state.texts[id];
    delete state.meta[id];
    saveFiles();
    for (const k of Object.keys(state.drafts)) if (k.startsWith(`${id}:`)) delete state.drafts[k];
    dropFromSelection('input', id);
    engine.remove(id);
    refresh();
    return true;
}

function updateInput(id, patch) {
    command('input.update', { id, ...patch });
    refresh();
}

function newProject() {
    forgetProjectFile();
    clearWorkspace();
    state.project = createProject('Board');
    saveProject();
    setStatus(null);
    state.side = 'project';
    refresh({ fit: true });
}

/**
 * Runs `action` (which replaces the open project) once the project is safe: a
 * project saved to a file gets its last changes written there first; one that
 * isn't asks to save or discard. (The plugin iframe can't show confirm().)
 */
function whenProjectSafe(action) {
    const f = state.file;
    if (f && (f.status === 'saved' || f.status === 'dirty' || f.status === 'saving')) {
        if (f.status !== 'saved') writeToDisk(); // captures the project before `action` replaces it
        action();
        return;
    }
    const p = state.project;
    if (!p.inputs.length && !p.operations.length && !state.jobs.length) { action(); return; }
    showDialog({
        title: `Close "${p.name}"?`,
        text: f
            ? `Its latest changes could not be saved to ${f.name}. Closing discards them.`
            : 'This project is not saved to a file. Closing discards it.',
        buttons: [
            ['Save project…', 'primary', async () => { await saveProjectFile({ as: !f }); if (state.file?.status === 'saved') action(); }],
            ['Discard', 'danger', action],
            ['Cancel', '', null],
        ],
    });
}

function closeProject() {
    const name = state.project.name;
    whenProjectSafe(() => { newProject(); setStatus(`Closed "${name}".`); });
}

/** A small modal: { title, text, buttons: [[label, kind, onClick | null]] }. */
function showDialog({ title, text, buttons }) {
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const back = h('div', { className: 'dialog-back', onClick: (e) => { if (e.target === back) close(); } },
        h('div', { className: 'dialog', role: 'dialog' },
            h('h3', {}, title),
            h('p', {}, text),
            h('div', { className: 'row' }, buttons.map(([label, kind, fn]) => h('button', {
                className: `b ${kind}`,
                onClick: () => { close(); fn?.(); },
            }, label)))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    back.querySelector('button')?.focus();
}

function refresh({ fit = false } = {}) {
    state.report = Object.keys(state.layers).length ? inspectBoard(state.layers, state.project) : null;
    render();
    updateScene({ fit });
}

const inputOf = (id) => state.project.inputs.find((i) => i.id === id);

function colorOf(input) {
    if (input.role === 'copper') return COLORS[`copper-${input.side}`] ?? COLORS.copper;
    return COLORS[input.role] ?? COLORS.other;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function importToolDb(doc, name) {
    let db = state.tooldb;
    let n = 0;
    const errors = [];
    for (const t of doc.tools) {
        try { db = setTool(db, t); n++; } catch (e) { errors.push(`${t.name ?? t.id}: ${e.errors?.[0]?.message ?? e.message}`); }
    }
    state.tooldb = db;
    saveToolDb();
    setStatus(`${name}: imported ${n} tool(s)${errors.length ? `; skipped ${errors.length}: ${errors.slice(0, 2).join('; ')}` : ''}`, errors.length > 0);
    render();
}

function saveToolFromForm(tool) {
    try {
        state.tooldb = setTool(state.tooldb, tool);
    } catch (e) {
        state.toolErrors = (e.errors ?? [{ path: '', message: e.message }]).map((x) => `${x.path} ${x.message}`.trim());
        renderSide();
        return;
    }
    saveToolDb();
    // Projects hold snapshots; keep the open project's copy in step with the database.
    if (state.project.tools.some((t) => t.id === tool.id)) command('tool.set', { tool });
    state.editTool = null;
    state.toolErrors = null;
    render();
}

function deleteTool(id) {
    state.tooldb = removeTool(state.tooldb, id);
    saveToolDb();
    render();
}

function addMissingDefaults() {
    let db = state.tooldb;
    for (const t of DEFAULT_TOOLS) {
        if (findTool(db, t.id)) continue;
        const used = new Set(db.tools.map((x) => x.toolNumber));
        let num = t.toolNumber;
        while (used.has(num)) num++;
        db = setTool(db, { ...t, toolNumber: num });
    }
    state.tooldb = db;
    saveToolDb();
    render();
}

function nextToolNumber() {
    const used = new Set(state.tooldb.tools.map((t) => t.toolNumber));
    let n = 1;
    while (used.has(n)) n++;
    return n;
}

function blankTool(type) {
    const base = { id: '', name: '', type, toolNumber: nextToolNumber(), cutting: { feed: 150, plunge: 40, rpm: 24000, stepdown: 0.2 } };
    if (type === 'vbit') return { ...base, tipDiameter: 0.2, angle: 30 };
    return { ...base, diameter: 1 };
}

/** Makes sure the project has a snapshot of `toolId` from the database. */
function ensureProjectTool(toolId) {
    if (state.project.tools.some((t) => t.id === toolId)) return true;
    const t = findTool(state.tooldb, toolId);
    return !!(t && command('tool.set', { tool: t }));
}

/** Drops project tool snapshots that no operation uses. */
function pruneProjectTools() {
    const used = new Set(state.project.operations.map((o) => o.tool));
    for (const t of state.project.tools) if (!used.has(t.id)) command('tool.remove', { id: t.id }, { quiet: true });
}

const toolOf = (id) => state.project.tools.find((t) => t.id === id) ?? findTool(state.tooldb, id);

function toolSummary(t) {
    if (!t) return '?';
    const geo = t.type === 'vbit' ? `${t.angle}° ${t.tipDiameter} mm` : `Ø${t.diameter} mm`;
    return `T${t.toolNumber} ${TOOL_LABEL[t.type]} ${geo}`;
}

// ---------------------------------------------------------------------------
// Geometry objects (one project operation each)
// ---------------------------------------------------------------------------

const opOf = (id) => state.project.operations.find((o) => o.id === id);
const opColor = (id) => OP_COLORS[Math.max(0, state.project.operations.findIndex((o) => o.id === id)) % OP_COLORS.length];

function opName(op) {
    if (op.name) return op.name;
    const input = inputOf(op.input);
    return `${input ? fileBase(input.file) : op.input}_${OP_SUFFIX[op.type]}`;
}

function uniqueName(base) {
    const used = new Set(state.project.operations.map(opName));
    if (!used.has(base)) return base;
    for (let n = 1; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

const draftKey = (inputId, type) => `${inputId}:${type}`;

/** Settings for the geometry `type` would create from `inputId` (FlatCAM's object form). */
function getDraft(inputId, type) {
    const key = draftKey(inputId, type);
    if (!state.drafts[key]) {
        const prefer = type === 'isolation' ? 'vbit-30-0.2' : type === 'clearing' ? 'em-2.0' : 'em-0.8';
        state.drafts[key] = { ...operationDefaults(type), tool: pickTool(state.tooldb.tools, type, prefer)?.id ?? '', region: null };
    }
    return state.drafts[key];
}

function createGeometry(inputId, type) {
    const input = inputOf(inputId);
    const d = getDraft(inputId, type);
    if (!d.tool || !toolOf(d.tool)) { setStatus(`Choose a tool for ${OP_LABEL[type].toLowerCase()} (add one in the Tool tab).`, true); return; }
    if (!ensureProjectTool(d.tool)) return;
    const id = uniqueId(state.project.operations, `${OP_SUFFIX[type]}-${input.side ?? input.id}`);
    const op = { ...structuredClone(d), id, input: inputId, enabled: true, name: uniqueName(`${fileBase(input.file)}_${OP_SUFFIX[type]}`) };
    for (const [k, v] of Object.entries(op)) if (v === undefined || (k === 'region' && v === null)) delete op[k];
    if (!command('operation.set', { operation: op })) return;
    setStatus(`Created geometry ${op.name}. Check it on the plot, then Generate CNCJob.`);
    selectObj('geo', id, { show: true });
}

function updateOperation(id, patch) {
    const op = opOf(id);
    if (!op) return;
    const next = { ...structuredClone(op), ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    if (patch.tool && !ensureProjectTool(patch.tool)) return;
    if (!command('operation.set', { operation: next })) { renderSide(); return; }
    if (patch.tool) pruneProjectTools();
    render();
    updateScene();
}

function removeOperation(id) {
    const op = opOf(id);
    const wasStale = new Set(state.jobs.filter(jobStale).map((j) => j.id)); // before the project changes
    if (!command('operation.remove', { id })) return false;
    pruneProjectTools();
    delete state.geo[id];
    // Like FlatCAM, a CNC job is its own object: one with G-code keeps it, frozen
    // (it can't be regenerated without the geometry). Jobs without G-code just
    // lose the geometry, and go when none is left.
    for (const j of state.jobs.filter((x) => x.ops.includes(id))) {
        if (j.result?.ok) {
            j.frozen = {
                geometries: j.ops.map((o) => (o === id ? op : opOf(o))).filter(Boolean).map((o) => ({ name: opName(o), tool: toolSummary(toolOf(o.tool)) })),
                deleted: [opName(op)],
                stale: wasStale.has(j.id),
            };
            j.ops = [];
        } else {
            j.ops = j.ops.filter((o) => o !== id);
        }
    }
    for (const j of state.jobs.filter((x) => !x.frozen && !x.ops.length)) removeJob(j.id);
    dropFromSelection('geo', id);
    saveJobs();
    return true;
}

function setupStandardJob() {
    if (!state.project.inputs.length) { setStatus('Open the board files first (File → Open).', true); return; }
    const cmds = standardJob(state.project, state.tooldb.tools);
    if (!cmds.length) { setStatus('Nothing to add: every file already has its geometry.'); return; }
    const before = new Set(state.project.operations.map((o) => o.id));
    for (const c of cmds) if (!command(c.name, c.args)) return;
    // Two tools and gSender ignoring M6: one file per tool is the safe default.
    const tools = new Set(state.project.operations.map((o) => o.tool));
    if (tools.size > 1 && state.toolChangeOption === 'Ignore' && state.project.output.toolChange === 'm6') {
        command('output.update', { toolChange: 'split' });
    }
    const made = state.project.operations.filter((o) => !before.has(o.id));
    state.sel = made.map((o) => ({ kind: 'geo', id: o.id }));
    state.side = 'selected';
    setStatus(`Created ${made.length} geometries (isolation, drilling, cutout). Check depths and tools, then Generate CNCJob.`);
    render();
    updateScene();
}

// Preview geometry: each operation is generated on its own (in the worker) as
// soon as it or anything it depends on changes.

/** The project as the engine should see it: only loaded inputs and the operations that use them. */
function runnable(p) {
    const loaded = (id) => !!state.layers[id] && !state.layers[id].issues.some((i) => i.severity === 'error');
    const operations = p.operations.filter((o) => loaded(o.input)).map((o) => (o.enabled ? o : { ...o, enabled: true }));
    const used = new Set(operations.map((o) => o.input));
    const inputs = p.inputs.filter((i) => loaded(i.id) && (used.has(i.id) || i.role === 'outline'));
    return { ...p, inputs, operations };
}

function geoKey(op) {
    const p = state.project;
    return JSON.stringify([
        op, p.tools.find((t) => t.id === op.tool), p.setup, p.regions,
        p.operations.map((o) => [o.id, o.type, o.input, o.region ?? null, o.face ?? null]),
        p.inputs.filter((i) => state.layers[i.id]),
    ]);
}

let geoRunning = false;
let geoAgain = false;
const scheduleGeometry = debounce(() => refreshGeometries(), 150);

async function refreshGeometries() {
    if (geoRunning) { geoAgain = true; return; }
    geoRunning = true;
    try {
        do {
            geoAgain = false;
            for (const id of Object.keys(state.geo)) if (!opOf(id)) delete state.geo[id];
            for (const op of state.project.operations) {
                if (!state.layers[op.input]) continue;
                const key = geoKey(op);
                const g = state.geo[op.id];
                if (g && g.key === key && !g.busy) continue;
                state.geo[op.id] = { ...(g ?? {}), key, busy: true };
                renderSide();
                const idx = state.project.operations.indexOf(op);
                try {
                    const { result, analysis } = await engine.generate(runnable(state.project), state.toolChangeOption, { only: [op.id] });
                    if (state.geo[op.id]?.key !== key) continue; // changed while generating
                    const mine = (x) => x.opId === op.id || x.path?.startsWith(`/operations/${idx}`) || (!x.opId && x.severity === 'error');
                    state.geo[op.id] = { key, ok: result.ok, op: result.operations?.[0] ?? null, transform: result.transform, issues: result.issues.filter(mine), analysis, busy: false };
                } catch (e) {
                    console.error(e);
                    state.geo[op.id] = { key, ok: false, op: null, issues: [{ severity: 'error', code: 'failed', message: `Geometry failed: ${e.message}` }], analysis: [], busy: false };
                }
            }
        } while (geoAgain);
    } finally {
        geoRunning = false;
    }
    render();
    updateScene();
}

/**
 * "Use a finer bit there": polygon regions around the gaps `opId`'s tool can't
 * cut, each isolated by a finer V-bit in a new geometry; the original geometry
 * then covers everything else.
 */
async function useFinerBit(opId, minGap) {
    const p = state.project;
    const op = opOf(opId);
    const tool = op && toolOf(op.tool);
    if (!op || !tool) return;
    const target = minGap ? minGap * 0.9 : widthAtDepth(tool, op.depth) * 0.7;
    const finer = state.tooldb.tools
        .filter((t) => OP_TOOL_TYPES.isolation.includes(t.type) && t.id !== tool.id && widthAtDepth(t, op.depth) < Math.min(target, widthAtDepth(tool, op.depth)))
        .sort((a, b) => widthAtDepth(b, op.depth) - widthAtDepth(a, op.depth))[0];
    if (!finer) { setStatus(`No tool in the library cuts narrower than ${fmt(target, 3)} mm at ${op.depth} mm deep. Add a finer V-bit in the Tool tab.`, true); return; }
    if (op.region != null) { setStatus(`${opName(op)} already uses an area; set up the fine-pitch area by hand.`, true); return; }
    let regions;
    try {
        regions = await engine.suggest(op.input, tool, op.depth, 1);
    } catch (e) { setStatus(`Could not find the gaps: ${e.message}`, true); return; }
    if (!regions.length) { setStatus('No narrow gaps found any more.'); return; }
    if (!ensureProjectTool(finer.id)) return;
    let index = p.operations.findIndex((o) => o.id === opId);
    const made = [];
    for (const r of regions) {
        const rid = uniqueId(state.project.regions, 'fine');
        if (!command('region.set', { id: rid, name: `Fine pitch (${r.gaps} gaps)`, shape: { kind: 'polygon', points: r.points } })) return;
        const fid = uniqueId(state.project.operations, `${opId}-fine`);
        const name = uniqueName(`${opName(op)}_fine`);
        if (!command('operation.set', { operation: { ...structuredClone(op), id: fid, name, tool: finer.id, region: rid } })) return;
        command('operation.move', { id: fid, index: ++index });
        made.push(fid);
    }
    let rest = state.project.regions.find((r) => r.shape.kind === 'remainder');
    if (!rest) {
        rest = { id: uniqueId(state.project.regions, 'rest'), name: 'Everything else', shape: { kind: 'remainder' } };
        if (!command('region.set', rest)) return;
    }
    command('operation.set', { operation: { ...structuredClone(opOf(opId)), region: rest.id } });
    // CNC jobs that cut the original also need the fine-pitch geometry.
    for (const j of state.jobs) if (j.ops.includes(opId)) j.ops = state.project.operations.map((o) => o.id).filter((id) => j.ops.includes(id) || made.includes(id));
    saveJobs();
    // Both halves belong in the CNC job, so leave them selected together.
    state.sel = [{ kind: 'geo', id: opId }, ...made.map((id) => ({ kind: 'geo', id }))];
    setStatus(`Added ${made.map((id) => opName(opOf(id))).join(', ')} using ${finer.name}; ${opName(op)} now cuts everything else. Generate one CNC job from both.`);
    render();
    updateScene();
}

// ---------------------------------------------------------------------------
// Regions (areas a geometry is limited to)
// ---------------------------------------------------------------------------

// A target is { op: id } for a geometry or { draft: key } for a form.
function setTargetRegion(target, regionId) {
    if (target.op) { updateOperation(target.op, { region: regionId }); return; }
    const d = state.drafts[target.draft];
    if (d) d.region = regionId;
    render();
    updateScene();
}

function addRegionFor(target, region) {
    if (!command('region.set', region)) return;
    setTargetRegion(target, region.id);
}

function startDrawRegion(target) {
    state.drawing = { target };
    state.main = 'plot';
    view.setMode('rect');
    renderMain();
    setStatus('Drag a rectangle on the plot to limit the geometry to it. Esc cancels.');
}

function finishDrawRegion(rect) {
    const d = state.drawing;
    state.drawing = null;
    view.setMode('pan');
    if (!d) return;
    setStatus(null);
    addRegionFor(d.target, { id: uniqueId(state.project.regions, 'area'), name: 'Rectangle', shape: { kind: 'rect', rect } });
}

function cancelDraw() {
    if (!state.drawing) return;
    state.drawing = null;
    view.setMode('pan');
    setStatus(null);
}

function removeRegion(id) {
    if (!command('region.remove', { id })) return;
    for (const d of Object.values(state.drafts)) if (d.region === id) d.region = null;
    render();
    updateScene();
}

function regionLabel(r) {
    const s = r.shape;
    if (s.kind === 'rect') return `${r.name ?? 'Rectangle'} (${s.rect.map((v) => fmt(v, 1)).join(', ')})`;
    if (s.kind === 'component') return `Component ${s.ref} +${s.margin ?? 0.5} mm`;
    if (s.kind === 'net') return `Net ${s.net} +${s.margin ?? 0.5} mm`;
    if (s.kind === 'polygon') return r.name ?? 'Polygon';
    return 'Everything else (remainder)';
}

// ---------------------------------------------------------------------------
// CNC jobs
// ---------------------------------------------------------------------------

const jobOf = (id) => state.jobs.find((j) => j.id === id);
const jobKey = (job) => JSON.stringify([job.ops.map((id) => (opOf(id) ? geoKey(opOf(id)) : id)), state.project.output, job.name]);
const jobStale = (job) => !job.frozen && !!job.result && job.key !== jobKey(job);

function createJob(opIds) {
    const order = state.project.operations.map((o) => o.id);
    const ops = order.filter((id) => opIds.includes(id));
    if (!ops.length) { setStatus('Select one or more geometries first.', true); return; }
    const missing = ops.map(opOf).filter((o) => !state.layers[o.input]);
    if (missing.length) { setStatus(`Open ${[...new Set(missing.map((o) => inputOf(o.input)?.file))].join(', ')} first.`, true); return; }
    const base = ops.length === 1 ? opName(opOf(ops[0])) : state.project.name;
    const used = new Set(state.jobs.map((j) => j.name));
    let name = `${base}_cnc`;
    for (let n = 1; used.has(name); n++) name = `${base}_cnc_${n}`;
    const job = { id: uniqueId(state.jobs, name), name, ops };
    state.jobs.push(job);
    saveJobs();
    selectObj('job', job.id, { show: true });
    runJob(job);
}

async function runJob(job) {
    if (job.busy || job.frozen) return;
    const missing = job.ops.map(opOf).filter((o) => o && !state.layers[o.input]);
    if (missing.length) { setStatus(`Open ${[...new Set(missing.map((o) => inputOf(o.input)?.file))].join(', ')} first.`, true); return; }
    job.busy = true;
    render();
    const key = jobKey(job);
    try {
        try { state.toolChangeOption = (await getWorkspaceState())?.toolChangeOption ?? state.toolChangeOption; } catch { /* keep */ }
        const t0 = performance.now();
        // G-code files are named after the project; use the job's name.
        const { result } = await engine.generate(runnable({ ...state.project, name: job.name }), state.toolChangeOption, { only: job.ops, analyze: false });
        job.result = result;
        job.key = key;
        saveJobs();
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        if (result.ok && result.files?.some((f) => f.name === state.loaded)) state.loaded = null; // regenerated: not what gSender has
        setStatus(result.ok ? `${job.name}: G-code ready in ${secs} s.` : `${job.name}: could not generate; see its problems.`, !result.ok);
    } catch (e) {
        console.error(e);
        setStatus(`${job.name}: generation failed: ${e.message}`, true);
    } finally {
        job.busy = false;
        render();
        updateScene();
    }
}

function removeJob(id) {
    state.jobs = state.jobs.filter((j) => j.id !== id);
    dropFromSelection('job', id);
    if (state.code?.job === id) { state.code = null; if (state.main === 'code') state.main = 'plot'; }
    saveJobs();
}

const toastEl = h('div', { className: 'toast', role: 'status' });
let toastTimer = null;
/** Short-lived notice over the plot area, for results that need to be seen. */
function toast(text, kind = 'ok') {
    clearTimeout(toastTimer);
    toastEl.className = `toast show ${kind}`;
    toastEl.textContent = text;
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, kind === 'err' ? 8000 : 5000);
}

async function loadIntoGsender(file) {
    if (state.loading) return;
    state.loading = file.name;
    toast(`Loading ${file.name} into gSender…`, 'busy');
    render();
    try {
        await gcode.loadToVisualizer(file.gcode, file.name);
        state.loaded = file.name;
        toast(`✓ ${file.name} loaded into gSender`);
        setStatus(`Loaded ${file.name} into gSender. Check the visualizer, zero X/Y/Z on the board, and air-cut first if unsure.`);
    } catch (e) {
        toast(`Could not load into gSender: ${e.message}`, 'err');
        setStatus(`Could not load into gSender: ${e.message}`, true);
    } finally {
        state.loading = null;
        render();
    }
}

/** "Load into gSender" button showing progress and the file last loaded. */
function loadButton(file, { disabled = false, title = '' } = {}) {
    const busy = state.loading === file.name;
    const done = !busy && state.loaded === file.name;
    return h('button', {
        className: `b primary small${done ? ' done' : ''}`,
        disabled: disabled || !!state.loading,
        title: title || (done ? 'Loaded; click to load it again' : ''),
        onClick: () => loadIntoGsender(file),
    }, busy ? 'Loading…' : done ? '✓ Loaded' : 'Load into gSender');
}

function showCode(job, file) {
    state.code = { job: job.id, file: file.name, text: file.gcode };
    state.main = 'code';
    renderMain();
}

/** Problems grouped so dozens of identical gap warnings read as one line. */
function groupIssues(issues) {
    const groups = [];
    const byKey = new Map();
    issues.forEach((x, i) => {
        const groupable = x.code === 'tool-too-wide' || x.code === 'not-isolated';
        const key = groupable ? `${x.code}|${x.opId ?? x.input}` : `#${i}`;
        let g = byKey.get(key);
        if (!g) { g = { key, code: x.code, severity: x.severity, opId: x.opId, input: x.input, items: [] }; byKey.set(key, g); groups.push(g); }
        g.items.push({ ...x, index: i });
        if (x.severity === 'error') g.severity = 'error';
    });
    return groups;
}

function groupTitle(g) {
    if (g.items.length === 1) return g.items[0].message;
    const op = opOf(g.opId);
    const who = op ? opName(op) : inputOf(g.input)?.file ?? g.input;
    if (g.code === 'tool-too-wide') {
        const gaps = g.items.map((x) => x.gap).filter((v) => v !== null && v !== undefined);
        return `${who}: ${g.items.length} gaps${gaps.length ? ` (down to ${fmt(Math.min(...gaps), 3)} mm)` : ''} are narrower than the ${fmt(g.items[0].width, 3)} mm cut, so copper stays connected there.`;
    }
    return `${who}: ${g.items.length} copper edges are outside every isolation geometry.`;
}

function showExport(title, obj) {
    state.exportText = { title, text: JSON.stringify(obj, null, 2) };
    state.side = 'project';
    renderSide();
}

async function copyText(text, el) {
    try {
        await navigator.clipboard.writeText(text);
        setStatus('Copied to the clipboard.');
    } catch {
        el?.select();
        setStatus('Text selected; press Cmd/Ctrl+C to copy.');
    }
}

// ---------------------------------------------------------------------------
// Layout: header (menu bar + toolbar), side panel, plot area, status bar
// ---------------------------------------------------------------------------

const header = h('div', { className: 'header' });
const side = h('div', { className: 'side' });
const main = h('div', { className: 'main' });
const statusBar = h('div', { className: 'statusbar' });
const statusText = h('span', { className: 'msg' });
const coords = h('span', { className: 'coords' }, '');
statusBar.append(statusText, coords);
const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none', onChange: (e) => { openFiles(e.target.files); e.target.value = ''; } });
const openPicker = (accept = '') => { fileInput.accept = accept; fileInput.click(); };
const GERBER_EXT = '.gbr,.ger,.gtl,.gbl,.gto,.gbo,.gts,.gbs,.gtp,.gbp,.gm1,.gko,.gml,.gm,.pho,.art,.cmp,.sol,.g1,.g2';
const EXCELLON_EXT = '.drl,.xln,.txt,.nc,.tap,.exc,.drd';

function render() {
    saveUi();
    renderHeader();
    renderSide();
    renderMain();
    renderStatus();
}

function renderStatus() {
    statusText.textContent = state.status?.text ?? 'Ready';
    statusText.className = `msg${state.status?.err ? ' err' : ''}`;
}

// --- Header -----------------------------------------------------------------

function menuItems(id) {
    const geos = state.sel.filter((s) => s.kind === 'geo').map((s) => s.id);
    switch (id) {
        case 'file': return [
            ['New project', () => whenProjectSafe(newProject)],
            ['Open project…', () => whenProjectSafe(openProjectFile)],
            ['Save project  (⌘S)', () => saveProjectFile()],
            ['Save project as…', () => saveProjectFile({ as: true })],
            ['Close project', closeProject, !state.project.inputs.length && !state.project.operations.length && !state.jobs.length && !state.file],
            null,
            ['Open Gerber…', () => openPicker(GERBER_EXT)],
            ['Open Excellon…', () => openPicker(EXCELLON_EXT)],
            ['Open all board files…', () => openPicker('')],
            ['Open tool library (.json)…', () => openPicker('.json,application/json')],
            null,
            ['Export project JSON (copy)', () => showExport('Project JSON', projectDoc())],
            ['Export tool library JSON', () => showExport('Tool library JSON', state.tooldb)],
        ];
        case 'edit': return [
            ['Delete selected  (Del)', deleteSelected, !state.sel.length],
            ['Select all geometries', () => { state.sel = state.project.operations.map((o) => ({ kind: 'geo', id: o.id })); render(); updateScene(); }, !state.project.operations.length],
            ['Clear selection', () => { state.sel = []; render(); updateScene(); }, !state.sel.length],
            null,
            ['Preferences', () => { state.main = 'prefs'; renderMain(); }],
        ];
        case 'view': return [
            ['Fit  (V)', () => view.fit()],
            ['Zoom in  (=)', () => view.zoom(0.8)],
            ['Zoom out  (−)', () => view.zoom(1.25)],
            null,
            ['Show all objects', () => setAllVisible(true)],
            ['Hide all objects', () => setAllVisible(false)],
        ];
        case 'tools': return [
            ['Standard job (all geometries)', setupStandardJob, !state.project.inputs.length],
            ['Generate CNCJob from selected geometries', () => createJob(geos), !geos.length],
            ['Generate CNCJob from all geometries', () => createJob(state.project.operations.map((o) => o.id)), !state.project.operations.length],
            null,
            ['Tool library', () => { state.side = 'tool'; renderSide(); renderHeader(); }],
        ];
        default: return [];
    }
}

function setAllVisible(v) {
    for (const id of Object.keys(state.meta)) state.meta[id].visible = v;
    for (const o of state.project.operations) state.hidden[`geo:${o.id}`] = !v;
    for (const j of state.jobs) state.hidden[`job:${j.id}`] = !v;
    renderSide();
    updateScene();
}

// Where the project is saved, next to its name in the header.
const fileState = h('span', { className: 'filestate' });
function renderFileState() {
    const f = state.file;
    const [text, cls, title] = !f
        ? ['Not saved to a file', 'warn', 'Kept until gSender quits. File → Save project keeps it in a file.']
        : f.status === 'saved' ? [`Saved · ${f.name}`, '', 'Changes are saved to this file automatically.']
            : f.status === 'dirty' || f.status === 'saving' ? [`Saving · ${f.name}`, '', '']
                : f.status === 'paused' ? [`Not saving · ${f.name}`, 'warn', 'gSender needs your OK to write this file again: File → Save project.']
                    : [`Save failed · ${f.name}`, 'err', f.error ?? ''];
    fileState.textContent = text;
    fileState.className = `filestate ${cls}`;
    fileState.title = title;
    fileState.onclick = f && f.status === 'saved' ? null : () => saveProjectFile();
}

function renderHeader() {
    renderFileState();
    const menus = [['file', 'File'], ['edit', 'Edit'], ['view', 'View'], ['tools', 'Tools']];
    const geos = state.sel.filter((s) => s.kind === 'geo').map((s) => s.id);
    const tb = (label, title, onClick, disabled) => h('button', { className: 'tb', title, disabled, onClick }, label);
    header.replaceChildren(
        h('div', { className: 'menubar' },
            menus.map(([id, label]) => h('div', { className: 'menu' },
                h('button', {
                    className: state.menu === id ? 'open' : '',
                    onClick: (e) => { e.stopPropagation(); state.menu = state.menu === id ? null : id; renderHeader(); },
                    onMouseEnter: () => { if (state.menu && state.menu !== id) { state.menu = id; renderHeader(); } },
                }, label),
                state.menu === id ? h('div', { className: 'dropdown' }, menuItems(id).map((it) => (it
                    ? h('button', { disabled: it[2], onClick: (e) => { e.stopPropagation(); state.menu = null; renderHeader(); it[1](); } }, it[0])
                    : h('hr')))) : null)),
            h('span', { className: 'spacer' }),
            fileState,
            h('input', {
                className: 'pname', value: state.project.name, title: 'Project name',
                onChange: (e) => { if (e.target.value.trim()) command('project.rename', { name: e.target.value.trim() }); render(); },
            }),
        ),
        h('div', { className: 'toolbar' },
            tb('Open Gerber', 'Open Gerber files', () => openPicker(GERBER_EXT)),
            tb('Open Excellon', 'Open drill files', () => openPicker(EXCELLON_EXT)),
            h('span', { className: 'sep' }),
            tb('Fit', 'Zoom to fit (V)', () => view.fit()),
            tb('＋', 'Zoom in (=)', () => view.zoom(0.8)),
            tb('－', 'Zoom out (−)', () => view.zoom(1.25)),
            h('span', { className: 'sep' }),
            tb('Delete', 'Delete the selected objects (Del)', deleteSelected, !state.sel.length),
            h('span', { className: 'sep' }),
            tb('Standard job', 'Isolation geometry for each copper layer, drilling and cutout', setupStandardJob, !state.project.inputs.length),
            tb('Generate CNCJob', 'G-code from the selected geometries', () => createJob(geos), !geos.length),
        ),
    );
}

// --- Side panel -------------------------------------------------------------

function renderSide() {
    const scrollTop = side.querySelector('.body')?.scrollTop ?? 0;
    const tabs = [['project', 'Project'], ['selected', 'Selected'], ['tool', 'Tool']];
    const body = h('div', { className: 'body' },
        state.exportText ? renderExport() : null,
        ...(state.side === 'project' ? tabProject() : state.side === 'selected' ? tabSelected() : tabTools()),
    );
    side.replaceChildren(
        h('div', { className: 'tabs' }, tabs.map(([id, label]) => h('button', {
            className: state.side === id ? 'active' : '',
            onClick: () => { state.side = id; state.regionPicker = null; renderSide(); updateScene(); },
        }, label))),
        body, fileInput,
    );
    body.scrollTop = scrollTop;
}

function renderExport() {
    const ta = h('textarea', { className: 'json', readOnly: true, value: state.exportText.text });
    return h('div', { className: 'section card' },
        h('h4', {}, state.exportText.title, h('button', { className: 'link', onClick: () => { state.exportText = null; renderSide(); } }, 'close')),
        ta,
        h('div', { className: 'row' }, h('button', { className: 'b', onClick: () => copyText(state.exportText.text, ta) }, 'Copy')),
        h('div', { className: 'note' }, 'Paste it into a text file to keep it (e.g. board.pcbcam.json). File → Open project loads it back.'),
    );
}

const collapsed = (key, dflt = true) => !(state.open[key] ?? dflt);

function section(key, title, content, { open: dflt = true, extra } = {}) {
    const open = !collapsed(key, dflt);
    return h('div', { className: `section fold${open ? ' open' : ''}` },
        h('h4', { className: 'foldhead', onClick: () => { state.open[key] = !open; renderSide(); updateScene(); } }, h('span', {}, `${open ? '▾' : '▸'} ${title}`), extra ?? null),
        open ? content : null);
}

// --- Project tab ------------------------------------------------------------

function tabProject() {
    const p = state.project;
    const gerbers = p.inputs.filter((i) => i.role !== 'drill');
    const drills = p.inputs.filter((i) => i.role === 'drill');
    const item = (kind, id, { label, info, color, visible, onVisible, missing }) => h('div', {
        className: `ti${isSel(kind, id) ? ' sel' : ''}${missing ? ' missing' : ''}`,
        title: 'Click to select (Cmd/Ctrl-click adds), double-click to edit',
        onClick: (e) => selectObj(kind, id, { add: e.metaKey || e.ctrlKey || e.shiftKey }),
        onDblClick: () => { state.side = 'selected'; renderSide(); updateScene(); },
    },
    // Its own hit area: clicks here (quick repeated toggles included) must not
    // select the object or open it in the Selected tab.
    h('label', { className: 'vis', onClick: (e) => e.stopPropagation(), onDblClick: (e) => e.stopPropagation() },
        h('input', { type: 'checkbox', checked: visible, disabled: missing, title: 'Show on the plot', onChange: (e) => { onVisible(e.target.checked); saveUi(); } })),
    h('span', { className: 'swatch', style: `background:${color}` }),
    h('span', { className: 'name' }, label),
    info ? h('span', { className: 'info' }, info) : null);
    const group = (key, title, items) => {
        const open = !collapsed(`g:${key}`);
        return h('div', { className: 'tgroup' },
            h('div', { className: 'thead', onClick: () => { state.open[`g:${key}`] = !open; renderSide(); } }, `${open ? '▾' : '▸'} ${title}`, h('span', { className: 'count' }, items.length)),
            open ? items : null);
    };
    const inputItem = (i) => {
        const layer = state.layers[i.id];
        return item('input', i.id, {
            label: i.file,
            info: !layer ? 'not open' : i.role === 'copper' ? `copper ${i.side}` : i.role,
            color: colorOf(i), visible: !!state.meta[i.id]?.visible, missing: !layer,
            onVisible: (v) => { state.meta[i.id].visible = v; updateScene(); },
        });
    };
    const geoItem = (op) => {
        const g = state.geo[op.id];
        const t = toolOf(op.tool);
        return item('geo', op.id, {
            label: opName(op),
            info: g?.busy ? '…' : g && !g.ok ? 'error' : `${OP_LABEL[op.type].toLowerCase()} · T${t?.toolNumber ?? '?'}`,
            color: opColor(op.id), visible: !state.hidden[`geo:${op.id}`], missing: !state.layers[op.input],
            onVisible: (v) => { state.hidden[`geo:${op.id}`] = !v; updateScene(); },
        });
    };
    const jobItem = (j) => item('job', j.id, {
        label: j.name,
        info: j.busy ? '…' : j.frozen && !j.result ? 'G-code lost' : !j.result ? 'not generated' : j.frozen ? `${j.result.files.length} file${j.result.files.length > 1 ? 's' : ''} · kept` : !j.result.ok ? 'error' : jobStale(j) ? 'out of date' : `${j.result.files.length} file${j.result.files.length > 1 ? 's' : ''}`,
        color: '#ffffff', visible: !state.hidden[`job:${j.id}`],
        onVisible: (v) => { state.hidden[`job:${j.id}`] = !v; updateScene(); },
    });
    const empty = !p.inputs.length;
    return [
        empty ? h('div', { className: 'section card' },
            h('b', {}, 'Workflow'),
            h('ol', { className: 'steps' },
                h('li', {}, 'Open the board\'s Gerber and Excellon files.'),
                h('li', {}, 'Double-click a Gerber or Excellon object and generate geometry (isolation, cutout, drilling), or use Standard job.'),
                h('li', {}, 'Double-click a geometry, check tool and depth, Generate CNCJob.'),
                h('li', {}, 'Load the CNC job\'s G-code into gSender.')),
            h('div', { className: 'row' },
                h('button', { className: 'b primary', onClick: () => openPicker('') }, 'Open board files…')),
            h('div', { className: 'note' }, 'Select all of a board\'s files at once, or drop them on the plot. A saved project (.json) opens the same way.'),
        ) : null,
        h('div', { className: 'tree' },
            group('gerber', 'Gerber', gerbers.map(inputItem)),
            group('excellon', 'Excellon', drills.map(inputItem)),
            group('geometry', 'Geometry', p.operations.map(geoItem)),
            group('cnc', 'CNC Job', state.jobs.map(jobItem))),
        !empty ? h('div', { className: 'note' }, 'Double-click an object to edit it in the Selected tab. Cmd/Ctrl-click selects several.') : null,
        state.rejected.length ? h('div', { className: 'section' },
            h('h4', {}, 'Not loaded', h('button', { className: 'link', onClick: () => { state.rejected = []; renderSide(); } }, 'clear')),
            state.rejected.map((r) => h('div', { className: 'note' }, `${r.name}: ${r.reason ?? 'not a Gerber or Excellon file'}`)),
        ) : null,
        state.report?.board ? h('div', { className: 'section' },
            h('h4', {}, 'Board'),
            h('div', { className: 'kv' },
                h('span', {}, 'Size'), h('span', {}, `${fmt(state.report.board.width)} × ${fmt(state.report.board.height)} mm (from ${state.report.board.from})`),
                h('span', {}, 'Components'), h('span', {}, state.report.components.length),
                h('span', {}, 'Nets'), h('span', {}, `${state.report.nets.named.length} named`))) : null,
    ];
}

// --- Selected tab -----------------------------------------------------------

function tabSelected() {
    const s = primary();
    if (!s) return [h('div', { className: 'note pad' }, 'Nothing selected. Click an object in the Project tab (double-click opens it here).')];
    const geos = state.sel.filter((x) => x.kind === 'geo');
    if (geos.length > 1) return selectedGeometries(geos.map((x) => x.id));
    if (s.kind === 'input') {
        const input = inputOf(s.id);
        if (!input) return [];
        return input.role === 'drill' ? selectedExcellon(input) : selectedGerber(input);
    }
    if (s.kind === 'geo') return opOf(s.id) ? selectedGeometry(opOf(s.id)) : [];
    return jobOf(s.id) ? selectedJob(jobOf(s.id)) : [];
}

function objHeader(kind, name, color) {
    return h('div', { className: 'objhead' }, h('span', { className: 'swatch', style: `background:${color}` }), h('span', { className: 'kind' }, kind), h('span', { className: 'oname' }, name));
}

/** Field label text with its icon; hovering the icon shows it large with `cap`. */
const lab = (text, ic, cap) => (ic ? h('span', { className: 'lt' }, icon(ic, cap ?? ''), text) : text);
const sel = (label, value, options, onChange, tip, ic) => h('label', { className: 'f', title: tip ?? '' }, lab(label, ic, tip),
    h('select', { onChange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));

function fileInfo(input) {
    const layer = state.layers[input.id];
    const meta = state.meta[input.id];
    if (!layer) {
        return h('div', { className: 'section card' },
            h('div', {}, h('span', { className: 'badge warn' }, 'file not open'), ` Open ${input.file} to attach it to this project.`),
            h('div', { className: 'row' }, h('button', { className: 'b small', onClick: () => openPicker('') }, 'Open…')));
    }
    const errors = layer.issues.filter((i) => i.severity === 'error').length;
    const warnings = layer.issues.length - errors;
    const counts = layer.format === 'gerber'
        ? `${layer.objects.length} objects`
        : `${Object.keys(layer.tools).length} tools, ${layer.holes.length} holes, ${layer.slots.length} slots`;
    return h('div', { className: 'section' },
        h('div', { className: 'meta' },
            h('span', {}, `${layer.format} · ${counts}`),
            h('span', { className: 'badge', title: meta.guess.reason }, `detected via ${meta.guess.source}`),
            errors ? h('span', { className: 'badge err' }, `${errors} error${errors > 1 ? 's' : ''}`) : null,
            warnings ? h('span', { className: 'badge warn' }, `${warnings} warning${warnings > 1 ? 's' : ''}`) : null,
            layer.issues.length ? h('button', { className: 'link', onClick: () => { meta.open = !meta.open; renderSide(); } }, meta.open ? 'hide' : 'show') : null),
        meta.open && layer.issues.length ? h('ul', { className: 'issues' },
            layer.issues.slice(0, 50).map((i) => h('li', { className: i.severity }, `${i.line ? `line ${i.line}: ` : ''}${i.message} [${i.code}]`)),
            layer.issues.length > 50 ? h('li', {}, `… ${layer.issues.length - 50} more`) : null) : null);
}

function derivedList(input) {
    const ops = state.project.operations.filter((o) => o.input === input.id);
    if (!ops.length) return null;
    return h('div', { className: 'section' },
        h('h4', {}, 'Geometry from this file'),
        ops.map((o) => h('div', { className: 'link-row', onClick: () => selectObj('geo', o.id, { show: true }) },
            h('span', { className: 'swatch', style: `background:${opColor(o.id)}` }), opName(o), h('span', { className: 'muted' }, ` · ${toolSummary(toolOf(o.tool))}`))));
}

function selectedGerber(input) {
    const layer = state.layers[input.id];
    const roleSel = sel('Layer', input.role, ROLES.filter((r) => r !== 'drill').map((r) => [r, r]), (v) => updateInput(input.id, { role: v, side: v === 'copper' ? input.side ?? 'top' : v === 'other' ? input.side : null }));
    const sideSel = input.role === 'copper' || input.role === 'other'
        ? sel('Side', input.side ?? '', SIDES.filter((v) => input.role !== 'copper' || v).map((v) => [v ?? '', v ?? '—']), (v) => updateInput(input.id, { side: v || null }))
        : null;
    const out = [
        objHeader('Gerber Object', input.file, colorOf(input)),
        h('div', { className: 'section grid2' }, roleSel, sideSel),
        fileInfo(input),
    ];
    if (layer && input.role === 'copper') {
        out.push(geometryForm(input, 'isolation', 'Isolation Routing', 'Generate Isolation Geometry', true));
        out.push(geometryForm(input, 'clearing', 'Non-copper Clearing', 'Generate Clearing Geometry', false));
        if (state.report?.components.length) out.push(componentsSection());
    } else if (layer && input.role === 'outline') {
        out.push(geometryForm(input, 'cutout', 'Board Cutout', 'Generate Cutout Geometry', true));
    } else if (layer) {
        out.push(h('div', { className: 'note' }, 'Set Layer to copper (isolation, clearing) or outline (board cutout) to make geometry from this file.'));
    }
    out.push(derivedList(input));
    return out;
}

function selectedExcellon(input) {
    const layer = state.layers[input.id];
    const plated = sel('Plating', input.plated == null ? '' : input.plated ? 'pth' : 'npth', [['', 'unknown'], ['pth', 'plated'], ['npth', 'non-plated']],
        (v) => updateInput(input.id, { plated: v === '' ? null : v === 'pth' }));
    return [
        objHeader('Excellon Object', input.file, colorOf(input)),
        h('div', { className: 'section grid2' }, plated),
        fileInfo(input),
        layer ? toolTable(layer) : null,
        layer ? geometryForm(input, 'drilling', 'Drilling', 'Generate Drill Geometry', true) : null,
        derivedList(input),
    ];
}

function toolTable(layer) {
    const rows = new Map();
    for (const hole of layer.holes) {
        const k = hole.diameter.toFixed(3);
        const r = rows.get(k) ?? { d: hole.diameter, holes: 0, slots: 0 };
        r.holes++;
        rows.set(k, r);
    }
    for (const s of layer.slots) {
        const k = s.diameter.toFixed(3);
        const r = rows.get(k) ?? { d: s.diameter, holes: 0, slots: 0 };
        r.slots++;
        rows.set(k, r);
    }
    const list = [...rows.values()].sort((a, b) => a.d - b.d);
    if (!list.length) return null;
    return h('div', { className: 'section' },
        h('h4', {}, 'Tools'),
        h('table', { className: 't' },
            h('tr', {}, h('th', { className: 'n' }, 'Ø mm'), h('th', { className: 'n' }, 'Drills'), h('th', { className: 'n' }, 'Slots')),
            list.map((r) => h('tr', {}, h('td', { className: 'n' }, fmt(r.d, 3)), h('td', { className: 'n' }, r.holes), h('td', { className: 'n' }, r.slots)))));
}

function componentsSection() {
    const r = state.report;
    const comps = r.components.filter((c) => !state.filter || c.ref.toLowerCase().includes(state.filter.toLowerCase()));
    return section('components', `Components (${r.components.length})`, [
        h('input', { type: 'search', placeholder: 'Filter by reference', value: state.filter, onInput: (e) => { state.filter = e.target.value; renderSideKeepFocus(); } }),
        h('div', { className: 'list' }, comps.map((c) => h('div', { className: `comp${c.ref === state.selected ? ' sel' : ''}`, onClick: () => selectComponent(c.ref) },
            h('span', {}, c.ref), h('span', {}, `${c.pads} pad${c.pads > 1 ? 's' : ''}`)))),
    ], { open: false });
}

function renderSideKeepFocus() {
    const pos = side.querySelector('input[type=search]')?.selectionStart;
    renderSide();
    const el = side.querySelector('input[type=search]');
    if (el) { el.focus(); if (pos !== undefined) el.setSelectionRange(pos, pos); }
}

function selectComponent(ref) {
    state.selected = state.selected === ref ? null : ref;
    renderSide();
    updateScene();
}

/** FlatCAM-style form on a Gerber/Excellon object that creates a geometry. */
function geometryForm(input, type, title, button, open) {
    const key = draftKey(input.id, type);
    const d = getDraft(input.id, type);
    const set = (patch) => {
        Object.assign(d, patch);
        for (const [k, v] of Object.entries(d)) if (v === undefined) delete d[k];
        renderSide();
        updateScene();
    };
    return section(`form:${type}`, title, [
        h('div', { className: 'grid2' }, ...opFields(d, set, { type, target: { draft: key }, input })),
        state.regionPicker?.target.draft === key ? renderRegionPicker(state.regionPicker.target) : null,
        h('div', { className: 'row' }, h('button', { className: 'b primary withic', onClick: () => createGeometry(input.id, type) }, icon(OP_ICON[type]), button)),
    ], { open });
}

/** Fields shared by geometry forms and geometry objects. */
function opFields(op, set, { type, target }) {
    const p = state.project;
    const numF = (label, key, opts = {}) => h('label', { className: 'f', title: opts.tip ?? '' }, lab(label, opts.icon, opts.tip),
        h('input', {
            type: 'number', step: opts.step ?? 'any', value: op[key] ?? '', placeholder: opts.placeholder ?? '',
            onChange: (e) => set({ [key]: e.target.value === '' ? undefined : opts.int ? parseInt(e.target.value, 10) : Number(e.target.value) }),
        }));
    const lib = state.tooldb.tools.filter((t) => OP_TOOL_TYPES[type].includes(t.type));
    const projTool = p.tools.find((t) => t.id === op.tool);
    const tools = projTool && !lib.some((t) => t.id === projTool.id) ? [projTool, ...lib] : lib;
    const tool = toolOf(op.tool);
    const toolSel = sel('Tool', op.tool, [...(tool ? [] : [['', '— choose —']]), ...tools.map((t) => [t.id, `T${t.toolNumber} ${t.name}`])], (v) => set({ tool: v }));
    const regionOpts = [['', 'Whole layer'], ...p.regions.map((r) => [r.id, regionLabel(r)]), ['+rect', '+ Draw a rectangle…'], ['+component', '+ Around a component…'], ['+net', '+ Around a net…'], ['+rest', '+ Everything else (remainder)']];
    const onRegion = (v) => {
        if (v === '+rect') return startDrawRegion(target);
        if (v === '+component' || v === '+net') { state.regionPicker = { target, kind: v.slice(1) }; renderSide(); return; }
        if (v === '+rest') {
            const existing = p.regions.find((r) => r.shape.kind === 'remainder');
            if (existing) return setTargetRegion(target, existing.id);
            return addRegionFor(target, { id: uniqueId(p.regions, 'rest'), name: 'Everything else', shape: { kind: 'remainder' } });
        }
        setTargetRegion(target, v || null);
    };
    const faceSel = sel('Board side', op.face ?? '', [['', 'Automatic'], ['top', 'Top up'], ['bottom', 'Bottom up (mirrored)']], (v) => set({ face: v || undefined }), 'Which side faces up while this runs; bottom mirrors X about the board centre');
    const area = sel('Area', op.region ?? '', regionOpts, onRegion, 'Limit the geometry to part of the board');
    let specific;
    if (type === 'isolation') {
        const w = tool ? widthAtDepth(tool, op.depth) : null;
        specific = [
            numF('Cut Z (depth), mm', 'depth', { icon: 's-cutdepth', tip: 'Below the copper surface. 0.08–0.12 cuts through 35 µm copper with margin for an uneven board' }),
            numF('Passes', 'passes', { step: 1, int: true, icon: 'b-passes', tip: 'More passes = wider isolation gap' }),
            numF('Overlap (0–0.9)', 'overlap', { icon: 'c-isolation', tip: 'Fraction of the cut width each pass overlaps the previous one' }),
            sel('Milling type', op.direction, [['climb', 'Climb'], ['conventional', 'Conventional']], (v) => set({ direction: v }), 'Climb keeps the copper on the cutter\'s right; cleaner edges on most machines', 'b-direction'),
            area, faceSel,
            h('div', { className: 'note span2' }, `Cut width at this depth: ${fmt(w, 3)} mm${op.passes > 1 && w ? `; isolation gap ≈ ${fmt(w + (op.passes - 1) * w * (1 - op.overlap), 3)} mm` : ''}.`),
        ];
    } else if (type === 'drilling') {
        const method = drillMethod(op, tool);
        const bit = tool?.type === 'drill';
        specific = [
            h('label', { className: 'f' }, lab('Method', method === 'drill' ? 'b-drill' : 'b-millhole', 'Drill: plunge every hole straight down. Mill: spiral holes bigger than the tool to their size (end mills only)'),
                h('select', { disabled: bit, onChange: (e) => set({ method: e.target.value }) },
                    [['drill', 'Drill (plunge)'], ['mill', 'Mill (helix to size)']].map(([v, l]) => h('option', { value: v, selected: v === method }, l)))),
            sel('Holes', op.holes, [['all', 'All'], ['plated', 'Plated only'], ['nonplated', 'Non-plated only']], (v) => set({ holes: v })),
            numF('Min Ø, mm', 'minDiameter', { placeholder: 'any' }),
            numF('Max Ø, mm', 'maxDiameter', { placeholder: 'any' }),
            numF('Breakthrough, mm', 'breakthrough', { icon: 's-breakthrough', tip: 'How far below the board bottom to go' }),
            faceSel,
            h('div', { className: 'note span2' }, method === 'drill'
                ? `Every hole is plunged straight down with the ${bit ? 'drill' : 'end mill'}, so it comes out the tool's size.${bit ? '' : ' Slots are skipped.'}`
                : "Holes the tool's size are plunged; bigger holes are milled to size with a spiral, and slots are milled."),
        ];
    } else if (type === 'cutout') {
        const tabs = op.tabs;
        const tabF = (label, key, int, cap, ic = 'c-tabs') => h('label', { className: 'f' }, lab(label, ic, cap), h('input', {
            type: 'number', step: int ? 1 : 'any', value: tabs[key],
            onChange: (e) => set({ tabs: { ...tabs, [key]: int ? parseInt(e.target.value, 10) : Number(e.target.value) } }),
        }));
        specific = [
            sel('Side', op.side, [['outside', 'Outside the outline'], ['inside', 'Inside'], ['on', 'On the line']], (v) => set({ side: v }), 'Which side of the outline the cutter runs on', 'b-cutout'),
            numF('Breakthrough, mm', 'breakthrough', { icon: 's-breakthrough', tip: 'How far below the board bottom to go' }),
            tabF('Tabs (gaps)', 'count', true, 'Bridges left so the board stays held; 0 cuts it free'), tabF('Tab width, mm', 'width', false, 'Length of each bridge along the edge'), tabF('Tab height, mm', 'height', false, 'Height of each bridge up from the board bottom', 's-tabheight'),
            faceSel,
        ];
    } else {
        specific = [
            numF('Cut Z (depth), mm', 'depth', { icon: 's-cutdepth', tip: 'Below the copper surface' }),
            numF('Overlap (0–0.9)', 'overlap', { icon: 'c-clearing', tip: 'Fraction of the cut width each pass overlaps the previous one' }),
            area, faceSel,
            h('label', { className: 'chk span2' }, h('input', { type: 'checkbox', checked: op.rest, onChange: (e) => set({ rest: e.target.checked }) }), 'Rest machining: only where earlier geometries did not cut'),
        ];
    }
    return [toolSel, ...specific];
}

function renderRegionPicker(target) {
    const kind = state.regionPicker.kind;
    const options = kind === 'component'
        ? (state.report?.components ?? []).map((c) => c.ref)
        : (state.report?.nets.named ?? []).map((n) => n.name);
    let value = options[0] ?? '';
    let margin = 0.5;
    if (!options.length) return h('div', { className: 'note' }, `No ${kind}s found in the loaded files (needs Gerber X2 attributes).`);
    return h('div', { className: 'card' },
        h('div', { className: 'grid2' },
            h('label', { className: 'f' }, kind === 'component' ? 'Component' : 'Net',
                h('select', { onChange: (e) => { value = e.target.value; } }, options.map((o) => h('option', { value: o }, o)))),
            h('label', { className: 'f' }, 'Margin, mm', h('input', { type: 'number', step: 'any', value: margin, onChange: (e) => { margin = Number(e.target.value); } }))),
        h('div', { className: 'row' },
            h('button', {
                className: 'b primary small',
                onClick: () => {
                    state.regionPicker = null;
                    const shape = kind === 'component' ? { kind, ref: value, margin } : { kind, net: value, margin };
                    addRegionFor(target, { id: uniqueId(state.project.regions, `${kind}-${value}`), shape });
                },
            }, 'Use'),
            h('button', { className: 'b small', onClick: () => { state.regionPicker = null; renderSide(); } }, 'Cancel')),
    );
}

function selectedGeometry(op) {
    const p = state.project;
    const input = inputOf(op.input);
    const tool = p.tools.find((t) => t.id === op.tool);
    const g = state.geo[op.id];
    const users = p.operations.filter((o) => o.tool === op.tool).length;
    const multi = multiDepth(op);
    const cutF = (label, key, tip, disabled = false, ic) => h('label', { className: 'f', title: tip ?? '' }, lab(label, ic, tip),
        h('input', {
            type: 'number', step: 'any', value: tool?.cutting[key] ?? '', disabled,
            onChange: (e) => { if (tool && e.target.value !== '') { command('tool.set', { tool: { ...tool, cutting: { ...tool.cutting, [key]: Number(e.target.value) } } }); render(); } },
        }));
    const issues = g ? [...(g.issues ?? []), ...(g.analysis ?? [])] : [];
    const s = g?.op?.stats;
    return [
        objHeader('Geometry Object', opName(op), opColor(op.id)),
        h('div', { className: 'section grid2' },
            h('label', { className: 'f span2' }, 'Name', h('input', { type: 'text', value: opName(op), onChange: (e) => updateOperation(op.id, { name: e.target.value.trim() || undefined }) })),
            h('div', { className: 'note span2' }, `${OP_LABEL[op.type]} from `, h('button', { className: 'link', onClick: () => selectObj('input', op.input, { show: true }) }, input?.file ?? op.input))),
        section('geo:params', 'Geometry', [
            h('div', { className: 'grid2' }, ...opFields(op, (patch) => updateOperation(op.id, patch), { type: op.type, target: { op: op.id } })),
            state.regionPicker?.target.op === op.id ? renderRegionPicker(state.regionPicker.target) : null,
        ]),
        tool && op.type === 'drilling' ? drillingSections(op, tool, cutF, multi, users) : null,
        tool && op.type !== 'drilling' ? section('geo:cut', `Cutting: T${tool.toolNumber} ${tool.name}`, [
            h('div', { className: 'grid2' },
                cutF('Feed rate, mm/min', 'feed'),
                cutF('Plunge rate, mm/min', 'plunge'),
                cutF('Spindle speed, RPM', 'rpm', 'Written as S; a router with a manual dial ignores it, so set the dial to match'),
                h('label', { className: 'chk' }, h('input', { type: 'checkbox', checked: multi, onChange: (e) => updateOperation(op.id, { multiDepth: e.target.checked }) }), 'Multi-depth'),
                cutF('Depth per pass, mm', 'stepdown', 'With Multi-depth on, cuts deeper than this go in several passes', !multi, 's-stepdown')),
            h('div', { className: 'note' }, `Changes this project's copy of T${tool.toolNumber}${users > 1 ? `, used by ${users} geometries` : ''}. The Tool tab holds library defaults.`),
        ]) : null,
        h('div', { className: 'section' },
            h('h4', {}, 'Preview', g?.busy ? h('span', { className: 'muted' }, 'computing…') : null),
            !state.layers[op.input] ? h('div', { className: 'note' }, `Open ${input?.file} to compute this geometry.`)
                : s ? h('div', { className: 'kv' },
                    h('span', {}, 'Cuts'), h('span', {}, `${s.cuts}${s.holes !== undefined ? ` · ${s.holes} holes` : ''}${s.tabs !== undefined ? ` · ${s.tabs} tabs` : ''}`),
                    s.breakdown ? h('span', { title: 'On the plot: + plunged, dashed circle milled to size, red slash skipped' }, 'Holes') : null,
                    s.breakdown ? h('span', {}, [s.breakdown.plunged && `${s.breakdown.plunged} plunged`, s.breakdown.milled && `${s.breakdown.milled} milled`, s.breakdown.skipped && `${s.breakdown.skipped} skipped`].filter(Boolean).join(' · ') || 'none') : null,
                    s.breakdown ? h('span', { className: 'note span2 legend' }, 'Plot: ', h('b', {}, '+'), ' plunged · ', h('b', {}, '◌'), ' milled to size (dashed) · ', h('b', { className: 'bad' }, '⊘'), ' skipped') : null,
                    h('span', {}, 'Cut length'), h('span', {}, `${fmt(s.cutLength / 1000, 2)} m`),
                    h('span', {}, 'Cutting time'), h('span', {}, `≈ ${fmt(s.minutes, 1)} min`),
                    h('span', {}, 'Deepest Z'), h('span', {}, `${s.minZ} mm`),
                    s.width !== undefined ? h('span', {}, 'Cut width') : null, s.width !== undefined ? h('span', {}, `${s.width} mm`) : null)
                    : g && !g.busy && !g.ok ? h('div', { className: 'note' }, 'No geometry; see the problems below.') : null),
        issues.length ? renderProblems(issues, `geo:${op.id}`) : null,
        h('div', { className: 'row' },
            h('button', { className: 'b primary', disabled: !g?.ok, onClick: () => createJob([op.id]) }, 'Generate CNCJob'),
            h('button', { className: 'b danger small', onClick: () => { if (removeOperation(op.id)) { setStatus(`Deleted ${opName(op)}.`); render(); updateScene(); } } }, 'Delete')),
    ];
}

/** Drilling geometry: plunge settings, and the helix settings when it mills. */
function drillingSections(op, tool, cutF, multi, users) {
    const mill = drillMethod(op, tool) === 'mill';
    const peck = h('label', { className: 'f' }, lab('Peck, mm', 's-peck', 'Lift out of the hole to clear chips after each this much depth. 0 = no pecking'),
        h('input', {
            type: 'number', step: 'any', min: 0, value: op.peck ?? 0,
            onChange: (e) => updateOperation(op.id, { peck: e.target.value === '' ? undefined : Number(e.target.value) }),
        }));
    return [
        section('geo:drill', `Drilling: T${tool.toolNumber} ${tool.name}`, [
            h('div', { className: 'grid2' },
                cutF('Plunge rate, mm/min', 'plunge', 'Downward speed. Spirals are slowed so they never go down faster than this'),
                peck,
                cutF('Spindle speed, RPM', 'rpm', 'Written as S; a router with a manual dial ignores it, so set the dial to match')),
        ]),
        mill ? section('geo:mill', 'Milling (holes bigger than the tool, slots)', [
            h('div', { className: 'grid2' },
                cutF('Feed rate, mm/min', 'feed', 'Sideways speed around the spiral or along a slot'),
                h('label', { className: 'chk' }, h('input', { type: 'checkbox', checked: multi, onChange: (e) => updateOperation(op.id, { multiDepth: e.target.checked }) }), 'Multi-depth'),
                cutF('Depth per turn, mm', 'stepdown', 'With Multi-depth on, the spiral goes down about this much per turn (slots: per pass). Off: one turn to full depth', !multi, 's-stepdown')),
            h('div', { className: 'note' }, 'Peck works best as a whole number of turns, e.g. two or three times the depth per turn.'),
        ]) : null,
        h('div', { className: 'note section' }, `Changes this project's copy of T${tool.toolNumber}${users > 1 ? `, used by ${users} geometries` : ''}. The Tool tab holds library defaults.`),
    ];
}

function selectedGeometries(ids) {
    const ops = state.project.operations.filter((o) => ids.includes(o.id));
    const tools = new Set(ops.map((o) => o.tool));
    return [
        objHeader('Geometry Objects', `${ops.length} selected`, '#888'),
        h('div', { className: 'section' },
            ops.map((o) => h('div', { className: 'link-row', onClick: () => selectObj('geo', o.id) },
                h('span', { className: 'swatch', style: `background:${opColor(o.id)}` }), opName(o), h('span', { className: 'muted' }, ` · ${toolSummary(toolOf(o.tool))}`)))),
        outputSettings(tools.size),
        h('div', { className: 'row' }, h('button', { className: 'b primary', onClick: () => createJob(ids) }, `Generate CNCJob from ${ops.length} geometries`)),
        h('div', { className: 'note' }, 'They run in Project tab order (Geometry list).'),
    ];
}

function outputSettings(toolCount) {
    const o = state.project.output;
    return h('div', { className: 'section' },
        h('div', { className: 'grid2' },
            sel('Tool changes', o.toolChange, [['split', 'One file per tool'], ['m6', 'One file with M6']], (v) => { command('output.update', { toolChange: v }); render(); }, 'gSender only pauses at M6 when its tool change option is not "Ignore"'),
            h('label', { className: 'f', title: 'Seconds to wait after M3 so the spindle reaches speed' }, 'Spindle wait, s',
                h('input', { type: 'number', step: 'any', value: o.spindleDelay ?? 2, onChange: (e) => { command('output.update', { spindleDelay: Number(e.target.value) }); render(); } }))),
        toolCount > 1 && state.toolChangeOption ? h('div', { className: 'note' }, `gSender tool change option: ${state.toolChangeOption}.`) : null);
}

function selectedJob(job) {
    const r = job.result;
    const stale = jobStale(job);
    const tools = new Set(job.ops.map((id) => opOf(id)?.tool));
    return [
        objHeader('CNC Job Object', job.name, '#ffffff'),
        h('div', { className: 'section' },
            h('label', { className: 'f' }, 'Name', h('input', { type: 'text', value: job.name, onChange: (e) => { if (e.target.value.trim()) { job.name = e.target.value.trim(); saveJobs(); render(); } } })),
            h('h4', { className: 'mt' }, 'Geometries'),
            job.frozen
                ? job.frozen.geometries.map((g) => h('div', { className: 'link-row' },
                    g.name, h('span', { className: 'muted' }, ` · ${g.tool}${job.frozen.deleted.includes(g.name) ? ' · deleted' : ''}`)))
                : job.ops.map((id) => opOf(id)).filter(Boolean).map((o) => h('div', { className: 'link-row', onClick: () => selectObj('geo', o.id, { show: true }) },
                    h('span', { className: 'swatch', style: `background:${opColor(o.id)}` }), opName(o), h('span', { className: 'muted' }, ` · ${toolSummary(toolOf(o.tool))}`)))),
        job.frozen ? null : outputSettings(tools.size),
        job.frozen ? h('div', { className: `status${job.frozen.stale || !r ? ' warn' : ''}` },
            !r ? 'Its G-code was not kept when gSender closed (the project was not saved to a file). Delete this job.'
                : `Made from geometry that was deleted (${job.frozen.deleted.join(', ')}). The G-code is kept as it was, but it can't be regenerated.`
                    + (job.frozen.stale ? ' It was out of date when the geometry was deleted: check it in gSender\'s visualizer before cutting.' : ''))
        : job.busy ? h('div', { className: 'status' }, 'Generating G-code…')
            : !r || stale ? h('div', { className: `status${stale ? ' warn' : ''}` },
                stale ? 'Out of date: a geometry or output setting changed.' : 'Not generated yet.',
                h('div', { className: 'row' }, h('button', { className: 'b primary small', onClick: () => runJob(job) }, stale ? 'Regenerate' : 'Generate'))) : null,
        r?.ok ? h('div', { className: 'section' },
            h('div', { className: 'kv' },
                h('span', {}, 'Cutting time'), h('span', {}, `≈ ${fmt(r.stats.minutes, 1)} min (feed moves only)`),
                h('span', {}, 'Cut length'), h('span', {}, `${fmt(r.stats.cutLength / 1000, 2)} m`),
                h('span', {}, 'Tools'), h('span', {}, r.stats.tools))) : null,
        r?.issues.length ? renderProblems(r.issues, `job:${job.id}`) : null,
        r?.ok ? h('div', { className: 'section' },
            h('h4', {}, 'G-code'),
            r.files.map((f) => h('div', { className: 'item' },
                h('div', { className: 'top' },
                    h('span', { className: 'name' }, f.name),
                    h('span', { className: 'muted' }, `${(f.gcode.length / 1024).toFixed(0)} KB · T${f.tools.join(', T')} · ≈ ${fmt(f.stats.minutes, 1)} min`)),
                h('div', { className: 'row' },
                    loadButton(f, { disabled: stale, title: stale ? 'Regenerate first' : '' }),
                    h('button', { className: 'b small', onClick: () => showCode(job, f) }, 'View code')))),
            r.files.length > 1 ? h('div', { className: 'note' }, 'Run the files in order. Change the bit and re-zero Z between them.') : null,
            h('div', { className: 'note' }, 'Before cutting: check the toolpaths in gSender\'s visualizer and do an air cut with Z0 set a few mm above the board.'),
        ) : null,
        h('div', { className: 'row' }, h('button', { className: 'b danger small', onClick: () => { removeJob(job.id); setStatus(`Deleted ${job.name}.`); render(); updateScene(); } }, 'Delete')),
    ];
}

function renderProblems(issues, owner) {
    const errors = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity !== 'error');
    return h('div', { className: 'section' },
        h('h4', {}, `Problems: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}`),
        h('ul', { className: 'issues clickable' }, groupIssues(issues).map((g) => renderIssueGroup(g, owner))));
}

function renderIssueRow(x, label) {
    return h('li', {
        className: `${x.severity}${state.selIssue === x.index ? ' sel' : ''}`,
        title: x.at ? 'Show on the plot' : '',
        onClick: (e) => { e.stopPropagation(); if (!x.at) return; state.selIssue = x.index; state.main = 'plot'; renderMain(); view.centerOn(x.at[0], x.at[1], 6); renderSide(); updateScene(); },
    }, label ?? x.message, x.at ? ' ⌖' : '');
}

function renderIssueGroup(g, owner) {
    if (g.items.length === 1 && g.code !== 'tool-too-wide') return renderIssueRow(g.items[0]);
    const key = `${owner}|${g.key}`;
    const open = !!state.openGroups[key];
    const gaps = g.items.map((x) => x.gap).filter((v) => v !== null && v !== undefined);
    return h('li', { className: g.severity },
        h('span', { onClick: () => { state.openGroups[key] = !open; renderSide(); } }, `${open ? '▾' : '▸'} ${groupTitle(g)}`),
        g.code === 'tool-too-wide' && opOf(g.opId) ? h('div', { className: 'row' },
            h('button', { className: 'b small primary', onClick: () => useFinerBit(g.opId, gaps.length ? Math.min(...gaps) : null) }, 'Use a finer bit there')) : null,
        open ? h('ul', { className: 'issues clickable' }, g.items.map((x) => renderIssueRow(x, x.gap != null ? `gap ${fmt(x.gap, 3)} mm at (${fmt(x.at[0], 2)}, ${fmt(x.at[1], 2)})` : undefined))) : null,
    );
}

// --- Tool tab ---------------------------------------------------------------

function tabTools() {
    const used = new Set(state.project.operations.map((o) => o.tool));
    const toolInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onChange: (e) => { openFiles(e.target.files); e.target.value = ''; } });
    const editing = state.editTool;
    return [
        h('div', { className: 'section' },
            h('h4', {}, 'Tool library'),
            h('div', { className: 'row' },
                ['vbit', 'endmill', 'drill'].map((type) => h('button', { className: 'b', onClick: () => { state.editTool = `new:${type}`; state.toolErrors = null; renderSide(); } }, `+ ${TOOL_LABEL[type]}`))),
            h('div', { className: 'note' }, 'Feeds are mm/min. RPM is written as S in the G-code; a spindle with a manual dial ignores it, so set the dial to match.'),
        ),
        editing?.startsWith('new:') ? renderToolForm(blankTool(editing.slice(4)), true) : null,
        h('div', { className: 'section' },
            state.tooldb.tools.map((t) => editing === t.id
                ? renderToolForm(t, false)
                : h('div', { className: 'item' },
                    h('div', { className: 'top' },
                        TOOL_ICON[t.type] ? icon(TOOL_ICON[t.type], 'Tool and the profile it cuts') : null,
                        h('span', { className: 'name' }, t.name),
                        used.has(t.id) ? h('span', { className: 'badge' }, 'in project') : null,
                        h('button', { className: 'link', onClick: () => { state.editTool = t.id; state.toolErrors = null; renderSide(); } }, 'edit'),
                    ),
                    h('div', { className: 'meta' },
                        h('span', {}, toolSummary(t)),
                        h('span', {}, `F${t.cutting.feed} plunge ${t.cutting.plunge} S${t.cutting.rpm} step ${t.cutting.stepdown}`)),
                    t.notes ? h('div', { className: 'note' }, t.notes) : null,
                )),
        ),
        h('div', { className: 'section' },
            h('div', { className: 'row' },
                h('button', { className: 'b', onClick: () => showExport('Tool library JSON', state.tooldb) }, 'Export'),
                h('button', { className: 'b', onClick: () => toolInput.click() }, 'Import…'),
                h('button', { className: 'b', onClick: addMissingDefaults }, 'Add defaults')),
            toolInput,
        ),
    ];
}

function renderToolForm(tool, isNew) {
    const d = structuredClone(tool);
    const field = (label, get, set, opts = {}) => h('label', { className: 'f' }, label,
        h('input', {
            type: opts.text ? 'text' : 'number', step: 'any', value: get() ?? '', placeholder: opts.placeholder ?? '',
            onChange: (e) => set(opts.text ? e.target.value : e.target.value === '' ? undefined : Number(e.target.value)),
        }));
    const save = () => {
        if (!d.name) d.name = `${TOOL_LABEL[d.type]} ${d.type === 'vbit' ? `${d.angle}° ${d.tipDiameter}` : d.diameter} mm`;
        if (isNew || !d.id) d.id = uniqueId(state.tooldb.tools, `${d.type === 'vbit' ? `vbit-${d.angle}-${d.tipDiameter}` : `${d.type === 'drill' ? 'drill' : 'em'}-${d.diameter}`}`);
        for (const k of ['maxDepth', 'notes']) if (d[k] === undefined || d[k] === '') delete d[k];
        saveToolFromForm(d);
    };
    const inProject = state.project.operations.some((o) => o.tool === tool.id);
    return h('div', { className: 'item card' },
        h('div', { className: 'grid2' },
            field('Name', () => d.name, (v) => { d.name = v; }, { text: true, placeholder: 'auto' }),
            field('Tool number (T)', () => d.toolNumber, (v) => { d.toolNumber = v; }),
            ...(d.type === 'vbit'
                ? [field('Tip width, mm', () => d.tipDiameter, (v) => { d.tipDiameter = v; }), field('Angle, °', () => d.angle, (v) => { d.angle = v; })]
                : [field('Diameter, mm', () => d.diameter, (v) => { d.diameter = v; })]),
            field('Feed, mm/min', () => d.cutting.feed, (v) => { d.cutting.feed = v; }),
            field('Plunge, mm/min', () => d.cutting.plunge, (v) => { d.cutting.plunge = v; }),
            field('RPM (S)', () => d.cutting.rpm, (v) => { d.cutting.rpm = v; }),
            field('Step down, mm', () => d.cutting.stepdown, (v) => { d.cutting.stepdown = v; }),
            field('Max depth, mm', () => d.maxDepth, (v) => { d.maxDepth = v; }, { placeholder: 'optional' }),
        ),
        field('Notes', () => d.notes, (v) => { d.notes = v; }, { text: true, placeholder: 'optional' }),
        state.toolErrors ? h('ul', { className: 'issues' }, state.toolErrors.map((e) => h('li', { className: 'error' }, e))) : null,
        h('div', { className: 'row' },
            h('button', { className: 'b primary', onClick: save }, 'Save'),
            h('button', { className: 'b', onClick: () => { state.editTool = null; state.toolErrors = null; renderSide(); } }, 'Cancel'),
            !isNew ? h('button', {
                className: 'b danger', disabled: inProject, title: inProject ? 'Used by a geometry in this project' : '',
                onClick: () => deleteTool(tool.id),
            }, 'Delete') : null),
        inProject ? h('div', { className: 'note' }, 'Saving also updates this project\'s copy of the tool.') : null,
    );
}

// --- Plot area tabs: Plot Area, Preferences, code -----------------------------

const mainTabs = h('div', { className: 'maintabs' });
const plotPane = h('div', { className: 'pane plot' });
const prefsPane = h('div', { className: 'pane page' });
const codePane = h('div', { className: 'pane page code' });
main.append(mainTabs, plotPane, prefsPane, codePane);

function renderMain() {
    const tabs = [['plot', 'Plot Area'], ['prefs', 'Preferences']];
    if (state.code) tabs.push(['code', state.code.file]);
    mainTabs.replaceChildren(...tabs.map(([id, label]) => h('button', {
        className: state.main === id ? 'active' : '',
        onClick: () => { state.main = id; renderMain(); },
    }, label, id === 'code' ? h('span', {
        className: 'x', title: 'Close',
        onClick: (e) => { e.stopPropagation(); state.code = null; state.main = 'plot'; renderMain(); },
    }, '×') : null)));
    plotPane.style.display = state.main === 'plot' ? '' : 'none';
    prefsPane.style.display = state.main === 'prefs' ? '' : 'none';
    codePane.style.display = state.main === 'code' ? '' : 'none';
    if (state.main === 'prefs') renderPrefs();
    if (state.main === 'code') renderCode();
}

function renderPrefs() {
    const p = state.project;
    const s = p.setup;
    const num = (label, key, tip, ic) => h('label', { className: 'f', title: tip ?? '' }, lab(label, ic, tip),
        h('input', { type: 'number', step: 'any', value: s[key], onChange: (e) => { command('setup.update', { [key]: Number(e.target.value) }); renderPrefs(); } }));
    prefsPane.replaceChildren(h('div', { className: 'prefs' },
        h('h3', {}, 'Project preferences'),
        h('div', { className: 'section' },
            h('h4', {}, 'Stock and heights'),
            h('div', { className: 'grid2' },
                num('Board thickness, mm', 'stockThickness', 'Used for drilling and cutout depth'),
                num('Safe Z, mm', 'safeZ', 'Height for rapids between geometries and tool changes', 's-height'),
                num('Travel Z, mm', 'travelZ', 'Height for short moves inside a geometry', 's-height'),
                h('label', { className: 'f' }, 'Origin (X0 Y0)',
                    h('select', { onChange: (e) => { command('setup.update', { origin: e.target.value }); refresh(); } },
                        [['board-lower-left', 'Board lower-left corner'], ['gerber', 'Gerber file origin']].map(([v, l]) => h('option', { value: v, selected: s.origin === v }, l))))),
            h('div', { className: 'note' }, 'Z0 is the copper surface. Zero Z on the board (or let the Autoleveler do it) before running.')),
        h('div', { className: 'section' },
            h('h4', {}, 'G-code output'),
            outputSettings(2)),
        h('div', { className: 'section' },
            h('h4', {}, `Areas (${p.regions.length})`),
            p.regions.length ? p.regions.map((r) => h('div', { className: 'item' },
                h('div', { className: 'top' },
                    h('span', { className: 'name' }, regionLabel(r)),
                    h('button', { className: 'link', onClick: () => { removeRegion(r.id); renderPrefs(); } }, 'delete')),
                h('div', { className: 'meta' }, h('span', {}, `used by: ${p.operations.filter((o) => o.region === r.id).map(opName).join(', ') || 'nothing'}`))))
                : h('div', { className: 'note' }, 'Areas limit a geometry to part of the board. Choose one under Area in a geometry form.')),
    ));
}

function renderCode() {
    const c = state.code;
    const job = jobOf(c.job);
    const file = job?.result?.files?.find((f) => f.name === c.file);
    const ta = h('textarea', { className: 'gcode', readOnly: true, spellcheck: false, value: c.text });
    codePane.replaceChildren(
        h('div', { className: 'codebar' },
            h('b', {}, c.file), h('span', { className: 'muted' }, ` · ${c.text.split('\n').length} lines`),
            h('span', { className: 'spacer' }),
            h('button', { className: 'b small', onClick: () => copyText(c.text, ta) }, 'Copy'),
            file ? loadButton(file, { disabled: jobStale(job) }) : null),
        ta);
}

// ---------------------------------------------------------------------------
// Plot
// ---------------------------------------------------------------------------

const pickBox = h('div', { className: 'pick', style: 'display:none' });
const empty = h('div', { className: 'empty' }, 'Open or drop a board’s Gerber and drill files');
const viewHost = h('div', { className: 'canvas' });
plotPane.append(viewHost, pickBox, empty);

const view = createView(viewHost, {
    onClick: (p) => identify(p),
    onRect: (rect) => finishDrawRegion(rect),
    onMove: (p) => { coords.textContent = `X ${fmt(p.x, 3)}  Y ${fmt(p.y, 3)} mm`; },
});

const toolpathCache = new WeakMap();
const pathOf = (op, transform) => {
    let path = toolpathCache.get(op);
    if (!path) toolpathCache.set(op, (path = toolpathPath(op, transform)));
    return path;
};

/** Issues of the selected geometry or CNC job, as shown in its Problems list. */
function selectedIssues() {
    const s = primary();
    if (state.side !== 'selected' || !s) return [];
    if (s.kind === 'geo') { const g = state.geo[s.id]; return g ? [...(g.issues ?? []), ...(g.analysis ?? [])] : []; }
    if (s.kind === 'job') return jobOf(s.id)?.result?.issues ?? [];
    return [];
}

function updateScene({ fit = false } = {}) {
    const p = state.project;
    empty.style.display = Object.keys(state.layers).length ? 'none' : '';
    const order = { 'copper-bottom': 0, other: 1, 'copper-top': 2, outline: 3, drill: 4 };
    const key = (i) => (i.role === 'copper' ? `copper-${i.side}` : i.role);
    const s = primary();

    const toolpaths = [];
    for (const op of p.operations) {
        const g = state.geo[op.id];
        if (!g?.op || state.hidden[`geo:${op.id}`] || !state.layers[op.input]) continue;
        const tool = toolOf(op.tool);
        const chosen = isSel('geo', op.id);
        toolpaths.push({ path: pathOf(g.op, g.transform), color: opColor(op.id), visible: true, width: chosen ? g.op.stats.width ?? tool?.diameter ?? 0 : 0, diameter: tool?.diameter ?? (tool ? widthAtDepth(tool, 0) : 0.8) });
    }
    for (const j of state.jobs) {
        if (!j.result?.ok || state.hidden[`job:${j.id}`]) continue;
        for (const op of j.result.operations ?? []) {
            const tool = toolOf(op.tool);
            toolpaths.push({ path: pathOf(op, j.result.transform), color: opColor(op.id), visible: true, width: op.stats.width ?? tool?.diameter ?? 0, diameter: tool?.diameter ?? 0.8 });
        }
    }

    const layers = [...p.inputs]
        .filter((i) => state.layers[i.id])
        .sort((a, b) => (order[key(a)] ?? 1) - (order[key(b)] ?? 1))
        .map((i) => ({ id: i.id, layer: state.layers[i.id], color: colorOf(i), visible: state.meta[i.id].visible, opacity: i.role === 'copper' ? (toolpaths.length ? 0.5 : 0.8) : 0.9 }));

    // The area of the selected geometry, or of the open form on a selected Gerber.
    const regions = [];
    let target = null;
    if (state.side === 'selected' && s?.kind === 'geo') target = opOf(s.id);
    if (state.side === 'selected' && s?.kind === 'input') {
        const type = ['isolation', 'clearing', 'cutout', 'drilling'].find((t) => state.drafts[draftKey(s.id, t)] && !collapsed(`form:${t}`, t !== 'clearing'));
        if (type) target = { ...state.drafts[draftKey(s.id, type)], type, input: s.id, enabled: true, id: '__draft' };
    }
    if (target?.region && Object.keys(state.layers).length) {
        try {
            const mask = regionMask(p, target, state.layers);
            if (mask?.length) regions.push({ shape: mask, color: '#0ef6ae', active: true });
        } catch { /* region not computable yet */ }
    }

    const markers = [];
    selectedIssues().slice(0, 300).forEach((x, i) => { if (x.at) markers.push({ at: x.at, severity: x.severity, selected: state.selIssue === i }); });
    const comp = state.selected && state.report?.components.find((c) => c.ref === state.selected);
    view.setScene({
        layers, board: state.report?.board ?? null, regions, toolpaths, markers,
        highlight: comp?.bounds ? { xmin: comp.bounds.xmin - 0.3, ymin: comp.bounds.ymin - 0.3, xmax: comp.bounds.xmax + 0.3, ymax: comp.bounds.ymax + 0.3 } : null,
        pick: state.pick,
    }, { fit });
}

// Click to identify: objects under the cursor with their X2 data.
const boxCache = new WeakMap();
function identify(p) {
    const hits = [];
    for (const input of state.project.inputs) {
        const layer = state.layers[input.id];
        if (!layer || !state.meta[input.id].visible) continue;
        if (layer.format === 'gerber') {
            for (const o of layer.objects) {
                let b = boxCache.get(o);
                if (b === undefined) boxCache.set(o, (b = G.bounds(o.shape)));
                if (!b || p.x < b.xmin || p.x > b.xmax || p.y < b.ymin || p.y > b.ymax) continue;
                if (!G.containsPoint(o.shape, p.x, p.y)) continue;
                hits.push({ input, o });
            }
        } else {
            for (const hole of [...layer.holes, ...layer.slots]) {
                const near = hole.path ? distToPolyline(p, hole.path) : Math.hypot(p.x - hole.x, p.y - hole.y);
                if (near <= hole.diameter / 2) hits.push({ input, hole, layer });
            }
        }
    }
    state.pick = hits.length ? { ...p, hits } : null;
    renderPick();
    updateScene();
}

function distToPolyline(p, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[Math.min(i + 1, pts.length - 1)];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy));
    }
    return best;
}

function renderPick() {
    const pk = state.pick;
    if (!pk) { pickBox.style.display = 'none'; return; }
    pickBox.style.display = '';
    const rows = pk.hits.slice(-8).reverse().map(({ input, o, hole, layer }) => {
        if (hole) {
            return h('div', {}, h('b', {}, input.file), ` · ${hole.path ? 'slot' : 'hole'} Ø${fmt(hole.diameter, 3)} · ${isPlated(hole, layer) === null ? 'plating ?' : isPlated(hole, layer) ? 'PTH' : 'NPTH'}`);
        }
        const pad = o.attrs?.['.P'];
        return h('div', {},
            h('b', {}, input.file), ` · ${o.kind}${o.polarity === 'clear' ? ' (clear)' : ''}`,
            componentOf(o) ? h('br') : null, componentOf(o) ? `component ${componentOf(o)}${pad?.[1] ? ` pad ${pad[1]}` : ''}` : null,
            netOf(o) ? h('br') : null, netOf(o) ? `net ${netOf(o)}` : null);
    });
    pickBox.replaceChildren(
        h('div', {}, h('b', {}, `X ${fmt(pk.x, 3)}  Y ${fmt(pk.y, 3)}`), ' ', h('button', { className: 'link', onClick: () => { state.pick = null; renderPick(); updateScene(); } }, 'close')),
        ...rows);
}

// ---------------------------------------------------------------------------
// Keys, drag and drop, start-up
// ---------------------------------------------------------------------------

const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? '');
document.addEventListener('keydown', (e) => {
    if (document.querySelector('.dialog-back')) return; // the dialog handles its own keys
    if (e.key === 'Escape') { cancelDraw(); if (state.menu) { state.menu = null; renderHeader(); } return; }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveProjectFile({ as: e.shiftKey }); return; }
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'v' || e.key === 'V' || e.key === '1') view.fit();
    else if (e.key === '=' || e.key === '+') view.zoom(0.8);
    else if (e.key === '-') view.zoom(1.25);
});
document.addEventListener('click', () => { if (state.menu) { state.menu = null; renderHeader(); } });
document.addEventListener('dragover', (e) => { e.preventDefault(); plotPane.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) plotPane.classList.remove('drop'); });
document.addEventListener('drop', (e) => { e.preventDefault(); plotPane.classList.remove('drop'); openFiles(e.dataTransfer.files); });

document.getElementById('root').append(header, side, main, statusBar);
document.body.append(toastEl);
installIcons();
await restore();
// Geometry objects are always part of the job; older projects may have disabled ones.
for (const op of state.project.operations.filter((o) => !o.enabled)) command('operation.set', { operation: { ...op, enabled: true } }, { quiet: true });
const hadView = applyRestoredUi();
const missingFiles = state.project.inputs.filter((i) => !state.layers[i.id]).map((i) => i.file);
if (missingFiles.length) {
    state.status = state.status ?? { text: state.lastFileName && !state.file
        ? `Restored "${state.project.name}" without its board files. Open ${state.lastFileName} (File → Open project) or the board files to continue.`
        : `Restored "${state.project.name}". Open ${missingFiles.join(', ')} (File → Open all board files) to continue.` };
} else if (state.file?.status === 'paused') {
    state.status = state.status ?? { err: true, text: `Not saving to ${state.file.name} until you allow it: File → Save project.` };
}
// Bring the project file up to date (the last write may not have finished when the page closed).
if (state.file?.status === 'saved') markDirty();
uiReady = true;
refresh({ fit: !hadView });
scheduleGeometry();
// CNC jobs that had G-code get it back (generation is deterministic).
for (const job of state.jobs) if (job.rerun) { delete job.rerun; runJob(job); }
// Follow gSender's light/dark setting.
setInterval(() => { getWorkspaceState().then(applyTheme).catch(() => {}); }, 5000);
