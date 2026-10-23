// Project Runner panel (visualizer overlay, so it stays loaded on every page
// and keeps following a job). A short wizard: open a PCB CAM project file,
// 1. pick its jobs, 2. put them in order and add pauses, G-code or bit changes
// around them, 3. run them one by one through gSender's own sender. Every machine motion
// starts from a click here or in gSender; the Runner never starts one itself.

import { machine, gcode, storage, getReduxState, getWorkspaceState, subscribeWorkspaceState } from '@sienci/gsender-plugin-sdk';
import { parseProjectFile, inspectJobs } from './jobs.js';
import { defaultSelection, moveJob, reorderJob, toggleJob, selectionWarnings, planSteps, planWarnings, bitLabel } from './plan.js';
import { COMMAND_TYPES, makeCommand, commandProblem, checkGcode, runGcode } from './commands.js';
import {
    createRun, parseRun, serializeRun, currentStep, stepOf, startStep, progressStep, endStep, skipStep, markDone, retryStep, changedSteps, runFileName,
    setBitStage, finishBitStep, insertBitChange, removeBitChange, needsBitConfirm, bitStepFor, finishCommandStep, runStarted, restartRun, finishOriginStep,
} from './runstate.js';
import { createTracker, track } from './tracker.js';
import { zeroZ, raiseForBitChange, setXYOrigin, clampRaise, ZERO_DEFAULTS, ZERO_LIMITS } from './zeroz.js';
import { fileApi, pickOpen, pickSave, writePermission, writeText, readText, savedHandle } from './files.js';

// gSender records DOM changes for usage data; keep this frame out of it.
try { document.body.classList.add('ph-no-capture'); window.frameElement?.classList.add('ph-no-capture'); } catch { /* cross-origin */ }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    // Project being set up (no run yet)
    doc: null, fileName: null, jobs: null, ids: [],
    view: 'jobs',            // wizard page while setting up: 'jobs' | 'order'
    commands: {},            // { [jobId]: { before: [cmd], after: [cmd] } } (commands.js)
    adding: null,            // { job, where: 'before' | 'after', type, text, error } while the add form is open
    cmdSeq: 0,
    reuseHandle: null,       // run file of a run the user went back from before it started; Start run writes it again
    // Run in progress
    run: null, runJobs: null, changed: new Set(), handle: null,
    file: null,              // { name, status: 'saved' | 'saving' | 'error' | 'paused' | 'memory', error }
    // gSender
    gs: { connected: false, workflow: 'idle', activeState: null, sender: null, wpos: null },
    loaded: null,            // { step, name, total } once gSender reports our file
    tracker: null,           // { step, t }
    confirmed: false,        // "bit is in and Z is zeroed" ticked for the current step
    motion: null,            // { step, what: 'raise' | 'zero', status } while the Runner moves the machine
    abort: false,            // Stop pressed during that motion
    busy: null,              // text while opening / loading / starting
    msg: null,               // { kind, text }
    showHistory: false,
    confirmRestart: false,
    raise: ZERO_DEFAULTS.raise, // height (work Z, mm) Raise Z goes up to (plugin storage)
    raised: null,            // { step, z } work Z after Raise Z in the current bit change   // the "Restart the run?" card is open
    reopen: null,            // run file handle that needs a click to get permission again
    lastPointer: null,       // { name, fileName, step } from plugin storage
    toolChangeOption: null,
};

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'className') el.className = v;
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}
const b = (text) => h('b', {}, text);
const button = (label, onClick, { kind = '', disabled = false, title } = {}) => h('button', { className: `b ${kind}`, onClick, disabled, title }, label);

function setMsg(kind, text) { state.msg = text ? { kind, text } : null; render(); }

const minutes = (m) => (m == null ? '' : m < 1 ? '<1 min' : `${Math.round(m)} min`);
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

// ---------------------------------------------------------------------------
// Opening files
// ---------------------------------------------------------------------------

async function openFile() {
    if (!fileApi) { setMsg('err', 'This version of gSender can\'t open files from a plugin.'); return; }
    if (isRunning()) { setMsg('warn', 'Wait until the job has ended before opening another file.'); return; }
    let handle;
    try { handle = await pickOpen(); } catch (e) { setMsg('err', `Could not open the file: ${e.message}`); return; }
    if (!handle) return;
    let text;
    try { text = await readText(handle); } catch (e) { setMsg('err', `Could not read ${handle.name}: ${e.message}`); return; }
    let probe = null;
    try { probe = JSON.parse(text)?.format; } catch { /* reported below */ }
    if (probe === 'pcb-project-run') await openRun(handle, text);
    else await openProject(handle.name, text);
}

/** A project or run file dropped on the panel. */
async function dropFile(e) {
    e.preventDefault();
    if (dragId) { commitDrop(); return; } // a job dropped between the boxes
    const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
    if (!item) return;
    // Both must be asked for before the first await.
    const handleP = item.getAsFileSystemHandle?.() ?? Promise.resolve(null);
    const file = item.getAsFile();
    if (isRunning()) { setMsg('warn', 'Wait until the job has ended before opening another file.'); return; }
    const text = await file.text();
    let probe = null;
    try { probe = JSON.parse(text)?.format; } catch { /* reported below */ }
    if (probe === 'pcb-project-run') {
        const handle = await handleP.catch(() => null);
        if (!handle) { setMsg('err', 'Open run files with Open… so the Runner can keep saving them.'); return; }
        await openRun(handle, text);
    } else {
        await openProject(file.name, text);
    }
}
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', dropFile);

async function openProject(name, text) {
    const r = parseProjectFile(text);
    if (!r.ok) { setMsg('err', `${name}: ${r.message}`); return; }
    state.busy = 'Checking the jobs…';
    render();
    try {
        await refreshToolChangeOption();
        const jobs = await inspectJobs(r.doc, { toolChangeOption: state.toolChangeOption });
        closeRun();
        Object.assign(state, { doc: r.doc, fileName: name, jobs, ids: defaultSelection(jobs), view: 'jobs', commands: {}, adding: null, msg: null });
        const notReady = jobs.filter((j) => j.status !== 'ready').length;
        if (notReady) setMsg('warn', `${notReady} of ${jobs.length} jobs can't run yet; see the reason under each.`);
    } catch (e) {
        console.error(e);
        setMsg('err', `Could not check the jobs: ${e.message}`);
    } finally {
        state.busy = null;
        render();
    }
}

async function openRun(handle, text, { quiet = false } = {}) {
    const r = parseRun(text);
    if (!r.ok) { setMsg('err', `${handle.name}: ${r.message}`); return; }
    state.busy = 'Checking the jobs…';
    render();
    try {
        const jobs = await inspectJobs(r.run.project.doc);
        const perm = await writePermission(handle);
        closeRun();
        Object.assign(state, {
            doc: null, jobs: null, run: r.run, runJobs: jobs, changed: new Set(changedSteps(r.run, jobs)), handle, reopen: null,
            file: { name: handle.name, status: perm === 'granted' ? 'saved' : 'paused', error: null },
        });
        savedHandle.set(handle);
        await attachToLiveJob();
        savePointer();
        if (!quiet) setMsg('ok', `Opened the run "${handle.name}".`);
        if (state.changed.size) setMsg('err', 'Some jobs changed since this run started and can\'t run. Start a new run from the project.');
    } catch (e) {
        console.error(e);
        setMsg('err', `Could not open the run: ${e.message}`);
    } finally {
        state.busy = null;
        render();
    }
}

async function startRun() {
    const warnings = selectionWarnings(state.jobs, state.ids);
    if (warnings.some((w) => w.severity === 'error')) { render(); return; }
    let handle = null;
    if (state.reuseHandle && await writePermission(state.reuseHandle, true) === 'granted') {
        handle = state.reuseHandle;
    } else if (fileApi) {
        try {
            handle = await pickSave(runFileName(state.fileName, state.doc.project.name));
        } catch (e) {
            setMsg('err', `Could not create the run file: ${e.message}`);
            return;
        }
        if (!handle) return;
    }
    const run = createRun({ doc: state.doc, fileName: state.fileName, jobs: state.jobs, ids: state.ids, commands: usedCommands() });
    Object.assign(state, {
        run, runJobs: state.jobs, changed: new Set(), handle, doc: null, jobs: null, ids: [], commands: {}, adding: null, reuseHandle: null, confirmed: false, loaded: null,
        file: handle ? { name: handle.name, status: 'saved', error: null } : { name: null, status: 'memory', error: null },
    });
    if (handle) savedHandle.set(handle);
    await saveRun(true);
    setMsg('ok', 'Run started.');
}

/** The commands of the selected jobs only (the run file keeps what runs). */
function usedCommands() {
    return Object.fromEntries(state.ids.filter((id) => state.commands[id]).map((id) => [id, state.commands[id]]));
}

function closeProject() {
    Object.assign(state, { doc: null, jobs: null, ids: [], commands: {}, adding: null, view: 'jobs', reuseHandle: null });
    setMsg(null);
}

/** All steps back to pending (history kept), after the user confirmed. */
function doRestart() {
    state.confirmRestart = false;
    if (isRunning()) { setMsg('warn', 'Stop the job first.'); return; }
    if (!restartRun(state.run, state.runJobs)) { setMsg('err', 'Some jobs changed. Start a new run from the project.'); return; }
    Object.assign(state, { changed: new Set(), loaded: null, tracker: null, confirmed: false });
    saveRun(true);
    setMsg('ok', 'Run restarted from step 1.');
}

function restartCard() {
    const run = state.run;
    const done = run.steps.filter((s) => s.kind === 'run' && s.status === 'done').length;
    return h('div', { className: 'card warn' },
        h('div', { className: 'card-head' }, h('span', {}, 'Restart'), h('b', {}, 'Restart the run?')),
        h('ul', { className: 'warnlist' },
            h('li', {}, 'All progress is reset to step 1.', done ? [' ', b(`${plural(done, 'done job')} will be cut again.`)] : ''),
            h('li', {}, 'Lost position (alarm, reset, power off)? ', b('Home'), ' and check X0 Y0 first.'),
            h('li', { className: 'muted' }, 'History is kept.')),
        h('div', { className: 'row' },
            button('Cancel', () => { state.confirmRestart = false; render(); }, { kind: 'grow0' }),
            button('Restart run', doRestart, { kind: 'danger' })));
}

const LOCKED = 'The run has started, so setup is locked. To change jobs, close the run and start a new one.';

/**
 * From the Run page back to setup, allowed only while nothing has happened on
 * the machine. The picks, order and added steps come back as they were, and
 * Start run writes the same run file again.
 */
function backFromRun(view) {
    const run = state.run;
    if (isRunning() || runStarted(run)) { setMsg('warn', LOCKED); return; }
    if (state.changed.size) { setMsg('err', 'Some jobs changed. Close the run and open the project again.'); return; }
    const setup = {
        doc: run.project.doc, fileName: run.project.fileName, jobs: state.runJobs, ids: [...run.selection],
        commands: structuredClone(run.commands ?? {}), adding: null, view, reuseHandle: state.handle,
    };
    clearTimeout(saveTimer);
    saveTimer = null;
    closeRun();
    savedHandle.set(null);
    replaceStored('lastRun', null);
    state.lastPointer = null;
    Object.assign(state, setup);
    const used = Object.values(state.commands).flatMap((c) => [...(c.before ?? []), ...(c.after ?? [])]).map((c) => Number(String(c.id).slice(1)) || 0);
    state.cmdSeq = Math.max(state.cmdSeq, ...used);
    setMsg('ok', 'Back to setup. Press Start run when ready.');
}

function closeRun() {
    clearTimeout(saveTimer);
    saveTimer = null;
    Object.assign(state, { run: null, runJobs: null, changed: new Set(), handle: null, file: null, loaded: null, tracker: null, confirmed: false, showHistory: false, confirmRestart: false });
}

async function endRun() {
    if (isRunning()) { setMsg('warn', 'Stop the job first.'); return; }
    if (saveTimer) await saveRun(true);
    closeRun();
    savedHandle.set(null);
    replaceStored('lastRun', null);
    state.lastPointer = null;
    setMsg(null);
}

// ---------------------------------------------------------------------------
// Saving the run file
// ---------------------------------------------------------------------------

let saveTimer = null;
let saving = Promise.resolve();

/** Writes the run file now (`now`) or within 5 s. */
function saveRun(now = false) {
    if (!state.run) return Promise.resolve();
    clearTimeout(saveTimer);
    if (!now) { saveTimer = setTimeout(() => saveRun(true), 5000); return Promise.resolve(); }
    saveTimer = null;
    savePointer();
    const f = state.file;
    if (!state.handle || !f || f.status === 'paused' || f.status === 'memory') return Promise.resolve();
    const text = serializeRun(state.run);
    const handle = state.handle;
    saving = saving.then(async () => {
        f.status = 'saving';
        renderFileState();
        try {
            await writeText(handle, text);
            f.status = 'saved';
            f.error = null;
        } catch (e) {
            console.warn('Project Runner: write run file', e);
            f.status = 'error';
            f.error = e.message;
        }
        renderFileState();
    });
    return saving;
}

async function allowWrites() {
    if (!state.handle) return;
    const p = await writePermission(state.handle, true);
    if (p === 'granted') { state.file.status = 'saved'; await saveRun(true); }
    render();
}

// gSender's storage.set deep-merges objects, so delete first to replace.
async function replaceStored(key, value) {
    try {
        await storage.delete(key);
        if (value !== null) await storage.set(key, value);
    } catch { /* outside gSender */ }
}
function savePointer() {
    const run = state.run;
    if (!run) return;
    const cur = currentStep(run);
    const pointer = { name: run.project.name, fileName: state.file?.name ?? null, step: cur ? run.steps.indexOf(cur) + 1 : run.steps.length, steps: run.steps.length, at: Date.now() };
    state.lastPointer = pointer;
    replaceStored('lastRun', pointer);
}

// ---------------------------------------------------------------------------
// gSender events
// ---------------------------------------------------------------------------

const isRunning = () => !!state.motion || (state.tracker && ['running', 'paused'].includes(state.tracker.t.phase));
const filesOf = (step) => state.runJobs?.find((j) => j.id === step.job)?.files.find((f) => f.name === step.file) ?? null;

function feed(ev) {
    const tr = state.tracker;
    if (!tr) return;
    const out = track(tr.t, ev);
    if (!out) return;
    const run = state.run;
    const step = run && stepOf(run, tr.step);
    if (!step) { state.tracker = null; return; }
    if (out.kind === 'started') {
        if (step.status !== 'active') startStep(run, step.id);
        saveRun(true);
        render();
    } else if (out.kind === 'progress') {
        if (progressStep(run, step.id, out.line)) saveRun();
        renderProgress();
    } else if (out.kind === 'paused' || out.kind === 'resumed') {
        saveRun(true);
        render();
    } else if (out.kind === 'end') {
        endStep(run, step.id, out);
        state.tracker = null;
        state.loaded = null;
        state.confirmed = false;
        saveRun(true);
        if (out.result === 'done') {
            const next = currentStep(run);
            setMsg('ok', next ? `✓ ${step.jobName} is done. Next: ${nextText(next)}.` : `✓ ${step.jobName} is done. That was the last job: the run is complete.`);
        } else {
            setMsg(null); // the step card says what happened
        }
    }
}

machine.addListener('workflow:state', (s) => {
    state.gs.workflow = s;
    // The user pressed gSender's own Start on the current step's file.
    if (s === 'running' && !state.tracker) adoptRunningJob();
    feed({ type: 'workflow', state: s });
    render();
});
machine.addListener('sender:status', (st) => {
    state.gs.sender = st ? { name: st.name, total: Number(st.total) || 0, received: Number(st.received) || 0 } : null;
    noteLoaded();
    feed({ type: 'sender', status: st });
});
machine.addListener('controller:state', (_type, st) => {
    const a = st?.status?.activeState ?? null;
    if (st?.status?.wpos) { state.gs.wpos = st.status.wpos; renderPos(); }
    if (state.motion && /^Alarm/i.test(a ?? '')) state.abort = true;
    if (a === state.gs.activeState) { feed({ type: 'controller', activeState: a }); return; }
    state.gs.activeState = a;
    state.gs.connected = true;
    feed({ type: 'controller', activeState: a });
    render();
});
machine.addListener('serialport:open', () => { state.gs.connected = true; render(); });
machine.addListener('serialport:close', () => {
    if (state.motion) state.abort = true;
    state.gs.connected = false;
    state.gs.activeState = null;
    state.loaded = null;
    feed({ type: 'close' });
    render();
});
machine.addListener('startup', () => feed({ type: 'startup' }));

/** Remembers that gSender has the current step's file, once its sender reports it. */
function noteLoaded() {
    const st = state.gs.sender;
    const step = state.run && currentStep(state.run);
    if (!st || !step) return;
    if (st.name === step.file && st.total > 0) {
        if (state.loaded?.name !== st.name || state.loaded.total !== st.total) { state.loaded = { step: step.id, name: st.name, total: st.total }; render(); }
    } else if (state.loaded && st.name && st.name !== state.loaded.name) {
        state.loaded = null; // something else was loaded into gSender
        render();
    }
}

function adoptRunningJob() {
    const step = state.run && currentStep(state.run);
    const st = state.gs.sender;
    if (!step || state.changed.has(step.id) || !st || st.name !== step.file) return;
    state.tracker = { step: step.id, t: createTracker(step.file, { total: st.total }) };
}

/** After opening a run: follow a job that is already running in gSender. */
async function attachToLiveJob() {
    const step = currentStep(state.run);
    if (!step || step.status !== 'active') return;
    try {
        const rs = await getReduxState();
        const wf = rs?.controller?.workflow?.state;
        const sender = rs?.controller?.sender?.status;
        if (sender?.name) state.gs.sender = { name: sender.name, total: Number(sender.total) || 0, received: Number(sender.received) || 0 };
        if ((wf === 'running' || wf === 'paused') && sender?.name === step.file) {
            const t = createTracker(step.file, { total: Number(sender.total) || 0 });
            t.phase = wf;
            t.received = Number(sender.received) || 0;
            state.tracker = { step: step.id, t };
            state.gs.workflow = wf;
        }
    } catch { /* outside gSender */ }
}

// ---------------------------------------------------------------------------
// Bit change and Zero Z (each motion starts from a click)
// ---------------------------------------------------------------------------

const REPLY_RE = /^(ok|error:\d+|ALARM:\d+)/;

/** One command and its reply lines (as in the Autoleveler: a probe waits for its [PRB:] report). */
async function sendLine(cmd, { probe = false, timeout = 10000 } = {}) {
    const r = await machine.query(cmd, { timeout, until: REPLY_RE, maxLines: 50 });
    let lines = r.lines;
    if (probe && !lines.some((l) => /^\[PRB:/.test(l)) && !lines.some((l) => /^(error:|ALARM:)/.test(l))) {
        const more = await machine.query('G4 P0', { timeout, until: REPLY_RE, maxLines: 50 });
        lines = lines.concat(more.lines);
    }
    if (!r.complete && !lines.some((l) => REPLY_RE.test(l))) throw new Error(`The machine didn't answer ${cmd} (${r.reason}).`);
    return lines;
}

const statusOf = async () => (await getReduxState())?.controller?.state?.status ?? {};

const machineIo = () => ({
    send: sendLine,
    probePin: async () => !!(await statusOf()).pinState?.P,
    readWorkZ: async () => {
        const st = await statusOf();
        const z = Number(st.wpos?.z);
        return st.activeState === 'Idle' && Number.isFinite(z) ? z : null;
    },
    readWorkXY: async () => {
        const st = await statusOf();
        const x = Number(st.wpos?.x);
        const y = Number(st.wpos?.y);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    },
    aborted: () => state.abort,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    status: (text) => { if (state.motion) { state.motion.status = text; render(); } },
});

/** Why the Runner can't move the machine now, in plain words; null when it can. */
function motionBlocker() {
    if (!state.gs.connected) return 'Connect to the machine in gSender first.';
    if (/^Alarm/i.test(state.gs.activeState ?? '')) return 'The machine is in alarm. Clear it in gSender (Unlock or Home) first.';
    if (state.gs.workflow !== 'idle') return 'gSender has a job open. Wait for it to end, or press Stop in gSender.';
    if (!state.gs.activeState) return 'Waiting for the machine to report its state.';
    if (state.gs.activeState !== 'Idle') return `The machine is not idle (${state.gs.activeState}).`;
    return null;
}

async function withMotion(step, what, label, fn) {
    const why = motionBlocker();
    if (why) { setMsg('warn', why); return false; }
    state.motion = { step: step.id, what, status: label };
    state.abort = false;
    setMsg(null);
    try {
        await machine.setBusy(true, `Project Runner: ${label}`).catch(() => {});
        await fn(machineIo());
        return true;
    } catch (e) {
        setMsg('err', state.abort ? 'Stopped. Check the machine and the bit, clear any alarm in gSender, then try again.' : e.message);
        return false;
    } finally {
        state.motion = null;
        machine.setBusy(false).catch(() => {});
        render();
    }
}

async function raiseZ(step) {
    const target = state.raise;
    let r = null;
    const ok = await withMotion(step, 'raise', `Raising Z to ${target} mm…`, async (io) => { r = await raiseForBitChange(io, { ...ZERO_DEFAULTS, raise: target }); });
    if (!ok || !r) return;
    state.raised = { step: step.id, z: r.z };
    setMsg('ok', r.moved ? `Z is at ${target} mm.` : `Z is already at ${fmtZ(r.z)} mm, above ${target}.`);
}
const fmtZ = (z) => String(Math.round(z * 10) / 10);

function setRaise(value) {
    state.raise = clampRaise(value);
    replaceStored('raise', state.raise);
    render();
}

async function zeroStep(step) {
    let result = null;
    const ok = await withMotion(step, 'zero', 'Zeroing Z…', async (io) => { result = await zeroZ(io, ZERO_DEFAULTS); });
    if (!ok || !state.run) return;
    finishBitStep(state.run, step.id, result);
    state.confirmed = false;
    saveRun(true);
    setMsg('ok', 'Z is zeroed on the copper at X0 Y0. Take the probe clip off the bit now.');
}

async function originStep(step) {
    let machinePos = null;
    const ok = await withMotion(step, 'origin', 'Setting X0 Y0…', async (io) => {
        await setXYOrigin(io);
        const st = await statusOf();
        if (st.mpos) machinePos = { x: Number(st.mpos.x), y: Number(st.mpos.y) };
    });
    if (!ok || !state.run) return;
    finishOriginStep(state.run, step.id, machinePos);
    saveRun(true);
    const next = currentStep(state.run);
    setMsg('ok', `X0 Y0 set.${next ? ` Next: ${nextText(next)}.` : ''}`);
}

/** Feed hold, then a soft reset: stops any motion at once (as the Autoleveler's Stop). */
async function stopMotion() {
    state.abort = true;
    try {
        await machine.command('feedhold');
        setTimeout(() => machine.command('reset').catch(() => {}), 400);
    } catch (e) { setMsg('err', e.message); }
}

function bitStage(step, stage) {
    setBitStage(state.run, step.id, stage);
    saveRun(true);
    setMsg(null);
}

function addBitChange(step) {
    const s = insertBitChange(state.run, step.id);
    if (!s) return;
    state.loaded = null;
    state.confirmed = false;
    saveRun(true);
    setMsg(null);
}

function dropBitChange(step) {
    if (!removeBitChange(state.run, step.id)) return;
    saveRun(true);
    render();
}

// ---------------------------------------------------------------------------
// Pause and G-code steps the user added
// ---------------------------------------------------------------------------

function finishCommand(step, text = null) {
    finishCommandStep(state.run, step.id);
    saveRun(true);
    const next = currentStep(state.run);
    setMsg('ok', [text, next ? `Next: ${nextText(next)}.` : 'That was the last step: the run is complete.'].filter(Boolean).join(' '));
}

async function sendGcodeStep(step) {
    const ok = await withMotion(step, 'gcode', 'Sending G-code…', (io) => runGcode(io, step.text));
    if (ok && state.run) finishCommand(step, 'G-code sent.');
}

/** What the next step asks for, for messages: "change to the 0.8 mm drill". */
function nextText(s) {
    if (s.kind === 'origin') return 'set X0 Y0';
    if (s.kind === 'bit') return `change to the ${s.bit?.name ?? 'next bit'}`;
    if (s.kind === 'note') return `a pause ("${s.text}")`;
    if (s.kind === 'gcode') return 'send your G-code';
    return s.jobName;
}

// ---------------------------------------------------------------------------
// Job actions (each one a click)
// ---------------------------------------------------------------------------

async function loadStep(step) {
    const f = filesOf(step);
    if (!f) { setMsg('err', 'This job\'s G-code is missing. Start a new run from the project file.'); return; }
    if (state.gs.workflow !== 'idle') { setMsg('warn', 'gSender is busy with a job. Wait until it has ended.'); return; }
    state.busy = `Loading ${step.file}…`;
    state.loaded = null;
    state.confirmed = false;
    render();
    try {
        await gcode.loadToVisualizer(f.gcode, step.file);
        // gSender's sender reports the file a moment later (see noteLoaded).
        await waitFor(() => state.loaded?.name === step.file, 5000);
        if (!state.loaded) setMsg('warn', 'gSender hasn\'t confirmed the file yet. Is the machine connected?');
        else setMsg(null);
    } catch (e) {
        setMsg('err', `Could not load into gSender: ${e.message}`);
    } finally {
        state.busy = null;
        render();
    }
}

/** Why Start is not possible right now, in plain words; null when it is. */
function startBlocker(step) {
    if (state.changed.has(step.id)) return 'This job\'s G-code changed since the run started.';
    if (!state.gs.connected) return 'Connect to the machine in gSender first.';
    if (/^Alarm/i.test(state.gs.activeState ?? '')) {
        return state.gs.workflow !== 'idle'
            ? 'The machine is in alarm. In gSender, press Stop, then Unlock (or Home).'
            : 'The machine is in alarm. Clear it in gSender (Unlock or Home) first.';
    }
    if (state.gs.workflow !== 'idle') return 'gSender still has a job open. Wait for it to end, or press Stop in gSender.';
    if (!state.gs.activeState) return 'Waiting for the machine to report its state.';
    if (state.gs.activeState !== 'Idle') return `The machine is not idle (${state.gs.activeState}).`;
    const f = filesOf(step);
    if (!state.loaded || state.loaded.step !== step.id) return 'Load the job into gSender first.';
    // gSender counts the file's non-empty lines plus one line it appends.
    if (f && state.loaded.total !== f.lines && state.loaded.total !== f.lines + 1) {
        return `gSender has ${state.loaded.total} lines but the job has ${f.lines}. Load it again.`;
    }
    if (needsBitConfirm(state.run, step.id) && !state.confirmed) return 'Tick the box first.';
    return null;
}

async function startJob(step) {
    const why = startBlocker(step);
    if (why) { setMsg('warn', why); return; }
    state.busy = 'Starting…';
    state.tracker = { step: step.id, t: createTracker(step.file, { total: state.loaded.total }) };
    startStep(state.run, step.id);
    await saveRun(true);
    render();
    try {
        await machine.command('gcode:start');
        const ok = await waitFor(() => state.tracker?.t.phase !== 'armed', 8000);
        if (!ok && state.tracker?.t.phase === 'armed') {
            state.tracker = null;
            retryStep(state.run, step.id);
            saveRun(true);
            setMsg('err', 'gSender did not start the job. Check gSender for a message, then try again.');
        }
    } catch (e) {
        state.tracker = null;
        retryStep(state.run, step.id);
        saveRun(true);
        setMsg('err', `Could not start: ${e.message}`);
    } finally {
        state.busy = null;
        render();
    }
}

const command = (cmd, ...args) => machine.command(cmd, ...args).catch((e) => setMsg('err', `${cmd}: ${e.message}`));
const pauseJob = () => command('gcode:pause');
const resumeJob = () => command('gcode:resume');
const stopJob = () => command('gcode:stop', { force: true });

function stepAction(fn, step, text) {
    fn(state.run, step.id);
    state.loaded = null;
    state.confirmed = false;
    saveRun(true);
    setMsg(text ? 'ok' : null, text);
}

function waitFor(cond, ms) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
            if (cond()) resolve(true);
            else if (Date.now() - t0 > ms) resolve(false);
            else setTimeout(tick, 100);
        };
        tick();
    });
}

async function refreshToolChangeOption() {
    try { state.toolChangeOption = (await getWorkspaceState())?.toolChangeOption ?? null; } catch { /* outside gSender */ }
}

// ---------------------------------------------------------------------------
// Rendering. The panel is small and is rebuilt on meaningful changes only;
// line progress during a job is updated in place (renderProgress).
// ---------------------------------------------------------------------------

let renderQueued = false;
function render() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
        renderQueued = false;
        if (dragId) { renderAfterDrag = true; return; } // a rebuild would cancel the drag
        // Keep the cursor in a text field across a rebuild.
        const act = document.activeElement;
        const keep = act?.id && 'selectionStart' in act ? { id: act.id, a: act.selectionStart, b: act.selectionEnd } : null;
        $('#root').replaceChildren(...[header(), wizardBar(), message(), state.busy ? h('div', { className: 'msg' }, state.busy) : null, body()].flat().filter(Boolean));
        const el = keep && document.getElementById(keep.id);
        if (el) { el.focus(); try { el.setSelectionRange(keep.a, keep.b); } catch { /* not a text field */ } }
        if (focusNext) { document.getElementById(focusNext)?.focus(); focusNext = null; }
        if (afterRender) { const f = afterRender; afterRender = null; f(); }
    });
}
let focusNext = null;
let renderAfterDrag = false;
let afterRender = null; // runs once after the next rebuild (drop animation)

function header() {
    const title = state.run ? state.run.project.name : state.doc ? state.doc.project.name : 'Project Runner';
    return h('div', { className: 'head' },
        h('div', { className: 'title', title }, title),
        connBadge(),
        state.doc && !state.run ? h('button', { className: 'icon close', title: 'Close this project', onClick: closeProject }, '✕') : null);
}

function connBadge() {
    const { connected, activeState, workflow } = state.gs;
    const text = !connected ? 'Not connected' : workflow !== 'idle' ? `Job ${workflow}` : activeState || 'No status';
    const kind = !connected ? 'off' : /^Alarm/i.test(activeState ?? '') ? 'bad' : 'on';
    return h('span', { className: `conn ${kind}` }, text);
}

function message() {
    return state.msg ? h('div', { className: `msg ${state.msg.kind}` }, state.msg.text) : null;
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

const WIZARD = [
    { key: 'jobs', label: 'Pick jobs', text: 'Choose what to cut.' },
    { key: 'order', label: 'Order', text: 'Drag into order. Bit changes are added for you.' },
    { key: 'run', label: 'Run', text: 'Follow each step. Progress is saved.' },
];

const wizardAt = () => (state.run ? 'run' : state.doc ? state.view : null);

function wizardBar() {
    const at = wizardAt();
    if (!at) return null;
    const k = WIZARD.findIndex((w) => w.key === at);
    return h('ol', { className: 'wizard' }, WIZARD.map((w, i) => {
        const done = i < k;
        const locked = done && state.run && runStarted(state.run);
        const go = !done ? null : state.run ? () => backFromRun(w.key) : () => goTo(w.key);
        return h('li', { className: `${done ? 'done' : i === k ? 'current' : ''} ${locked ? 'locked' : ''}` },
            h(go ? 'button' : 'span', { className: 'wstep', onClick: go, title: locked ? 'The run has started, so setup can\'t change' : go ? `Back to ${w.label}` : null },
                h('span', { className: 'n' }, done ? '✓' : String(i + 1)),
                h('span', { className: 'l' }, w.label)));
    }));
}

function goTo(view) {
    if (view === 'order' && !state.ids.length) { setMsg('warn', 'Tick at least one job first.'); return; }
    Object.assign(state, { view, adding: null, msg: null });
    render();
}

function body() {
    if (state.run) return runView();
    if (state.doc) return state.view === 'order' ? orderView() : jobsView();
    return welcomeView();
}

function welcomeView() {
    const p = state.lastPointer;
    return h('div', { className: 'welcome' },
        state.reopen ? h('div', { className: 'card' },
            h('div', {}, 'Continue the run in ', b(state.reopen.name), '?'),
            h('div', { className: 'row' }, button('Continue run', reopenSaved, { kind: 'primary' }))) : null,
        h('p', { className: 'lead' }, 'Cut a whole board, one guided step at a time.'),
        h('ol', { className: 'intro' }, WIZARD.map((w, i) => h('li', {},
            h('span', { className: 'n' }, String(i + 1)),
            h('b', {}, w.label),
            h('span', { className: 'd' }, w.text)))),
        h('div', { className: 'drop' },
            button('Open project…', openFile, { kind: 'primary', disabled: !!state.busy, title: 'Open a PCB CAM project (.pcbcam.json), or a run file (.pcbrun.json) to continue a run' }),
            h('div', { className: 'note' }, 'or drop a .pcbcam.json file here')),
        h('div', { className: 'before' },
            h('b', {}, 'Before you start'),
            h('ul', {},
                h('li', {}, 'Jobs checked and saved in PCB CAM.'),
                h('li', {}, 'Board clamped flat.'),
                h('li', {}, 'Bits and probe clip at hand.'))),
        !state.reopen && p ? h('p', { className: 'note' }, `Last run: ${p.name}, step ${p.step} of ${p.steps}${p.fileName ? ` (${p.fileName})` : ''}. Open its run file to continue.` ) : null);
}

async function reopenSaved() {
    const handle = state.reopen;
    try {
        const perm = await writePermission(handle, true);
        if (perm === 'denied') { setMsg('err', 'gSender did not allow access to the run file. Open it with Open project….'); return; }
        await openRun(handle, await readText(handle));
    } catch (e) {
        state.reopen = null;
        savedHandle.set(null);
        setMsg('err', `Could not open the run file: ${e.message}. Open it with Open project….`);
    }
}

const STATUS_BADGE = { ready: 'Ready', 'not-reviewed': 'Not checked', 'out-of-date': 'Out of date', 'multi-bit': 'Several bits', error: 'Can\'t make' };
const jobBits = (j) => [...new Map(j.files.flatMap((f) => f.bits).map((x) => [x.id, x])).values()];
/** A row of small figures, e.g. 3 Jobs · 2 Bit changes · ~13 min. @param {[value, label, title?][]} items */
const stats = (items) => h('div', { className: 'stats' }, items.map(([v, label, title]) => h('div', { className: 'stat', title },
    h('b', {}, String(v)), h('span', {}, label))));
const cutTime = (m) => (!m ? '0 min' : m < 1 ? '<1 min' : m < 60 ? `~${Math.round(m)} min` : `~${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Step 1: tick the jobs to cut, in project order. */
function jobsView() {
    const jobs = state.jobs;
    const sel = new Set(state.ids);
    const total = jobs.filter((j) => sel.has(j.id)).reduce((a, j) => a + (j.minutes ?? 0), 0);
    const ready = jobs.filter((j) => j.status === 'ready');
    return h('div', {},
        h('p', { className: 'note' }, 'Tick the jobs to cut.'),
        ready.length > 1 ? h('div', { className: 'row end' },
            h('button', { className: 'link', onClick: () => { state.ids = jobs.filter((j) => j.status === 'ready').map((j) => j.id); render(); } }, 'Select all'),
            h('button', { className: 'link', onClick: () => { state.ids = []; render(); } }, 'Select none')) : null,
        h('ul', { className: 'jobs' }, jobs.map((j) => {
            const on = sel.has(j.id);
            const isReady = j.status === 'ready';
            return h('li', { className: `job ${on ? 'on' : ''} ${isReady ? '' : 'blocked'}` },
                h('label', { className: 'pick' },
                    h('input', { type: 'checkbox', checked: on, disabled: !isReady && !on, onChange: () => { state.ids = toggleJob(jobs, state.ids, j.id); render(); } }),
                    h('span', { className: 'name', title: j.name }, j.name)),
                h('span', { className: `badge ${isReady ? 'ready' : 'bad'}` }, STATUS_BADGE[j.status] ?? j.status),
                h('div', { className: 'meta' }, [j.what, jobBits(j).map(bitLabel).join(', '), minutes(j.minutes)].filter(Boolean).join(' · ')),
                j.message ? h('div', { className: `why ${isReady ? '' : 'err'}` }, j.message) : null);
        })),
        !ready.length ? h('div', { className: 'msg err' }, 'No job can run yet. Check the jobs in PCB CAM, save, and open again.') : null,
        stats([
            [state.ids.length, state.ids.length === 1 ? 'Job' : 'Jobs'],
            [new Set(jobs.filter((j) => sel.has(j.id)).flatMap((j) => jobBits(j).map((x) => x.id))).size, 'Bits', 'Different bits these jobs use'],
            [cutTime(total), 'Cutting', 'Estimated cutting time, without bit changes'],
        ]),
        h('div', { className: 'row' },
            button('Back', closeProject, { kind: 'grow0', title: 'Choose another file' }),
            button('Next: order →', () => goTo('order'), { kind: 'primary', disabled: !state.ids.length || !!state.busy })));
}

// --- Step 2: order (drag and drop) and the commands around each job ---------

// While a job is dragged its box is lifted out of the list and a dashed slot
// shows where it will land. On drop the other jobs slide to their new places
// and the dropped box ripples, so the move is easy to see.
let dragId = null;  // job being dragged
let dropAt = null;  // { target, after } where the slot is, or null at the job's own place
let slot = null;    // the slot element, only while dragging

const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function dropSide(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
}

function placeSlot(target, after) {
    const moved = reorderJob(state.ids, dragId, target, after);
    const el = document.querySelector(`.block[data-id="${CSS.escape(target)}"]`);
    if (!el) return;
    if (moved.join('\n') === state.ids.join('\n')) {
        // Back at its own place.
        dropAt = null;
        document.querySelector(`.block[data-id="${CSS.escape(dragId)}"]`)?.before(slot);
        return;
    }
    dropAt = { target, after };
    if (after) (el.nextElementSibling?.classList.contains('addform') ? el.nextElementSibling : el).after(slot);
    else (el.previousElementSibling?.classList.contains('auto') ? el.previousElementSibling : el).before(slot);
}

function endDrag() {
    slot?.remove();
    slot = null;
    dragId = null;
    dropAt = null;
    document.querySelector('.seq')?.classList.remove('sorting');
    for (const el of document.querySelectorAll('.block.lifted')) el.classList.remove('lifted');
    if (renderAfterDrag) { renderAfterDrag = false; render(); }
}

/** Drops the job at the slot: the list is rebuilt, then animated from the old places. */
function commitDrop() {
    if (!dragId) return;
    const id = dragId;
    const at = dropAt;
    const before = blockTops();
    if (slot) before.set(id, slot.getBoundingClientRect().top);
    endDrag();
    if (!at) return;
    moveAnimated(id, reorderJob(state.ids, id, at.target, at.after), before);
}

const blockTops = () => new Map([...document.querySelectorAll('.block[data-id]')].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));

/** Applies a new order, then slides every box from its old place (`before`) and ripples job `id`. */
function moveAnimated(id, ids, before = blockTops()) {
    if (ids.join('\n') === state.ids.join('\n')) return;
    state.ids = ids;
    afterRender = () => {
        if (calm()) return;
        for (const el of document.querySelectorAll('.block[data-id]')) {
            const dy = (before.get(el.dataset.id) ?? 0) - el.getBoundingClientRect().top;
            if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' });
        }
        const dropped = document.querySelector(`.block[data-id="${CSS.escape(id)}"]`);
        if (!dropped) return;
        dropped.classList.add('dropped');
        setTimeout(() => dropped.classList.remove('dropped'), 1100);
    };
    render();
}

const dragProps = (id) => ({
    draggable: true,
    'data-id': id,
    onDragstart: (e) => {
        if (e.target.closest?.('button, input, textarea')) { e.preventDefault(); return; }
        const el = e.currentTarget;
        dragId = id;
        dropAt = null;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        slot = h('li', { className: 'slot', onDragover: (ev) => { if (dragId) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; } }, onDrop: (ev) => { ev.preventDefault(); ev.stopPropagation(); commitDrop(); } },
            `Drop ${state.jobs.find((j) => j.id === id)?.name ?? 'the job'} here`);
        slot.style.height = `${el.offsetHeight}px`;
        // Lift the box after the browser has taken its drag picture.
        setTimeout(() => {
            if (dragId !== id) return;
            el.before(slot);
            el.classList.add('lifted');
            document.querySelector('.seq')?.classList.add('sorting');
        }, 0);
    },
    onDragend: () => endDrag(),
    onDragover: (e) => {
        if (!dragId || !slot) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (id !== dragId) placeSlot(id, dropSide(e));
    },
    onDrop: (e) => {
        if (!dragId) return;
        e.preventDefault();
        e.stopPropagation();
        commitDrop();
    },
});

function commandsOf(id) {
    return state.commands[id] ?? { before: [], after: [] };
}

function openAdd(job, where) {
    state.adding = { job, where, type: state.adding?.type ?? 'note', text: '', error: null };
    focusNext = 'cmdtext';
    render();
}

function addCommand() {
    const a = state.adding;
    const cmd = makeCommand(a.type, a.text, `c${++state.cmdSeq}`);
    const problem = commandProblem(cmd);
    if (problem) { a.error = problem; render(); return; }
    const c = commandsOf(a.job);
    state.commands[a.job] = { ...c, [a.where]: [...c[a.where], cmd] };
    state.adding = null;
    render();
}

function removeCommand(job, where, cmdId) {
    const c = commandsOf(job);
    state.commands[job] = { ...c, [where]: c[where].filter((x) => x.id !== cmdId) };
    render();
}

/** What a command does, in a few words. */
function commandText(c) {
    if (c.type === 'bit') return 'Change the bit, zero Z';
    if (c.type === 'note') return c.text;
    const lines = c.text.split('\n').filter((l) => l.trim());
    return lines.length > 1 ? `${lines[0]}  (+${lines.length - 1} more)` : lines[0];
}

function commandChip(job, where, c) {
    return h('div', { className: `chip ${c.type}` },
        h('span', { className: 'g', title: COMMAND_TYPES[c.type].short }, COMMAND_TYPES[c.type].glyph),
        h('span', { className: 't', title: c.text || COMMAND_TYPES[c.type].label }, commandText(c)),
        h('button', { className: 'icon', title: `Remove this ${COMMAND_TYPES[c.type].short.toLowerCase()}`, onClick: () => removeCommand(job, where, c.id) }, '✕'));
}

function addForm(job) {
    const a = state.adding;
    const field = a.type === 'note'
        ? h('input', { id: 'cmdtext', type: 'text', value: a.text, maxLength: 200, placeholder: 'e.g. Switch the router on', onInput: (e) => { a.text = e.target.value; }, onKeydown: (e) => { if (e.key === 'Enter') addCommand(); } })
        : a.type === 'gcode'
            ? h('textarea', { id: 'cmdtext', rows: 3, value: a.text, placeholder: 'e.g. M8', spellcheck: false, onInput: (e) => { a.text = e.target.value; } })
            : null;
    const help = {
        bit: 'Swap or re-seat the bit, then zero Z. For a fresh bit or a Z re-check.',
        note: 'The run waits until you click Done.',
        gcode: 'Sent when you click Send. No tool changes, probing or offsets.',
    }[a.type];
    return h('li', { className: 'addform' },
        h('div', { className: 'af-head' }, `Add ${a.where} `, b(job.name)),
        h('div', { className: 'seg' }, Object.entries(COMMAND_TYPES).map(([t, v]) => h('button', {
            className: `segb ${a.type === t ? 'on' : ''}`,
            onClick: () => { Object.assign(a, { type: t, error: null }); focusNext = 'cmdtext'; render(); },
        }, `${v.glyph} ${v.short}`))),
        field,
        h('div', { className: 'note' }, help),
        a.error ? h('div', { className: 'msg err' }, a.error) : null,
        h('div', { className: 'row' },
            button('Cancel', () => { state.adding = null; render(); }, { kind: 'grow0' }),
            button('Add', addCommand, { kind: 'primary' })));
}

function autoBitRow(step) {
    return h('li', { className: 'auto', title: 'Added because the bit changes here. It moves with the jobs.' },
        h('span', { className: 'g' }, '⇄'),
        h('span', { className: 't' }, `Change to ${bitLabel(step.bit)}, zero Z`),
        h('span', { className: 'tag' }, 'automatic'));
}

function jobBlock(job, i, n) {
    const c = commandsOf(job.id);
    const move = (dir) => moveAnimated(job.id, moveJob(state.ids, job.id, dir));
    return h('li', { className: 'block', ...dragProps(job.id) },
        c.before.map((x) => commandChip(job.id, 'before', x)),
        h('div', { className: 'jobline' },
            h('span', { className: 'grip', title: 'Drag to move' }, '⠿'),
            h('span', { className: 'num' }, `${i + 1}`),
            h('div', { className: 'jt' },
                h('b', { title: job.name }, job.name),
                h('div', { className: 'meta' }, [job.what, jobBits(job).map((x) => x.name).join(' + '), job.files.length > 1 ? plural(job.files.length, 'file') : '', minutes(job.minutes)].filter(Boolean).join(' · '))),
            h('span', { className: 'move' },
                h('button', { className: 'icon', title: 'Earlier', disabled: i === 0, onClick: () => move(-1) }, '▲'),
                h('button', { className: 'icon', title: 'Later', disabled: i === n - 1, onClick: () => move(1) }, '▼'))),
        c.after.map((x) => commandChip(job.id, 'after', x)),
        h('div', { className: 'adds' },
            h('button', { className: 'link', onClick: () => openAdd(job.id, 'before'), title: 'Add a pause, G-code or a bit change before this job' }, '+ Before'),
            h('button', { className: 'link', onClick: () => openAdd(job.id, 'after'), title: 'Add a pause, G-code or a bit change after this job' }, '+ After')));
}

/** Step 2: the jobs in run order, with the steps around them. */
function orderView() {
    const byId = new Map(state.jobs.map((j) => [j.id, j]));
    const sel = state.ids.map((id) => byId.get(id)).filter(Boolean);
    const steps = planSteps(state.jobs, state.ids, state.commands);
    const warnings = [...selectionWarnings(state.jobs, state.ids), ...planWarnings(steps)];
    const auto = new Map(steps.filter((s) => s.kind === 'bit' && s.auto).map((s) => [s.id, s]));
    const total = sel.reduce((a, j) => a + (j.minutes ?? 0), 0);
    const bitChanges = steps.filter((s) => s.kind === 'bit').length;
    const blocked = warnings.some((w) => w.severity === 'error');
    return h('div', {},
        h('p', { className: 'note' }, 'Drag to reorder (top runs first). ', b('+ Before'), ' / ', b('+ After'), ' add a pause, G-code or bit change.'),
        h('ol', { className: 'seq' },
            h('li', { className: 'auto first', title: 'Every run starts here' }, h('span', { className: 'g' }, '⌖'), h('span', { className: 't' }, 'Set X0 Y0 at the board corner'), h('span', { className: 'tag' }, 'first')),
            sel.map((j, i) => [
            auto.has(`bit@${j.id}#1`) ? autoBitRow(auto.get(`bit@${j.id}#1`)) : null,
            jobBlock(j, i, sel.length),
            state.adding?.job === j.id ? addForm(j) : null,
        ])),
        warnings.length ? h('div', {}, warnings.map((w) => h('div', { className: `msg ${w.severity === 'error' ? 'err' : 'warn'}` }, w.message))) : null,
        stats([
            [sel.length, sel.length === 1 ? 'Job' : 'Jobs'],
            [bitChanges, bitChanges === 1 ? 'Bit change' : 'Bit changes'],
            [steps.length + 1, 'Steps', 'Everything you\'ll be asked to do, in order'],
            [cutTime(total), 'Cutting', 'Estimated cutting time, without bit changes'],
        ]),
        h('div', { className: 'row' },
            button('Back', () => goTo('jobs'), { kind: 'grow0' }),
            button('Start run…', startRun, { kind: 'primary', disabled: !!state.busy || blocked, title: 'Choose where to save the run file, then follow the steps' })),
        fileApi ? null : h('div', { className: 'msg warn' }, 'This gSender can\'t save files: the run is lost when it closes.'));
}

// --- Step 3: run -----------------------------------------------------------

const GLYPH = { pending: '○', active: '●', done: '✓', skipped: '⤼', failed: '✗', cancelled: '■' };

function runView() {
    const run = state.run;
    const cur = currentStep(run);
    const jobs = run.steps.filter((s) => s.kind === 'run');
    const count = (st) => jobs.filter((s) => s.status === st).length;
    return h('div', {},
        !runStarted(run) && !isRunning() ? h('div', { className: 'note' }, 'Nothing has run yet: you can still go back.') : null,
        state.confirmRestart ? restartCard() : cur ? stepCard(cur) : h('div', { className: 'card done' }, h('div', { className: 'big' }, '✓ Run complete'),
            h('div', { className: 'note' }, `${count('done')} job${count('done') === 1 ? '' : 's'} done, ${count('skipped')} skipped. Switch the spindle off and take the board out.`)),
        h('ol', { className: 'steps' }, run.steps.map((s, i) => stepRow(s, i, cur))),
        h('div', { className: 'foot' },
            fileState(),
            h('span', { className: 'links' },
                h('button', { className: 'link', onClick: () => { state.showHistory = !state.showHistory; render(); } }, state.showHistory ? 'Hide history' : 'History'),
                runStarted(run) ? h('button', { className: 'link', disabled: isRunning(), onClick: () => { state.confirmRestart = true; setMsg(null); }, title: 'Start this run again from step 1' }, 'Restart') : null,
                h('button', { className: 'link', disabled: isRunning(), onClick: endRun, title: 'Close this run (the run file stays on disk)' }, 'Close run'))),
        state.showHistory ? historyView() : null);
}

function stepRow(s, i, cur) {
    const run = state.run;
    const open = !['done', 'skipped', 'active'].includes(s.status);
    const prev = run.steps[i - 1];
    // A bit change can be added before a job that hasn't run, unless one is waiting there already.
    const canAdd = !isRunning() && s.kind === 'run' && open && !(prev?.kind === 'bit' && !['done', 'skipped'].includes(prev.status));
    const canDrop = !isRunning() && s.kind === 'bit' && !s.auto && s.status === 'pending' && s.stage === 'change';
    const name = {
        origin: () => 'Set X0 Y0',
        bit: () => `Change bit, zero Z${s.bit ? `: ${s.bit.name}` : ''}`,
        note: () => `Pause: ${s.text}`,
        gcode: () => `G-code: ${commandText({ type: 'gcode', text: s.text })}`,
    }[s.kind]?.() ?? s.jobName;
    const meta = s.kind === 'run'
        ? [s.bit ? `T${s.bit.toolNumber}` : '', s.status === 'done' ? clock(s.endedAt) : minutes(s.minutes)].filter(Boolean).join(' · ')
        : [s.kind === 'bit' && !s.auto ? 'added' : '', s.status === 'done' ? clock(s.endedAt) : ''].filter(Boolean).join(' · ');
    const pendingGlyph = { origin: '⌖', bit: '⇄', note: '⏸', gcode: '›' }[s.kind];
    return h('li', { className: `step ${s.kind} ${s.status} ${s === cur ? 'current' : ''}` },
        h('span', { className: 'glyph', title: s.status }, pendingGlyph && s.status === 'pending' ? pendingGlyph : GLYPH[s.status]),
        h('span', { className: 'name', title: name }, `${i + 1}. ${name}`),
        h('span', { className: 'meta' }, meta),
        canAdd ? h('button', { className: 'icon', title: 'Change or re-zero the bit before this job', onClick: () => addBitChange(s) }, '+⇄') : null,
        canDrop ? h('button', { className: 'icon', title: 'Remove this bit change', onClick: () => dropBitChange(s) }, '✕') : null);
}

function bitCard(step) {
    const run = state.run;
    const n = run.steps.indexOf(step) + 1;
    const bit = step.bit ? bitLabel(step.bit) : 'the bit for the next job';
    const head = h('div', { className: 'card-head' }, h('span', {}, `Step ${n} of ${run.steps.length}`), h('b', {}, step.stage === 'zero' ? 'Zero Z' : 'Change the bit'));
    const m = state.motion?.step === step.id ? state.motion : null;
    const why = motionBlocker();
    const prevBit = run.steps.slice(0, n - 1).reverse().find((s) => s.bit && (s.kind === 'run' || s.status === 'done'))?.bit;
    const same = prevBit && step.bit && prevBit.id === step.bit.id;

    if (m) {
        return h('div', { className: 'card live' }, head,
            h('div', {}, m.status),
            h('div', { className: 'row' }, button('Stop', stopMotion, { kind: 'danger', title: 'Stops the machine at once (feed hold, then reset)' })));
    }

    if (step.stage === 'change') {
        return h('div', { className: 'card' }, head,
            h('div', { className: 'bit' }, same ? ['Put in a fresh ', b(bit), ' (or take the old one out, check it, and put it back).'] : ['Put in ', b(bit), '.']),
            h('ol', { className: 'todo' },
                h('li', {}, 'Raise Z to reach the collet (spindle stops first).'),
                h('li', {}, prevBit && !same ? ['Take out the ', b(prevBit.name), ', put in the ', b(step.bit?.name ?? 'new bit'), ' and tighten the collet.'] : ['Put in the ', b(step.bit?.name ?? 'bit'), ' and tighten the collet.'])),
            h('div', { className: 'row' },
                h('div', { className: 'raise' },
                    button('Raise Z to', () => raiseZ(step), { disabled: !!why, title: why ?? 'Spindle off, then Z up to this height above the copper' }),
                    h('label', { title: `Height above the copper (work Z), ${ZERO_LIMITS.raise[0]}–${ZERO_LIMITS.raise[1]} mm. Never moves down.` },
                        h('input', { id: 'raisemm', type: 'number', min: ZERO_LIMITS.raise[0], max: ZERO_LIMITS.raise[1], step: 1, value: state.raise, onChange: (e) => setRaise(e.target.value) }), 'mm')),
                button('The bit is in', () => bitStage(step, 'zero'), { kind: 'primary' })),
            why ? h('div', { className: 'note' }, why) : null,
            h('div', { className: 'row end' }, h('button', { className: 'link', onClick: () => stepAction(skipStep, step, 'Bit change skipped. You\'ll confirm the bit and Z by hand before the job.'), title: 'Skip the guided bit change' }, 'This bit is already in and Z is zeroed')));
    }

    return h('div', { className: 'card' }, head,
        h('div', { className: 'bit' }, ['Zero Z for ', b(bit), ' on the copper at X0 Y0.']),
        h('ol', { className: 'todo' },
            h('li', {}, 'Clip the probe lead to the board\'s copper, and the probe clip onto the bit.'),
            h('li', {}, `Bit tip clear of clamps, at most ${ZERO_DEFAULTS.maxTravel} mm above the copper. It moves to X0 Y0, then lowers until it touches.`),
            h('li', {}, 'When asked, touch bit and copper with a screwdriver to test the clip.')),
        h('div', { className: 'row' },
            button('Back', () => bitStage(step, 'change'), { kind: 'grow0' }),
            button('Zero Z', () => zeroStep(step), { kind: 'primary', disabled: !!why, title: why ?? 'Moves to X0 Y0 and probes the copper' })),
        state.raised?.step === step.id && state.raised.z > ZERO_DEFAULTS.maxTravel - 5
            ? h('div', { className: 'msg warn' }, `Z is at ${fmtZ(state.raised.z)} mm. Jog down to about 10 mm first.`) : null,
        why ? h('div', { className: 'note' }, why) : null);
}

const fmtPos = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '–');
const posText = () => (state.gs.wpos ? `X ${fmtPos(state.gs.wpos.x)}   Y ${fmtPos(state.gs.wpos.y)}` : 'X –   Y –');

/** Updates the live position in place (status reports come several times a second). */
let posQueued = false;
function renderPos() {
    if (posQueued) return;
    posQueued = true;
    setTimeout(() => {
        posQueued = false;
        const el = $('#wpos');
        if (el) el.textContent = posText();
    }, 250);
}

function originCard(step) {
    const run = state.run;
    const n = run.steps.indexOf(step) + 1;
    const head = h('div', { className: 'card-head' }, h('span', {}, `Step ${n} of ${run.steps.length}`), h('b', {}, 'Set X0 Y0'));
    const m = state.motion?.step === step.id ? state.motion : null;
    if (m) return h('div', { className: 'card live' }, head, h('div', {}, m.status));
    const why = motionBlocker();
    return h('div', { className: 'card' }, head,
        h('ol', { className: 'todo' },
            h('li', {}, 'Jog the bit tip over the board\'s front-left corner (gSender\'s jog controls).'),
            h('li', {}, 'Press ', b('Set X0 Y0 here'), '. Z is not changed.')),
        h('div', { className: 'pos' }, h('span', {}, 'Now at'), h('code', { id: 'wpos' }, posText())),
        h('div', { className: 'row' }, button('Set X0 Y0 here', () => originStep(step), { kind: 'primary', disabled: !!why, title: why ?? 'Makes this spot X0 Y0' })),
        why ? h('div', { className: 'note' }, why) : null,
        h('div', { className: 'row end' }, h('button', { className: 'link', onClick: () => stepAction(skipStep, step, 'Kept the current X0 Y0.'), title: 'Keep the X0 Y0 already set in gSender' }, 'X0 Y0 is already set')));
}

function commandCard(step) {
    const run = state.run;
    const n = run.steps.indexOf(step) + 1;
    const head = h('div', { className: 'card-head' }, h('span', {}, `Step ${n} of ${run.steps.length}`), h('b', {}, step.kind === 'note' ? 'Pause' : 'Send G-code'));
    const skip = h('div', { className: 'row end' }, h('button', { className: 'link', onClick: () => stepAction(skipStep, step, 'Step skipped.') }, 'Skip this step'));
    if (step.kind === 'note') {
        return h('div', { className: 'card' }, head,
            h('div', { className: 'big-note' }, step.text),
            h('div', { className: 'row' }, button('Done, continue', () => finishCommand(step), { kind: 'primary' })));
    }
    const m = state.motion?.step === step.id ? state.motion : null;
    if (m) {
        return h('div', { className: 'card live' }, head,
            h('div', {}, m.status),
            h('div', { className: 'row' }, button('Stop', stopMotion, { kind: 'danger', title: 'Stops the machine at once (feed hold, then reset)' })));
    }
    const chk = checkGcode(step.text);
    const why = chk.ok ? motionBlocker() : chk.message;
    return h('div', { className: 'card' }, head,
        h('pre', { className: 'gcode' }, step.text),
        chk.moves ? h('div', { className: 'msg warn' }, 'These lines move the machine. Clear the path.') : null,
        chk.spindle ? h('div', { className: 'msg warn' }, 'These lines start the spindle. Hands clear.') : null,
        h('div', { className: 'row' }, button('Send', () => sendGcodeStep(step), { kind: 'primary', disabled: !!why, title: why ?? 'Sends these lines to the machine' })),
        why ? h('div', { className: 'note' }, why) : null,
        skip);
}

function stepCard(step) {
    if (step.kind === 'bit') return bitCard(step);
    if (step.kind === 'note' || step.kind === 'gcode') return commandCard(step);
    if (step.kind === 'origin') return originCard(step);
    const run = state.run;
    const n = run.steps.indexOf(step) + 1;
    const bit = step.bit ? bitLabel(step.bit) : 'the bit for this job';
    const head = h('div', { className: 'card-head' }, h('span', {}, `Step ${n} of ${run.steps.length}`), h('b', {}, step.jobName));
    const tr = state.tracker?.step === step.id ? state.tracker.t : null;

    if (state.changed.has(step.id)) {
        return h('div', { className: 'card err' }, head,
            h('div', {}, 'This job changed since the run started. Start a new run.'),
            h('div', { className: 'row' }, button('Skip this job', () => stepAction(skipStep, step), {})));
    }

    if (tr && (tr.phase === 'running' || tr.phase === 'paused')) {
        const paused = tr.phase === 'paused';
        return h('div', { className: 'card live' }, head,
            h('div', {}, paused ? 'Paused. ' : 'Running with ', paused ? 'Check gSender for the reason, then resume or stop.' : b(bit)),
            progressBar(step),
            h('div', { className: 'row' },
                paused ? button('Resume', resumeJob, { kind: 'primary' }) : button('Pause', pauseJob),
                button('Stop', stopJob, { kind: 'danger' })));
    }

    if (step.status === 'active') {
        // Was running when this panel (or gSender) closed; the outcome is unknown.
        return h('div', { className: 'card warn' }, head,
            h('div', {}, 'The Runner lost track of this job. Did it finish?'),
            h('div', { className: 'row' },
                button('It finished', () => stepAction(markDone, step, `${step.jobName} marked as done.`), { kind: 'primary' }),
                button('Run again', () => stepAction(retryStep, step)),
                button('Skip', () => stepAction(skipStep, step))));
    }

    if (step.status === 'failed' || step.status === 'cancelled') {
        return h('div', { className: `card ${step.status === 'failed' ? 'err' : 'warn'}` }, head,
            h('div', {}, step.status === 'failed' ? 'This job failed' : 'This job was stopped', step.line ? ` around line ${step.line} of ${step.lines}.` : '.', step.note ? ` ${step.note}` : ''),
            h('div', { className: 'note' }, 'Check the bit and clear any alarm. If the machine was reset, add a bit change to re-zero Z. Run again starts from line 1.'),
            /^Alarm/i.test(state.gs.activeState ?? '') ? h('div', { className: 'msg err' }, startBlocker(step)) : null,
            h('div', { className: 'row' },
                button('Run again', () => stepAction(retryStep, step), { kind: 'primary', title: 'Runs the job again from its first line' }),
                button('Mark as done', () => stepAction(markDone, step, `${step.jobName} marked as done.`)),
                button('Skip', () => stepAction(skipStep, step))));
    }

    // Pending: load, (confirm the bit), start.
    const loaded = state.loaded?.step === step.id;
    const why = startBlocker(step);
    const confirm = needsBitConfirm(run, step.id);
    const zeroed = bitStepFor(run, step.id);
    return h('div', { className: 'card' }, head,
        h('div', { className: 'bit' }, confirm
            ? [step.lastResult === 'failed' ? 'The last attempt failed, so Z may have moved. ' : 'No guided bit change for this job. ', 'Change the bit and zero Z here (', b('Change bit'), '), or confirm below that ', b(bit), ' is in and Z is zeroed.']
            : ['Bit: ', b(bit), `. Z zeroed at X0 Y0 at ${clock(zeroed?.endedAt)}.`]),
        h('ol', { className: 'todo' },
            h('li', { className: loaded ? 'ok' : '' }, loaded ? `Loaded into gSender (${state.loaded.total} lines). Check the toolpath in the visualizer.` : 'Load the job into gSender and check the toolpath in the visualizer.'),
            confirm
                ? h('li', {}, h('label', { className: 'chk' },
                    h('input', { type: 'checkbox', checked: state.confirmed, disabled: !loaded, onChange: (e) => { state.confirmed = e.target.checked; render(); } }),
                    h('span', {}, 'The ', b(bit), ' is in and Z is zeroed.')))
                : h('li', {}, 'Take the probe clip off the bit.'),
            h('li', {}, 'Start the job. Stay at the machine.')),
        h('div', { className: 'row' },
            button(loaded ? 'Load again' : 'Load into gSender', () => loadStep(step), { kind: loaded ? '' : 'primary', disabled: !!state.busy || state.gs.workflow !== 'idle' }),
            button('Start job', () => startJob(step), { kind: 'primary', disabled: !!state.busy || !!why, title: why ?? 'Starts the job in gSender' })),
        loaded && why ? h('div', { className: 'note' }, why) : null,
        h('div', { className: 'row end' },
            h('button', { className: 'link', onClick: () => addBitChange(step), title: 'Swap or re-seat the bit and zero Z at X0 Y0 before this job' }, 'Change bit'),
            h('button', { className: 'link', onClick: () => stepAction(skipStep, step, `${step.jobName} skipped.`) }, 'Skip this job')));
}

function progressBar(step) {
    const pct = step.lines ? Math.min(100, (100 * step.line) / step.lines) : 0;
    return h('div', { className: 'prog' },
        h('div', { className: 'progress' }, h('div', { id: 'bar', style: `width:${pct.toFixed(1)}%` })),
        h('div', { id: 'progtext', className: 'note' }, progressText(step)));
}
const progressText = (step) => `Line ${step.line} of ${step.lines} sent to the controller${step.startedAt ? ` · started ${clock(step.startedAt)}` : ''}`;

/** Updates the progress bar in place (sender:status arrives every 250 ms). */
let progressQueued = false;
function renderProgress() {
    if (progressQueued) return;
    progressQueued = true;
    setTimeout(() => {
        progressQueued = false;
        const step = state.tracker && stepOf(state.run, state.tracker.step);
        const bar = $('#bar');
        if (!step || !bar) return;
        bar.style.width = `${Math.min(100, (100 * step.line) / (step.lines || 1)).toFixed(1)}%`;
        $('#progtext').textContent = progressText(step);
    }, 500);
}

function fileState() {
    const f = state.file;
    if (!f) return null;
    const text = {
        saved: `Saved to ${f.name}`, saving: `Saving ${f.name}…`, error: `Could not save ${f.name}: ${f.error}`,
        paused: `${f.name}: click to allow saving`, memory: 'Not saved to a file',
    }[f.status];
    return h('span', { id: 'filestate', className: `file ${f.status}`, onClick: f.status === 'paused' || f.status === 'error' ? allowWrites : null }, text);
}
function renderFileState() {
    const el = $('#filestate');
    if (el) el.replaceWith(fileState());
}

function historyView() {
    const list = state.run.history.slice(-30).reverse();
    if (!list.length) return h('div', { className: 'note' }, 'No jobs have run yet.');
    return h('ul', { className: 'history' }, list.map((e) => h('li', { className: e.result },
        h('span', {}, `${clock(e.end)} ${e.job}`),
        h('span', { className: 'meta' }, [e.result, e.result !== 'done' && e.result !== 'skipped' && e.line ? `line ${e.line}/${e.lines}` : '', e.bit, e.note].filter(Boolean).join(' · ')))));
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function applyTheme(ws) {
    if (typeof ws?.enableDarkMode === 'boolean') document.documentElement.classList.toggle('dark', ws.enableDarkMode);
}

async function init() {
    render();
    try { subscribeWorkspaceState(applyTheme); } catch { /* outside gSender */ }
    try {
        const ctx = await machine.getContext();
        state.gs.connected = !!ctx?.connected;
    } catch { /* outside gSender */ }
    try {
        const rs = await getReduxState();
        const c = rs?.controller;
        if (c?.workflow?.state) state.gs.workflow = c.workflow.state;
        if (c?.state?.status?.activeState) state.gs.activeState = c.state.status.activeState;
        if (c?.state?.status?.wpos) state.gs.wpos = c.state.status.wpos;
        if (typeof rs?.connection?.isConnected === 'boolean') state.gs.connected = rs.connection.isConnected;
    } catch { /* outside gSender */ }
    try { state.lastPointer = (await storage.get('lastRun', null)) || null; } catch { /* outside gSender */ }
    try { state.raise = clampRaise((await storage.get('raise', null)) ?? ZERO_DEFAULTS.raise); } catch { /* outside gSender */ }
    // The run file opened earlier in this gSender session.
    const handle = await savedHandle.get();
    if (handle) {
        const perm = await writePermission(handle);
        if (perm === 'granted') {
            try { await openRun(handle, await readText(handle), { quiet: true }); } catch { state.reopen = handle; }
        } else if (perm === 'prompt') {
            state.reopen = handle;
        }
    }
    render();
}

window.addEventListener('pagehide', () => { if (saveTimer) saveRun(true); });

init();
