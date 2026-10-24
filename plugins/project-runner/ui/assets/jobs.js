// Opening a PCB CAM project file: which of its jobs can run, and their G-code.
// Pure module (no DOM, no SDK). The G-code comes from the same core PCB CAM
// uses (a synced copy in ../core), and a job only runs when it hashes the same
// as what the user reviewed and saved in PCB CAM.

import { validateProject, generateJob, gcodeHash, sha256Hex, CORE_VERSION, PROJECT_FORMAT } from '../core/index.js';

/**
 * Parses and checks a project file.
 * @returns {{ ok: true, doc: object } | { ok: false, message: string }}
 */
export function parseProjectFile(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return { ok: false, message: `This file isn't valid JSON (${e.message}).` }; }
    if (doc?.format !== PROJECT_FORMAT || !doc.project) {
        return { ok: false, message: 'Not a PCB CAM project file. Save one in PCB CAM (File → Save project).' };
    }
    const errors = validateProject(doc.project).filter((i) => i.severity === 'error');
    if (errors.length) return { ok: false, message: `The project in this file is damaged: ${errors[0].message}.` };
    if (!Array.isArray(doc.jobs) || !doc.jobs.length) {
        return { ok: false, message: 'This project has no CNC jobs. Create them in PCB CAM, then save.' };
    }
    return { ok: true, doc: { ...doc, boardFiles: doc.boardFiles ?? {} } };
}

/** Lines gSender counts for a file: its non-empty lines. */
export const lineCount = (gcode) => gcode.split('\n').filter((l) => l.trim().length > 0).length;

const OP_WORDS = { isolation: 'isolation', clearing: 'copper clearing', drilling: 'drilling', cutout: 'cutout' };

/**
 * Regenerates every job and decides whether it may run.
 * status: 'ready' | 'not-reviewed' | 'out-of-date' | 'multi-bit' | 'error'
 * @returns {Promise<object[]>} one entry per job, in project order
 */
export async function inspectJobs(doc, { toolChangeOption } = {}) {
    const out = [];
    for (const job of doc.jobs) out.push(await inspectJob(doc, job, { toolChangeOption }));
    return out;
}

export async function inspectJob(doc, job, { toolChangeOption } = {}) {
    const { project } = doc;
    const ops = (job.ops ?? []).map((id) => project.operations.find((o) => o.id === id)).filter(Boolean);
    const base = {
        id: job.id,
        name: job.name || job.id,
        opTypes: job.frozen ? [] : [...new Set(ops.map((o) => o.type))],
        frozen: !!job.frozen,
        files: [],
        issues: [],
    };
    const r = generateJob(doc, job.id, { toolChangeOption });
    if (!r.ok) {
        const err = r.issues.find((i) => i.severity === 'error') ?? r.issues[0];
        return { ...base, status: 'error', message: err?.message ?? 'This job could not be generated.', issues: r.issues };
    }
    const files = [];
    for (const f of r.files) {
        const tools = f.tools.map((n) => project.tools.find((t) => t.toolNumber === n)).filter(Boolean);
        const toolIds = new Set(tools.map((t) => t.id));
        const fileOps = (r.operations ?? []).filter((o) => toolIds.has(o.tool));
        files.push({
            name: f.name,
            gcode: f.gcode,
            hash: await sha256Hex(f.gcode),
            lines: lineCount(f.gcode),
            bits: tools.map((t) => ({ id: t.id, name: t.name, toolNumber: t.toolNumber, type: t.type })),
            minutes: f.stats?.minutes ?? null,
            bounds: f.stats?.bounds ?? null,
            opTypes: [...new Set(fileOps.map((o) => o.type))],
            flip: /^M0\b/m.test(f.gcode),
        });
    }
    const opTypes = base.opTypes.length ? base.opTypes : [...new Set((r.operations ?? []).map((o) => o.type))];
    const faces = [...new Set((r.operations ?? []).map((o) => o.face))];
    const entry = {
        ...base,
        opTypes,
        faces,
        files,
        minutes: files.reduce((a, f) => a + (f.minutes ?? 0), 0),
        issues: r.issues.filter((i) => i.severity !== 'error'),
        what: opTypes.map((t) => OP_WORDS[t] ?? t).join(' + ') || 'kept G-code',
    };

    const multi = files.find((f) => f.bits.length > 1);
    if (multi) {
        return {
            ...entry, status: 'multi-bit',
            message: `Uses ${multi.bits.length} bits in one file (${multi.bits.map((b) => `T${b.toolNumber}`).join(', ')}). `
                + 'In PCB CAM, make one job per bit, then save.',
        };
    }
    if (job.frozen?.stale) {
        return { ...entry, status: 'out-of-date', message: 'Out of date and its geometry is gone. Make the job again in PCB CAM.' };
    }
    if (job.frozen) return { ...entry, status: 'ready', message: 'Kept G-code (geometry deleted).' };
    if (!job.gcodeHash) {
        return { ...entry, status: 'not-reviewed', message: 'Not checked yet. Generate it in PCB CAM, look it over, save.' };
    }
    if (job.gcodeHash !== await gcodeHash(r.files)) {
        const older = job.coreVersion !== undefined && job.coreVersion !== CORE_VERSION;
        return {
            ...entry, status: 'out-of-date',
            message: older
                ? 'Made with a different version of PCB CAM. Regenerate it there and save.'
                : 'Changed since you checked it. Regenerate it in PCB CAM and save.',
        };
    }
    return { ...entry, status: 'ready', message: null };
}
