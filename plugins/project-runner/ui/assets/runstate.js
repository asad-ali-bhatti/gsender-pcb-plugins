// The run file (<board>.pcbrun.json): what is being run, how far it got, and
// the history of every attempt. Pure module; the page writes it to disk.
//
// It carries a copy of the project file, so a run can be continued after a
// gSender restart from this one file, and goes on with exactly the jobs that
// were checked when it started even if the project is edited meanwhile.

import { planSteps, bitStep, bitLabel } from './plan.js';
import { sameGrid, mapRange } from './level.js';
import { isComplete as mapComplete } from '../vendor/autoleveler/leveling.js';

export const RUN_FORMAT = 'pcb-project-run';
export const RUN_VERSION = 5;
export const HISTORY_LIMIT = 200;

export const STEP_STATUSES = ['pending', 'active', 'done', 'skipped', 'failed', 'cancelled'];
export const STEP_KINDS = ['origin', 'run', 'bit', 'note', 'gcode', 'probe'];
const FINISHED = new Set(['done', 'skipped']);

/** The first step of every run: jog to the board's corner and set X0 Y0 there. */
export const originStep = () => ({ id: 'origin', kind: 'origin', status: 'pending', startedAt: null, endedAt: null, note: null });

/**
 * A new run of the jobs `ids` (in that order). `jobs` are the inspected jobs
 * of `doc`; `commands` are the steps the user added around them (plan.js).
 */
export function createRun({ doc, fileName, jobs, ids, commands = {}, now = Date.now() }) {
    return {
        format: RUN_FORMAT,
        version: RUN_VERSION,
        createdAt: now,
        updatedAt: now,
        project: { name: doc.project.name, fileName: fileName ?? null, doc },
        selection: [...ids],
        commands,
        steps: [originStep(), ...planSteps(jobs, ids, commands)],
        map: null, // the height map (Autoleveler format, plus `origin`), once probing starts
        history: [],
    };
}

export const serializeRun = (run) => JSON.stringify(run);

/** @returns {{ ok: true, run: object } | { ok: false, message: string }} */
export function parseRun(text) {
    let run;
    try { run = JSON.parse(text); } catch (e) { return { ok: false, message: `This file isn't valid JSON (${e.message}).` }; }
    if (run?.format !== RUN_FORMAT) return { ok: false, message: 'This isn\'t a Project Runner run file (it ends in .pcbrun.json).' };
    if (!(run.version >= 1)) return { ok: false, message: 'This run file is damaged (no version).' };
    if (run.version > RUN_VERSION) return { ok: false, message: 'This run file was made by a newer Project Runner. Update the plugin to open it.' };
    if (!run.project?.doc?.project || !Array.isArray(run.steps)) return { ok: false, message: 'This run file is damaged (no project or steps).' };
    if (run.version < 2) migrateV1(run);
    run.version = RUN_VERSION; // versions 3 to 5 only added step kinds (and `map` in 5)
    run.map ??= null;
    for (const s of run.steps) {
        if (!s || typeof s.id !== 'string' || !STEP_STATUSES.includes(s.status) || !STEP_KINDS.includes(s.kind)) return { ok: false, message: 'This run file is damaged (a step is unreadable).' };
    }
    if (!Array.isArray(run.history)) run.history = [];
    return { ok: true, run };
}

/**
 * Version 1 marked bit changes with `bitChange` on the run step. Version 2 has
 * a bit-change step of its own before it; one whose job already ran counts as
 * done (the bit was changed by hand then).
 */
function migrateV1(run) {
    const steps = [];
    for (const s of run.steps) {
        if (s && s.kind === 'run' && s.bitChange) {
            const b = bitStep(s.bit, `bit@${s.id}`);
            if (s.status !== 'pending') Object.assign(b, { status: 'done', stage: 'zero', note: 'Changed by hand (older run file)' });
            steps.push(b);
        }
        if (s) { delete s.bitChange; s.lastResult ??= null; }
        steps.push(s);
    }
    run.steps = steps;
}

export const stepOf = (run, id) => run.steps.find((s) => s.id === id) ?? null;

/** The step to work on: the active one, else the first not finished. Null when the run is complete. */
export function currentStep(run) {
    return run.steps.find((s) => s.status === 'active') ?? run.steps.find((s) => !FINISHED.has(s.status)) ?? null;
}

/**
 * Whether anything has happened on the machine for this run: a step finished,
 * failed or is running, or a bit change got past swapping the bit. Until then
 * the user may go back and change the jobs and their order.
 */
export function runStarted(run) {
    const since = run.history.findLastIndex((e) => e.result === 'restarted');
    return run.history.length > since + 1 || run.steps.some((s) => (s.status !== 'pending' && !s.kept) || (s.kind === 'bit' && s.stage !== 'change'));
}

/**
 * Starts the run over: fresh steps from the same jobs, order and added steps.
 * The history stays, with a "Run restarted" entry. A complete height map is
 * kept (it is relative to the copper at X0 Y0; a moved X0 Y0 is caught before
 * a levelled job loads). `jobs` are the inspected jobs of run.project.doc.
 * Returns null when a job no longer matches the run.
 */
export function restartRun(run, jobs, now = Date.now()) {
    if (changedSteps({ ...run, steps: run.steps.map((s) => ({ ...s, status: 'pending' })) }, jobs).length) return null;
    run.steps = [originStep(), ...planSteps(jobs, run.selection, run.commands ?? {})];
    const probe = run.steps.find((s) => s.kind === 'probe');
    if (probe && mapComplete(run.map) && sameGrid(run.map, probe.grid)) {
        Object.assign(probe, { status: 'done', kept: true, startedAt: now, endedAt: now, note: 'Map kept from before the restart' });
    } else {
        run.map = null;
    }
    run.history.push({ step: null, job: 'Run restarted', file: null, bit: null, start: now, end: now, result: 'restarted', line: null, lines: null, note: null });
    if (run.history.length > HISTORY_LIMIT) run.history.splice(0, run.history.length - HISTORY_LIMIT);
    touch(run, now);
    return run;
}

export const isComplete = (run) => run.steps.every((s) => FINISHED.has(s.status));

export function summary(run) {
    const count = Object.fromEntries(STEP_STATUSES.map((k) => [k, 0]));
    for (const s of run.steps) count[s.status]++;
    return { total: run.steps.length, ...count, complete: isComplete(run) };
}

function touch(run, now) { run.updatedAt = now; }

const STEP_TITLES = { origin: 'Set X0 Y0', bit: 'Bit change', note: 'Pause', gcode: 'G-code', probe: 'Height map' };

function record(run, step, result, now, note = null) {
    run.history.push({
        step: step.id,
        job: STEP_TITLES[step.kind] ?? step.jobName,
        file: step.file ?? null,
        bit: step.bit ? bitLabel(step.bit) : null,
        start: step.startedAt,
        end: now,
        result,
        line: step.line ?? null,
        lines: step.lines ?? null,
        note,
    });
    if (run.history.length > HISTORY_LIMIT) run.history.splice(0, run.history.length - HISTORY_LIMIT);
}

/** The job was sent to the machine. */
export function startStep(run, id, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'run') return null;
    Object.assign(s, { status: 'active', attempts: s.attempts + 1, startedAt: now, endedAt: null, line: 0, note: null });
    touch(run, now);
    return s;
}

/** Lines acknowledged so far. Returns true when it changed. */
export function progressStep(run, id, line) {
    const s = stepOf(run, id);
    if (!s || s.status !== 'active' || !(line > s.line)) return false;
    s.line = Math.min(line, s.lines);
    return true;
}

/**
 * The attempt ended. `result`: 'done' | 'cancelled' | 'failed'.
 * @param {{ result: string, line?: number, note?: string }} outcome
 */
export function endStep(run, id, { result, line, note = null }, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'run' || !['done', 'cancelled', 'failed'].includes(result)) return null;
    if (Number.isFinite(line)) s.line = Math.min(Math.max(line, 0), s.lines);
    if (result === 'done') s.line = s.lines;
    Object.assign(s, { status: result, lastResult: result, endedAt: now, note });
    record(run, s, result, now, note);
    touch(run, now);
    return s;
}

/** The user chose not to run this step. */
export function skipStep(run, id, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.status === 'active' || FINISHED.has(s.status)) return null;
    Object.assign(s, { status: 'skipped', endedAt: now });
    record(run, s, 'skipped', now);
    touch(run, now);
    return s;
}

/** The user says an interrupted job did finish (e.g. it ended while the Runner was closed). */
export function markDone(run, id, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'run' || FINISHED.has(s.status)) return null;
    Object.assign(s, { status: 'done', endedAt: now, line: s.lines });
    record(run, s, 'done', now, 'Marked done by hand');
    touch(run, now);
    return s;
}

/** Back to pending so it can run again from the start. */
export function retryStep(run, id, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'run' || !['failed', 'cancelled', 'active', 'skipped'].includes(s.status)) return null;
    Object.assign(s, { status: 'pending', endedAt: null, line: 0, note: null });
    touch(run, now);
    return s;
}

/**
 * Steps whose regenerated G-code no longer matches what the run started with
 * (e.g. the plugin was updated meanwhile). Finished steps don't matter.
 * @param {object[]} jobs inspected jobs of run.project.doc
 */
export function changedSteps(run, jobs) {
    const files = new Map();
    for (const j of jobs) for (const f of j.files) files.set(`${j.id}|${f.name}`, f);
    return run.steps.filter((s) => s.kind === 'run' && !FINISHED.has(s.status) && files.get(`${s.job}|${s.file}`)?.hash !== s.hash).map((s) => s.id);
}

/** X0 Y0 was set at the board's corner. `machine` is the machine XY there, if known. */
export function finishOriginStep(run, id, machine = null, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'origin' || FINISHED.has(s.status)) return null;
    Object.assign(s, { status: 'done', endedAt: now, machine });
    s.startedAt ??= now;
    record(run, s, 'done', now);
    touch(run, now);
    return s;
}

/** A pause or G-code step the user added is done. */
export function finishCommandStep(run, id, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || !['note', 'gcode'].includes(s.kind) || FINISHED.has(s.status)) return null;
    Object.assign(s, { status: 'done', endedAt: now });
    s.startedAt ??= now;
    record(run, s, 'done', now, s.kind === 'gcode' ? s.text.split('\n')[0] : null);
    touch(run, now);
    return s;
}

// ---------------------------------------------------------------------------
// Height map
// ---------------------------------------------------------------------------

export const probeStepOf = (run) => run.steps.find((s) => s.kind === 'probe') ?? null;

/** Probing began: the map (empty, or partly probed) is kept in the run from now on. */
export function startProbe(run, id, map, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'probe' || FINISHED.has(s.status)) return null;
    s.startedAt ??= now;
    run.map = map;
    touch(run, now);
    return s;
}

/** The map is complete: the probe step is done. `origin` is the machine XY of X0 Y0 now. */
export function finishProbe(run, id, origin = null, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'probe' || FINISHED.has(s.status) || !mapComplete(run.map)) return null;
    run.map.origin = origin;
    Object.assign(s, { status: 'done', endedAt: now, kept: false, note: null });
    s.startedAt ??= now;
    const range = mapRange(run.map);
    record(run, s, 'done', now, `${run.map.nx * run.map.ny} points, copper varies ${range.toFixed(2)} mm`);
    touch(run, now);
    return s;
}

/** Throws the map away and makes the probe step the next thing to do. */
export function reprobe(run, now = Date.now()) {
    const s = probeStepOf(run);
    if (!s) return null;
    Object.assign(s, { status: 'pending', startedAt: null, endedAt: null, kept: false, note: null });
    run.map = null;
    touch(run, now);
    return s;
}

/**
 * Whether run step `step` runs levelled: a job cutting at copper depth, with
 * the board probed. When probing was skipped it runs as generated.
 */
export function levelsWith(run, step) {
    return !!step?.level && probeStepOf(run)?.status === 'done' && mapComplete(run.map);
}

// ---------------------------------------------------------------------------
// Bit changes
// ---------------------------------------------------------------------------

/** The bit-change step moves on from "swap the bit" to "zero Z" (or back). */
export function setBitStage(run, id, stage, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'bit' || FINISHED.has(s.status) || !['change', 'zero'].includes(stage)) return null;
    s.stage = stage;
    s.startedAt ??= now;
    touch(run, now);
    return s;
}

/** Z was zeroed at X0 Y0 with the new bit: the step is done. */
export function finishBitStep(run, id, zero, now = Date.now()) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'bit' || FINISHED.has(s.status)) return null;
    Object.assign(s, { status: 'done', stage: 'zero', endedAt: now, zero: { at: now, machineZ: zero?.machineZ ?? null } });
    s.startedAt ??= now;
    record(run, s, 'done', now, 'Z zeroed at X0 Y0');
    // A failure before this no longer leaves Z in doubt for the jobs it serves.
    for (let k = run.steps.indexOf(s) + 1; k < run.steps.length && run.steps[k].kind !== 'bit'; k++) {
        if (run.steps[k].kind === 'run') run.steps[k].lastResult = null;
    }
    touch(run, now);
    return s;
}

/**
 * Adds a bit change before step `beforeId` (a run step not yet done), for the
 * same bit that step uses. Returns the new step, or null when there's already
 * a bit change waiting right before it.
 */
export function insertBitChange(run, beforeId, now = Date.now()) {
    const i = run.steps.findIndex((s) => s.id === beforeId);
    const target = run.steps[i];
    if (i < 0 || target.kind !== 'run' || FINISHED.has(target.status) || target.status === 'active') return null;
    const prev = run.steps[i - 1];
    if (prev?.kind === 'bit' && !FINISHED.has(prev.status)) return null;
    let n = 1;
    while (stepOf(run, `bit+${n}`)) n++;
    const s = bitStep(target.bit, `bit+${n}`, { auto: false });
    run.steps.splice(i, 0, s);
    touch(run, now);
    return s;
}

/** Removes a bit change the user added and hasn't done. */
export function removeBitChange(run, id, now = Date.now()) {
    const i = run.steps.findIndex((s) => s.id === id);
    const s = run.steps[i];
    if (i < 0 || s.kind !== 'bit' || s.auto || s.status !== 'pending') return false;
    run.steps.splice(i, 1);
    touch(run, now);
    return true;
}

/**
 * The bit-change step that set up the bit for run step `id` (the nearest bit
 * step before it), or null.
 */
export function bitStepFor(run, id) {
    const i = run.steps.findIndex((s) => s.id === id);
    for (let k = i - 1; k >= 0; k--) if (run.steps[k].kind === 'bit') return run.steps[k];
    return null;
}

/**
 * Whether the user must confirm by hand that the right bit is in and Z is
 * zeroed before starting run step `id`: when no guided bit change was done
 * for it, or its last attempt failed (an alarm or a reset may have moved Z).
 */
export function needsBitConfirm(run, id) {
    const s = stepOf(run, id);
    if (!s || s.kind !== 'run') return false;
    if (s.lastResult === 'failed') return true;
    return bitStepFor(run, id)?.status !== 'done';
}

/** Suggested run file name for a project file name ("Board.pcbcam.json" → "Board.pcbrun.json"). */
export function runFileName(projectFileName, projectName) {
    const base = (projectFileName ?? '').replace(/\.pcbcam\.json$/i, '').replace(/\.json$/i, '') || String(projectName || 'board').replace(/[^\w.-]+/g, '-');
    return `${base}.pcbrun.json`;
}
