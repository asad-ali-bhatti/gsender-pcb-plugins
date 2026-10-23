// PCB CAM workspace, laid out like FlatCAM: a menu bar and toolbar, a side
// panel with Project / Selected / Tool tabs, the plot area and a status bar.
// Workflow: open Gerber / Excellon objects → create Geometry objects from them
// (one project operation each) → create CNC Job objects from geometries and
// load their G-code into gSender. All board logic lives in ../core; every
// project change goes through its command layer.

import { storage, gcode, getWorkspaceState } from '@sienci/gsender-plugin-sdk';
import {
    loadFile, createProject, applyCommand, validateProject, inspectBoard, componentOf, netOf, isPlated,
    createToolDb, setTool, removeTool, findTool, widthAtDepth, regionMask, shapeMask, multiDepth, drillMethod, geometry as G,
    runnableProject, gcodeHash, CORE_VERSION, PROJECT_FORMAT,
} from '../core/index.js';
import { DEFAULT_TOOLS, operationDefaults, standardJob, pickTool, OP_TOOL_TYPES } from './defaults.js';
import { createEngine } from './engine.js';
import { installIcons, icon } from './icons.js';
import { createView, toolpathPath } from './view.js';
import {
    session, savedHandle, savedFolder, fileApi, pickSaveFile, pickOpenFile, pickFolder, writePermission, writeFile, readFile,
    folderId, markFolder, folderFile, inFolder, createProjectFile, boardName, PROJECT_EXT,
} from './persist.js';

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
// FlatCAM-like plot colours: green copper, blue isolation, yellow cutout, orange drills.
const COLORS = { 'copper-top': '#8cc63f', 'copper-bottom': '#3fb6a8', copper: '#8cc63f', outline: '#e6c229', drill: '#e8833a', other: '#8b949e' };
const OP_COLORS = {
    isolation: ['#6b7bff', '#4fa3ff', '#a07bff'],
    drilling: ['#ff5c8a', '#ff8a65'],
    cutout: ['#ffd84d', '#f2a541'],
    clearing: ['#c792ea', '#ff7edb'],
};
const AREA_COLOR = '#0ef6ae';
const OP_LABEL = { isolation: 'Isolation', drilling: 'Drilling', cutout: 'Cutout', clearing: 'Copper clearing' };
const OP_ICON = { isolation: 'b-isolation', drilling: 'b-drill', cutout: 'b-cutout', clearing: 'b-clearing' };
const OP_DESC = {
    isolation: 'A V-bit cuts a narrow groove around every trace and pad, separating them from the rest of the copper. The copper outside the groove stays on the board.',
    clearing: 'An end mill removes all copper that is not part of a trace or pad. Slower than isolation, but leaves a clean board with less risk of solder bridges.',
    drilling: 'Cuts the holes from the drill file, either plunging straight down or milling each hole to size (see Method).',
    cutout: 'Mills through the board along its outline, leaving small tabs so the board stays attached until you snap it out.',
};
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
    hidden: {},          // 'geo:<id>' / 'job:<id>' / 'area:<id>' → hidden on the plot
    jobs: [],            // CNC jobs: { id, name, ops, result?, key?, busy? }
    selIssue: null,
    openGroups: {},      // problem group key → expanded
    selected: null,      // highlighted component
    filter: '',
    pick: null,
    status: null,
    exportText: null,    // { title, text } shown for copying
    toolChangeOption: null,
    folder: null,        // projects folder: { dir, id, name }
    folderHint: null,    // projects folder to reconnect after a restart: { id, name }
    fileHint: null,      // project file to reopen after a restart: { name, external }
    file: null,          // project file: { handle, name, status: saved | dirty | saving | paused | error, error, external }
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
//  - the project file in the projects folder: everything, autosaved every few
//    seconds. It is what survives a restart.
// Toolpaths and live jobs' G-code are not stored; they are regenerated.
// Plugin storage values are JSON strings because storage.set deep-merges
// objects; a string replaces the old value in one message (delete-then-set
// lost the project when the page unloaded between the two).
// ---------------------------------------------------------------------------

const MAX_SETTINGS_VALUE = 256 * 1024; // characters per plugin storage key
const KEYS = { project: 'project.json', jobs: 'jobs.json', ui: 'ui.json', tooldb: 'tooldb.json', folder: 'folder.json' };
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
    if (!session.set('frozen', code) && !state.file) warnOnce('frozen', 'The G-code of jobs whose geometry was deleted is too large to keep when you leave this page. Choose a projects folder (File → Save project) to keep it.');
    markDirty();
}
function saveFiles() {
    if (!session.set('files', state.texts) && !state.file) warnOnce('files', 'The board files are too large to keep when you leave this page. Choose a projects folder (File → Save project) to keep them.');
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
    }, 1000);
}
// Leaving the page: send what is still waiting.
const leaving = () => { saveUi(); flushSaves(); if (diskDirty) writeToDisk(); };
window.addEventListener('pagehide', leaving);
document.addEventListener('visibilitychange', () => { if (document.hidden) leaving(); });

// --- Projects folder and project file ---------------------------------------
// Every project is a file in the projects folder. The file is created when the
// project gets its first content and written every AUTOSAVE_MS while something
// changed, so quitting gSender loses at most the last few seconds. Plugin
// storage only remembers the folder's id and name and the open file's name, so
// the folder can be reconnected (one pick) after gSender restarts.

const AUTOSAVE_MS = 3000;
let diskDirty = false;   // the project file is behind the workspace
let autosaveOn = false;  // set once the restore is done: never write a half-restored project

/** The whole workspace as one document: the project file's content. */
function projectDoc() {
    const boardFiles = {};
    for (const f of Object.values(state.texts)) boardFiles[f.name] = f.text;
    return {
        format: PROJECT_FORMAT, version: 1, project: state.project, boardFiles,
        // gcodeHash: what the user reviewed here; Project Runner regenerates the
        // job and refuses to run it when its G-code hashes differently.
        jobs: state.jobs.map((j) => ({
            id: j.id, name: j.name, ops: j.ops, hadResult: !!j.result,
            ...(j.gcodeHash ? { gcodeHash: j.gcodeHash, coreVersion: CORE_VERSION } : {}),
            ...(j.frozen ? { frozen: j.frozen, result: keptResult(j.result) } : {}),
        })),
    };
}

const hasContent = () => state.project.inputs.length > 0 || state.project.operations.length > 0 || state.jobs.length > 0;

function markDirty() {
    if (!state.file || state.file.status === 'paused') return;
    diskDirty = true;
    if (state.file.status !== 'saving') setFileStatus('dirty');
}
function setFileStatus(status, error = null) {
    if (!state.file) return;
    state.file.status = status;
    state.file.error = error;
    renderFileState();
}

let writeChain = Promise.resolve(); // writes run one at a time, in order
/** Writes the project as it is now (captured before returning) to its file. */
function writeToDisk() {
    diskDirty = false;
    const f = state.file;
    if (!f || f.status === 'paused') return writeChain;
    const text = JSON.stringify(projectDoc());
    setFileStatus('saving');
    writeChain = writeChain.then(async () => {
        try {
            await writeFile(f.handle, text);
            if (state.file === f) setFileStatus(diskDirty ? 'dirty' : 'saved');
        } catch (e) {
            if (f.status !== 'error') console.warn('PCB CAM: write project file', e);
            if (state.file === f) { diskDirty = true; setFileStatus('error', e.message); } // retried by the next autosave
        }
    });
    return writeChain;
}

let autosaving = false;
async function autosave() {
    if (!autosaveOn || autosaving) return;
    autosaving = true;
    try {
        if (!state.file && state.folder && hasContent()) await createFileInFolder();
        if (diskDirty) await writeToDisk();
    } finally {
        autosaving = false;
    }
}

/** Gives the open project a new file in the projects folder, named after it. */
async function createFileInFolder() {
    const folder = state.folder;
    try {
        const handle = await createProjectFile(folder.dir, state.project.name);
        if (state.folder !== folder || state.file) return;
        useFile(handle, { status: 'dirty' });
        diskDirty = true;
    } catch (e) {
        console.warn('PCB CAM: create project file', e);
        warnOnce('create', `Could not create a project file in ${folder.name}: ${e.message}. File → Save project to try again.`);
    }
}

/**
 * Makes `handle` the open project's file: one in the projects folder, or one
 * opened from anywhere else (`external`), which is saved where it is.
 */
function useFile(handle, { status = 'saved', external = false } = {}) {
    state.file = { handle, name: handle.name, status, error: null, external };
    state.fileHint = null;
    savedHandle.set(handle);
    rememberPlace();
    renderFileState();
}

function forgetProjectFile() {
    diskDirty = false;
    state.file = null;
    state.fileHint = null;
    savedHandle.set(null);
    rememberPlace();
}

/** Plugin storage: which folder and project file to reconnect after a restart. */
function rememberPlace() {
    const f = state.folder ?? state.folderHint;
    queueSave(KEYS.folder, {
        folder: f ? { id: f.id, name: f.name } : null,
        file: state.file?.name ?? null,
        external: !!state.file?.external,
    });
}

/** Title, text and button of the "choose / reconnect the projects folder" prompt. */
function folderPrompt() {
    const hint = state.folderHint;
    const file = state.fileHint && !state.fileHint.external ? state.fileHint.name : null;
    return hint
        ? {
            title: 'Reconnect your projects folder',
            text: `gSender forgets folder access when it quits. Choose "${hint.name}" again to continue${file ? ` with ${file}` : ''}.`,
            label: `Reconnect "${hint.name}"…`,
        }
        : {
            title: 'Choose a projects folder',
            text: 'PCB CAM keeps each new project as a file in one folder and saves it every few seconds, so your work is safe if gSender closes. Create or choose a folder, for example Documents/PCB Projects.',
            label: 'Choose projects folder…',
        };
}

let pendingDrop = null; // files dropped before the projects folder was chosen
/** True when work can start (the project has a file, or a folder to get one); otherwise asks for the projects folder. */
function folderReady() {
    if (!fileApi || state.folder || state.file) return true;
    const p = folderPrompt();
    showDialog({ title: p.title, text: p.text, buttons: [[p.label, 'primary', connectFolder], ['Cancel', '', () => { pendingDrop = null; }]] });
    return false;
}

/** Asks for the projects folder. Must run straight from a click (folder picker). */
async function connectFolder() {
    let dir;
    try {
        dir = await pickFolder();
    } catch (e) {
        setStatus(`Could not open the folder: ${e.message}`, true);
        return;
    }
    if (!dir) return;
    const hint = state.folderHint;
    const file = state.fileHint && !state.fileHint.external ? state.fileHint.name : null;
    const id = await folderId(dir);
    if (hint && id !== hint.id) {
        showDialog({
            title: `This is not "${hint.name}"`,
            text: `${dir.name} is not the projects folder you used last time${file ? `, so ${file} is not in it` : ''}. Choose "${hint.name}" again, or keep your projects in ${dir.name} from now on.`,
            buttons: [['Choose again…', 'primary', connectFolder], [`Use ${dir.name}`, '', () => adoptFolder(dir, id)], ['Cancel', '', null]],
        });
        return;
    }
    await adoptFolder(dir, id);
}

async function adoptFolder(dir, id) {
    try {
        id = id ?? await markFolder(dir);
    } catch (e) {
        setStatus(`Cannot save files in ${dir.name} (${e.message}). Choose a folder you can write to.`, true);
        return;
    }
    const hint = state.folderHint;
    const file = state.fileHint && !state.fileHint.external ? state.fileHint.name : null;
    state.folder = { dir, id, name: dir.name };
    state.folderHint = null;
    savedFolder.set(dir);
    rememberPlace();
    // After a restart: reopen the project that was open in the folder.
    let reopened = false;
    if (file && !hasContent()) {
        const handle = await folderFile(dir, file);
        try {
            if (handle && importJson(handle.name, await readFile(handle))) { useFile(handle); reopened = true; }
        } catch (e) {
            setStatus(`Could not read ${file}: ${e.message}`, true);
        }
        if (!handle && hint?.id === id) setStatus(`${file} is no longer in ${dir.name}. Open a project (File → Open project) or board files to start a new one.`, true);
    }
    if (reopened) setStatus(`Reopened "${state.project.name}" from ${dir.name}.`);
    else if (!state.status?.err) {
        setStatus(state.file?.external ? `Projects folder: ${dir.name}. New projects are saved there; this one stays in ${state.file.name}.`
            : hasContent() ? `Projects folder: ${dir.name}. This project is saved there every few seconds.`
                : `Projects folder: ${dir.name}. Now open your board files.`);
    }
    render();
    if (pendingDrop) { const files = pendingDrop; pendingDrop = null; openFiles(files); }
}

/** File → Save project: writes now; asks for the projects folder first if there is none. Must run from a click. */
async function saveProjectFile() {
    if (!fileApi) { showExport('Project JSON', projectDoc()); return; }
    if (!state.file && !state.folder) await connectFolder();
    if (!state.file && !state.folder) return;
    if (!state.file) await createFileInFolder();
    else if (state.file.status === 'paused' || state.file.status === 'error') {
        if (await writePermission(state.file.handle, true) !== 'granted') {
            setStatus(`gSender did not allow writing to ${state.file.name}.`, true);
            return;
        }
        state.file.status = 'dirty';
    }
    if (!state.file) return;
    await writeToDisk();
    if (state.file?.status === 'saved') setStatus(`Saved to ${state.file.external ? '' : `${state.folder.name}/`}${state.file.name}. Changes are saved there every few seconds.`);
}

/** File → Save a copy: writes the project to a file anywhere; keeps working on the open one. */
async function saveCopy() {
    if (!fileApi) { showExport('Project JSON', projectDoc()); return; }
    try {
        const handle = await pickSaveFile(`${(state.project.name || 'board').replace(/[^\w.-]+/g, '-')}${PROJECT_EXT}`, state.folder?.dir);
        if (!handle) return;
        await writeFile(handle, JSON.stringify(projectDoc()));
        setStatus(`Saved a copy as ${handle.name}. You are still working on ${state.file?.name ?? `"${state.project.name}"`}.`);
    } catch (e) {
        console.error(e);
        setStatus(`Could not save the copy: ${e.message}`, true);
    }
}

/**
 * File → Open project. The project is saved back to the file it came from,
 * wherever that is. Must run straight from a click (file picker).
 */
async function openProjectFile() {
    if (!fileApi) { openPicker('.json,application/json'); return; }
    try {
        const picked = await pickOpenFile(state.folder?.dir);
        if (!picked) return;
        const text = await readFile(picked);
        const inside = state.folder && await inFolder(state.folder.dir, picked);
        // Inside the folder, use its handle: the folder's write access covers it.
        const handle = inside ? await folderFile(state.folder.dir, picked.name) ?? picked : picked;
        const perm = inside ? 'granted' : await writePermission(handle, true);
        if (!importJson(picked.name, text)) return;
        useFile(handle, { status: perm === 'granted' ? 'saved' : 'paused', external: !inside });
        setStatus(perm === 'granted'
            ? `Opened "${state.project.name}". Changes are saved to ${handle.name} every few seconds.`
            : `Opened "${state.project.name}", but gSender may not write to ${handle.name}. File → Save project to allow it.`, perm !== 'granted');
    } catch (e) {
        console.error(e);
        setStatus(`Could not open the project file: ${e.message}`, true);
    }
}

// --- Restore ----------------------------------------------------------------
// Leaving the CAM page and coming back restores the workspace from plugin
// storage and the browser session. After gSender restarts the session is gone,
// so the workspace starts empty until the projects folder is reconnected and
// the last project is read back from its file: never a half-restored project.

let restoredUi = null;
async function restore() {
    const inSession = session.get('alive') === true;
    let frozen = session.get('frozen') ?? {};
    let hint = null;
    try {
        const db = await readStored(KEYS.tooldb, 'tooldb');
        if (db && Array.isArray(db.tools)) state.tooldb = db;
        hint = await readStored(KEYS.folder);
        if (inSession || !fileApi) {
            const p = await readStored(KEYS.project, 'project');
            if (p && p.version === 1) {
                const issues = validateProject(p).filter((i) => i.code === 'schema');
                if (!issues.length) state.project = p;
            }
            attachKeptFiles(session.get('files') ?? {});
            const jobs = await readStored(KEYS.jobs, 'jobs');
            if (Array.isArray(jobs)) state.jobs = restoreJobs(jobs, (j) => frozen[j.id]);
        } else {
            // Last session's project; its file is read back on reconnect.
            state.project = createProject('Board');
            queueSave(KEYS.project, state.project);
            queueSave(KEYS.jobs, []);
        }
        if (await storage.get('files.json', null) !== null) storage.delete('files.json').catch(() => {}); // board files were briefly kept here
        restoredUi = await readStored(KEYS.ui);
    } catch (e) {
        state.status = { err: true, text: `Storage unavailable: ${e.message}` };
    }
    session.set('alive', true);
    try {
        const ws = await getWorkspaceState();
        state.toolChangeOption = ws?.toolChangeOption ?? null;
        applyTheme(ws);
    } catch { /* outside gSender */ }
    if (!fileApi) return;
    // { folder: { id, name }, file, external }; first builds stored { id, name, file }.
    const place = hint?.id ? { folder: hint, file: hint.file } : hint ?? {};
    const f = place.folder;
    state.folderHint = f && typeof f.id === 'string' && typeof f.name === 'string' ? { id: f.id, name: f.name } : null;
    state.fileHint = typeof place.file === 'string' ? { name: place.file, external: !!place.external } : null;
    if (!inSession) return;
    // Within one gSender session the folder and file are still known and allowed.
    const dir = await savedFolder.get();
    if (dir && state.folderHint && await writePermission(dir) === 'granted' && await folderId(dir) === state.folderHint.id) {
        state.folder = { dir, id: state.folderHint.id, name: dir.name };
        state.folderHint = null;
    }
    const handle = await savedHandle.get();
    const inside = handle && state.folder && await inFolder(state.folder.dir, handle);
    const perm = handle && (inside ? 'granted' : await writePermission(handle));
    if (handle && perm !== 'denied') {
        state.file = { handle, name: handle.name, status: perm === 'granted' ? 'saved' : 'paused', error: null, external: !inside };
        state.fileHint = null;
        // The project file fills in what the session couldn't keep.
        const needFiles = state.project.inputs.some((i) => !state.layers[i.id]);
        const needCode = state.jobs.some((j) => j.frozen && !j.result);
        if (needFiles || needCode) {
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
    const order = { job: 0, geo: 1, region: 2, input: 3 };
    sel.sort((a, b) => order[a.kind] - order[b.kind]);
    const done = [];
    const freed = [];
    for (const s of sel) {
        if (s.kind === 'job') { removeJob(s.id); done.push(s.id); }
        else if (s.kind === 'geo') { if (removeOperation(s.id)) done.push(s.id); }
        else if (s.kind === 'region') { const f = removeRegion(s.id); if (f) { done.push(s.id); freed.push(...f); } }
        else if (removeInput(s.id)) done.push(s.id);
    }
    if (done.length === sel.length) {
        setStatus(`Deleted ${done.length} object${done.length > 1 ? 's' : ''}.${freed.length ? ` ${freed.join(', ')} now cover${freed.length === 1 ? 's' : ''} the whole layer.` : ''}`);
    }
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
    let first = null; // first board file opened
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
            first = first ?? file.name;
        } catch (e) {
            setStatus(`${file.name}: ${e.message}`, true);
            console.error(e);
            return;
        }
    }
    if (added) {
        saveFiles();
        // A new project takes the board's name (its file is named after it).
        const name = boardName(first);
        if (!state.file && state.project.name === 'Board' && name) command('project.rename', { name }, { quiet: true });
    }
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
 * project in the projects folder gets its last changes written there first;
 * one that can't be saved asks to save or discard. (The plugin iframe can't
 * show confirm().)
 */
async function whenProjectSafe(action) {
    if (state.folder && !state.file && hasContent()) await createFileInFolder();
    const f = state.file;
    if (f && (f.status === 'saved' || f.status === 'dirty' || f.status === 'saving')) {
        if (f.status !== 'saved') writeToDisk(); // captures the project before `action` replaces it
        action();
        return;
    }
    const p = state.project;
    if (!hasContent()) { action(); return; }
    showDialog({
        title: `Close "${p.name}"?`,
        text: f
            ? `Its latest changes could not be saved to ${f.name}. Closing discards them.`
            : 'This project is not saved: there is no projects folder yet. Closing discards it.',
        buttons: [
            [f ? 'Save project' : 'Choose projects folder…', 'primary', async () => { await saveProjectFile(); if (state.file?.status === 'saved') action(); }],
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
/** Colour by operation type; further operations of the same type take the next shade. */
function opColor(id) {
    const op = opOf(id);
    const shades = OP_COLORS[op?.type] ?? OP_COLORS.isolation;
    const n = state.project.operations.filter((o) => o.type === op?.type).findIndex((o) => o.id === id);
    return shades[Math.max(0, n) % shades.length];
}

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
const runnable = (p) => runnableProject(p, state.layers);

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

const regionOf = (id) => state.project.regions.find((r) => r.id === id);

/**
 * Deletes an area. Geometries and forms limited to it go back to the whole layer.
 * @returns {string[]|null} names of the geometries that changed, or null when it failed
 */
function removeRegion(id) {
    const users = state.project.operations.filter((o) => o.region === id);
    for (const op of users) updateOperation(op.id, { region: null });
    for (const d of Object.values(state.drafts)) if (d.region === id) d.region = null;
    if (!command('region.remove', { id })) return null;
    dropFromSelection('region', id);
    delete state.hidden[`area:${id}`];
    render();
    updateScene();
    return users.map(opName);
}

/** The area whose outline is within `tol` mm of `p`, drawn ones first. */
function regionAt(p, tol) {
    const near = (pts) => pts.some((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy) <= tol;
    });
    for (const r of state.project.regions) {
        if (state.hidden[`area:${r.id}`] && !isSel('region', r.id)) continue;
        const sh = r.shape;
        const pts = sh.kind === 'rect' ? [[sh.rect[0], sh.rect[1]], [sh.rect[2], sh.rect[1]], [sh.rect[2], sh.rect[3]], [sh.rect[0], sh.rect[3]]]
            : sh.kind === 'polygon' ? sh.points : null;
        if (pts && near(pts)) return r.id;
    }
    return null;
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
        const result = await engine.job(state.project, { id: job.id, name: job.name, ops: job.ops }, state.toolChangeOption);
        job.result = result;
        job.key = key;
        // Only Project Runner reads the hash; a job must never fail over it.
        job.gcodeHash = null;
        if (result.ok) {
            try { job.gcodeHash = await gcodeHash(result.files); } catch (e) { console.warn('PCB CAM: gcodeHash', e); }
        }
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
const pickFiles = (accept = '') => { fileInput.accept = accept; fileInput.click(); };
/** Opens board files (or a project): needs the projects folder first. */
const openPicker = (accept = '') => { if (folderReady()) pickFiles(accept); };
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
            ['Save a copy as…  (⇧⌘S)', saveCopy],
            ...(fileApi ? [[state.folder ? `Change projects folder (${state.folder.name})…` : folderPrompt().label, connectFolder]] : []),
            ['Close project', closeProject, !hasContent() && !state.file],
            null,
            ['Open Gerber…', () => openPicker(GERBER_EXT)],
            ['Open Excellon…', () => openPicker(EXCELLON_EXT)],
            ['Open all board files…', () => openPicker('')],
            ['Open tool library (.json)…', () => pickFiles('.json,application/json')],
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
        ? (!fileApi ? ['Not saved to a file', 'warn', 'Kept until gSender quits. File → Export project JSON keeps a copy.']
            : state.fileHint?.external ? [`Reopen · ${state.fileHint.name}`, 'warn', 'gSender forgets file access when it quits: open the project again.']
                : !state.folder ? [state.folderHint ? `Reconnect · ${state.folderHint.name}` : 'No projects folder', 'warn', folderPrompt().text]
                : [`Projects folder · ${state.folder.name}`, '', 'The project gets its file there as soon as it has content.'])
        : f.status === 'saved' ? [`Saved · ${f.name}`, '', `Saved every few seconds to ${f.external ? `${f.name}, where you opened it` : `${state.folder?.name}/${f.name}`}.`]
            : f.status === 'dirty' || f.status === 'saving' ? [`Saving · ${f.name}`, '', '']
                : f.status === 'paused' ? [`Not saving · ${f.name}`, 'warn', 'gSender needs your OK to write this file again: File → Save project.']
                    : [`Save failed · ${f.name}`, 'err', f.error ?? ''];
    fileState.textContent = text;
    fileState.className = `filestate ${cls}`;
    fileState.title = title;
    fileState.onclick = f ? (f.status === 'saved' ? null : () => saveProjectFile())
        : !fileApi ? null : state.fileHint?.external ? openProjectFile : !state.folder ? connectFolder : null;
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

function section(key, title, content, { open: dflt = true, extra, ic, desc } = {}) {
    const open = !collapsed(key, dflt);
    return h('div', { className: `section fold${open ? ' open' : ''}` },
        h('h4', { className: 'foldhead', onClick: () => { state.open[key] = !open; renderSide(); updateScene(); } }, h('span', { className: ic ? 'lt' : '' }, `${open ? '▾' : '▸'} `, ic ? icon(ic, desc ? `${title}\n${desc}` : title) : null, title), extra ?? null),
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
    info ? h('span', { className: 'info' }, info) : null,
    h('button', {
        className: 'rm', title: 'Delete', 'aria-label': `Delete ${label}`,
        onClick: (e) => { e.stopPropagation(); state.sel = [{ kind, id }]; deleteSelected(); },
        onDblClick: (e) => e.stopPropagation(),
    }, '×'));
    const group = (key, title, items, add) => {
        const open = !collapsed(`g:${key}`);
        return h('div', { className: 'tgroup' },
            h('div', { className: 'thead', onClick: () => { state.open[`g:${key}`] = !open; renderSide(); } },
                h('span', { className: 'tt' }, `${open ? '▾' : '▸'} ${title}`),
                add ? h('button', { className: 'add', title: add.tip, onClick: (e) => { e.stopPropagation(); add.run(); } }, '+ Add') : null,
                h('span', { className: 'count' }, items.length)),
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
    const regionItem = (r) => {
        const n = p.operations.filter((o) => o.region === r.id).length;
        return item('region', r.id, {
            label: regionLabel(r),
            info: n ? `${n} geometr${n === 1 ? 'y' : 'ies'}` : 'unused',
            color: AREA_COLOR, visible: !state.hidden[`area:${r.id}`],
            onVisible: (v) => { state.hidden[`area:${r.id}`] = !v; updateScene(); },
        });
    };
    const empty = !p.inputs.length;
    if (fileApi && !state.folder && !state.file) {
        const fp = folderPrompt();
        const ext = state.fileHint?.external ? state.fileHint.name : null;
        return [ext
            ? h('div', { className: 'section card' },
                h('b', {}, 'Reopen your project'),
                h('p', {}, `gSender forgets file access when it quits. Open ${ext} again to continue; it is saved where it is.`),
                h('div', { className: 'row' },
                    h('button', { className: 'b primary', onClick: openProjectFile }, `Open ${ext}…`),
                    h('button', { className: 'b', onClick: connectFolder }, fp.label)))
            : h('div', { className: 'section card' },
                h('b', {}, fp.title),
                h('p', {}, fp.text),
                h('div', { className: 'row' },
                    h('button', { className: 'b primary', onClick: connectFolder }, fp.label),
                    h('button', { className: 'b', onClick: openProjectFile }, 'Open a project file…')))];
    }
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
            group('gerber', 'Gerber', gerbers.map(inputItem), { tip: 'Open Gerber files', run: () => openPicker(GERBER_EXT) }),
            group('excellon', 'Excellon', drills.map(inputItem), { tip: 'Open drill files', run: () => openPicker(EXCELLON_EXT) }),
            group('geometry', 'Geometry', p.operations.map(geoItem)),
            group('cnc', 'CNC Job', state.jobs.map(jobItem)),
            p.regions.length ? group('areas', 'Areas', p.regions.map(regionItem)) : null),
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
    if (s.kind === 'region') return regionOf(s.id) ? selectedRegion(regionOf(s.id)) : [];
    return jobOf(s.id) ? selectedJob(jobOf(s.id)) : [];
}

function selectedRegion(r) {
    const users = state.project.operations.filter((o) => o.region === r.id);
    const rect = r.shape.kind === 'rect' ? r.shape.rect : null;
    return [
        objHeader('Area', r.name ?? 'Area', AREA_COLOR),
        h('div', { className: 'section' },
            h('div', { className: 'kv' },
                h('span', {}, 'Shape'), h('span', {}, regionLabel(r)),
                rect ? h('span', {}, 'Size') : null, rect ? h('span', {}, `${fmt(rect[2] - rect[0], 2)} × ${fmt(rect[3] - rect[1], 2)} mm`) : null,
                h('span', {}, 'Used by'), h('span', {}, users.map(opName).join(', ') || 'nothing')),
            h('div', { className: 'note' }, users.length ? 'Deleting it makes these geometries cover the whole layer again.' : 'No geometry is limited to this area.'),
            h('div', { className: 'row' }, h('button', { className: 'b danger small', onClick: () => deleteSelected() }, 'Delete area'))),
    ];
}

function objHeader(kind, name, color) {
    return h('div', { className: 'objhead' }, h('span', { className: 'swatch', style: `background:${color}` }), h('span', { className: 'kind' }, kind), h('span', { className: 'oname' }, name));
}

/** Field label text with its icon; hovering the icon shows it large with `cap`. */
const lab = (text, ic, cap) => (ic ? h('span', { className: 'lt' }, icon(ic, cap ? `${text}\n${cap}` : text), text) : text);
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
    out.push(derivedList(input), deleteFileRow(input));
    return out;
}

/** "Delete file" for a Gerber or Excellon object; blocked while geometries use it. */
function deleteFileRow(input) {
    const users = state.project.operations.filter((o) => o.input === input.id);
    return h('div', { className: 'section' },
        h('div', { className: 'row' }, h('button', {
            className: 'b danger small', disabled: users.length > 0,
            onClick: () => { state.sel = [{ kind: 'input', id: input.id }]; deleteSelected(); },
        }, 'Delete file')),
        users.length ? h('div', { className: 'note' }, `Used by ${users.map(opName).join(', ')}; delete those geometries first.`) : null);
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
        deleteFileRow(input),
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
        h('div', { className: 'row' }, h('button', { className: 'b primary', onClick: () => createGeometry(input.id, type) }, button)),
    ], { open, ic: OP_ICON[type], desc: OP_DESC[type] });
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
            numF('Cut Z (depth), mm', 'depth', { icon: 's-cutdepth', tip: 'Below the copper surface (Z0). 0.08 cuts through 35 µm copper with margin; a V-bit cuts wider the deeper it goes, so only go deeper on an uneven, unlevelled board' }),
            numF('Passes', 'passes', { step: 1, int: true, icon: 'b-passes', tip: 'More passes = wider isolation gap' }),
            numF('Overlap (0–0.9)', 'overlap', { icon: 'c-isolation', tip: 'Fraction of the cut width each pass overlaps the previous one' }),
            sel('Milling type', op.direction, [['climb', 'Climb'], ['conventional', 'Conventional']], (v) => set({ direction: v }),
                'Seen from above, spindle turning clockwise (M3).\nClimb (left): the cutter travels with the trace on its right, so each tooth bites in at full thickness and leaves cleanly. Sharper copper edges, fewer burrs; the usual choice for PCBs.\nConventional (right): the cutter travels the other way; each tooth starts thin and rubs before it cuts. More burrs, but gentler on a machine with backlash or a loose spindle.',
                op.direction === 'conventional' ? 'c-conventional' : 'c-climb'),
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
    onClick: (p) => {
        const r = regionAt(p, 6 * view.pxSize());
        if (r) { selectObj('region', r, { show: true }); setStatus('Area selected. Press Delete to remove it.'); } else identify(p);
    },
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
            toolpaths.push({ path: pathOf(op, j.result.transform), color: opColor(op.id), visible: true, travel: true, width: op.stats.width ?? tool?.diameter ?? 0, diameter: tool?.diameter ?? 0.8 });
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
            if (mask?.length) regions.push({ shape: mask, color: AREA_COLOR, active: true });
        } catch { /* region not computable yet */ }
    }
    // Drawn areas stay on the plot (faint) so they can be clicked; component and net
    // areas only when selected. The selected one is drawn like an active area.
    for (const r of p.regions) {
        const chosen = isSel('region', r.id);
        if (r.id === target?.region || r.shape.kind === 'remainder') continue;
        if (!chosen && (state.hidden[`area:${r.id}`] || !['rect', 'polygon'].includes(r.shape.kind))) continue;
        const input = p.operations.find((o) => o.region === r.id)?.input ?? p.inputs.find((i) => i.role === 'copper')?.id;
        try {
            const mask = shapeMask(r.shape, state.layers, input);
            if (mask?.length) regions.push({ shape: mask, color: AREA_COLOR, active: chosen });
        } catch { /* needs a layer that isn't open */ }
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
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (e.shiftKey) saveCopy(); else saveProjectFile(); return; }
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'v' || e.key === 'V' || e.key === '1') view.fit();
    else if (e.key === '=' || e.key === '+') view.zoom(0.8);
    else if (e.key === '-') view.zoom(1.25);
});
document.addEventListener('click', () => { if (state.menu) { state.menu = null; renderHeader(); } });
document.addEventListener('dragover', (e) => { e.preventDefault(); plotPane.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) plotPane.classList.remove('drop'); });
document.addEventListener('drop', (e) => {
    e.preventDefault();
    plotPane.classList.remove('drop');
    const files = [...e.dataTransfer.files];
    if (folderReady()) openFiles(files);
    else pendingDrop = files; // opened once the folder is chosen
});

document.getElementById('root').append(header, side, main, statusBar);
document.body.append(toastEl);
installIcons();
await restore();
// Geometry objects are always part of the job; older projects may have disabled ones.
for (const op of state.project.operations.filter((o) => !o.enabled)) command('operation.set', { operation: { ...op, enabled: true } }, { quiet: true });
const hadView = applyRestoredUi();
const missingFiles = state.project.inputs.filter((i) => !state.layers[i.id]).map((i) => i.file);
if (!state.file && state.fileHint?.external) {
    state.status = state.status ?? { text: `Reopen your project: open ${state.fileHint.name} in the Project tab to continue.` };
} else if (!state.folder && state.folderHint) {
    state.status = state.status ?? { text: `${folderPrompt().title}: choose "${state.folderHint.name}" in the Project tab to continue.` };
} else if (missingFiles.length) {
    state.status = state.status ?? { text: `Restored "${state.project.name}". Open ${missingFiles.join(', ')} (File → Open all board files) to continue.` };
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
autosaveOn = true;
setInterval(autosave, AUTOSAVE_MS);
// Follow gSender's light/dark setting.
setInterval(() => { getWorkspaceState().then(applyTheme).catch(() => {}); }, 5000);
