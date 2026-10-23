// Run plan: which jobs run, in what order, and the steps that follows from it.
// Pure module. Steps are plain data so they can be saved in the run file.

/** Jobs that are selected by default: every runnable job, in project order. */
export function defaultSelection(jobs) {
    return jobs.filter((j) => j.status === 'ready').map((j) => j.id);
}

/** Moves job `id` one place up (dir -1) or down (+1) in the ordered selection. */
export function moveJob(ids, id, dir) {
    const i = ids.indexOf(id);
    const k = i + dir;
    if (i < 0 || k < 0 || k >= ids.length) return ids;
    const out = [...ids];
    [out[i], out[k]] = [out[k], out[i]];
    return out;
}

/**
 * Moves job `id` to just before (or after, `after`) job `targetId`: the result
 * of dragging it there.
 */
export function reorderJob(ids, id, targetId, after = false) {
    if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids;
    const out = ids.filter((x) => x !== id);
    out.splice(out.indexOf(targetId) + (after ? 1 : 0), 0, id);
    return out;
}

/**
 * Adds or removes job `id` from the selection. A job that is ticked again goes
 * back to its place in the project order among the jobs already picked.
 */
export function toggleJob(jobs, ids, id) {
    if (ids.includes(id)) return ids.filter((x) => x !== id);
    const pos = (x) => jobs.findIndex((j) => j.id === x);
    const k = ids.findIndex((x) => pos(x) > pos(id));
    const out = [...ids];
    out.splice(k < 0 ? out.length : k, 0, id);
    return out;
}

const warn = (code, message, at = null, severity = 'warning') => ({ code, message, severity, at });
const CUTS_THROUGH = new Set(['cutout']);

/**
 * Problems with a selection, in plain words.
 * @param {object[]} jobs inspected jobs (see jobs.js)
 * @param {string[]} ids selected job ids in run order
 * @returns {{ code, message, severity: 'error'|'warning', at: string|null }[]}
 */
export function selectionWarnings(jobs, ids) {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const sel = ids.map((id) => byId.get(id)).filter(Boolean);
    const out = [];
    if (!sel.length) return [warn('nothing-selected', 'Pick at least one job.', null, 'error')];
    for (const j of sel) {
        if (j.status !== 'ready') out.push(warn('not-ready', `"${j.name}" can't run: ${j.message}`, j.id, 'error'));
    }
    const cut = sel.findIndex((j) => j.opTypes.some((t) => CUTS_THROUGH.has(t)));
    if (cut >= 0 && cut < sel.length - 1) {
        out.push(warn('cutout-not-last', `Move "${sel[cut].name}" to the end: once the board is cut free it can shift.`, sel[cut].id));
    }
    if (sel.some((j) => j.files.some((f) => f.flip))) {
        out.push(warn('flip', 'A job cuts both sides. When gSender pauses, flip the board and press Resume.', null));
    }
    return out;
}

/** Display name of a bit, e.g. "V-bit 30° 0.2 mm (T1)". */
export const bitLabel = (b) => (b ? `${b.name} (T${b.toolNumber})` : 'unknown bit');

/**
 * A bit-change step: put `bit` in, then zero Z at X0 Y0. `auto` steps come
 * from the plan (the bit changes); the user adds the others (e.g. a fresh
 * V-bit halfway, or re-zeroing after a broken bit).
 */
export function bitStep(bit, id, { auto = true } = {}) {
    return { id, kind: 'bit', bit: bit ?? null, auto, stage: 'change', status: 'pending', startedAt: null, endedAt: null, note: null, zero: null };
}

const sameBit = (a, b) => !!a && !!b && a.id === b.id;

/** A step for a command the user added (see commands.js). */
function commandStep(cmd) {
    if (cmd.type === 'bit') return bitStep(null, `bit:${cmd.id}`, { auto: false });
    return { id: `cmd:${cmd.id}`, kind: cmd.type, text: cmd.text, status: 'pending', startedAt: null, endedAt: null, note: null };
}

/**
 * Steps for the selected jobs: one run step per G-code file, and a bit-change
 * step before every run step whose bit differs from the one before it (and
 * before the first, since a bit has to go in).
 *
 * `commands` adds the user's steps around a job: `{ [jobId]: { before: [], after: [] } }`.
 * They go after the job's automatic bit change, so a reminder such as "switch
 * the router on" comes once the bit is in. A bit change the user added sets up
 * the bit of the next job, and replaces the automatic one there.
 */
export function planSteps(jobs, ids, commands = {}) {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const steps = [];
    let prevBit = null;
    let open = []; // bit steps waiting to learn the bit of the job they set up
    const add = (s) => { steps.push(s); if (s.kind === 'bit') open.push(s); };
    for (const id of ids) {
        const job = byId.get(id);
        if (!job || job.status !== 'ready') continue;
        const { before = [], after = [] } = commands[id] ?? {};
        const first = job.files[0]?.bits[0] ?? null;
        if (!open.length && !before.some((c) => c.type === 'bit') && !sameBit(prevBit, first)) add(bitStep(first, `bit@${job.id}#1`));
        before.forEach((c) => add(commandStep(c)));
        job.files.forEach((f, n) => {
            const bit = f.bits[0] ?? null;
            const stepId = `${job.id}#${n + 1}`;
            if (n > 0 && !open.length && !sameBit(prevBit, bit)) add(bitStep(bit, `bit@${stepId}`));
            for (const s of open) s.bit = bit;
            open = [];
            steps.push({
                id: stepId,
                kind: 'run',
                job: job.id,
                jobName: job.name,
                file: f.name,
                hash: f.hash,
                lines: f.lines,
                minutes: f.minutes,
                bit,
                status: 'pending',
                attempts: 0,
                startedAt: null,
                endedAt: null,
                line: 0,
                lastResult: null,
                note: null,
            });
            prevBit = bit;
        });
        after.forEach((c) => add(commandStep(c)));
    }
    return steps;
}

/** Problems with the planned steps themselves (warnings only). */
export function planWarnings(steps) {
    const out = [];
    const last = steps.findLastIndex((s) => s.kind === 'run');
    if (steps.some((s, i) => s.kind === 'bit' && i > last)) {
        out.push(warn('bit-change-at-end', 'Remove the bit change after the last job; no job uses it.', null));
    }
    return out;
}
