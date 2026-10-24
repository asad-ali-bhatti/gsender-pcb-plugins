// One CNC job → G-code: the recipe shared by PCB CAM's UI and Project Runner,
// so both turn the same project file into byte-identical G-code.

import { loadFile } from './import/index.js';
import { generate } from './plan.js';

/** Bump when a change to the core changes the G-code it emits for the same project. */
export const CORE_VERSION = 1;

export const PROJECT_FORMAT = 'pcb-cam-project';

const usable = (layer) => !!layer && !layer.issues.some((i) => i.severity === 'error');

/**
 * The project as generation should see it: only usable inputs and the
 * operations that use them, all enabled (a job names its operations itself).
 * @param {object} project
 * @param {Record<string, object>} layers input id → parsed layer
 */
export function runnableProject(project, layers) {
    const operations = project.operations.filter((o) => usable(layers[o.input])).map((o) => (o.enabled ? o : { ...o, enabled: true }));
    const used = new Set(operations.map((o) => o.input));
    const inputs = project.inputs.filter((i) => usable(layers[i.id]) && (used.has(i.id) || i.role === 'outline'));
    return { ...project, inputs, operations };
}

/** Parses a project file's board files ({ fileName: text }) into layers by input id. */
export function layersFromFiles(project, boardFiles = {}) {
    const byFile = new Map();
    const layers = {};
    for (const input of project.inputs) {
        const text = boardFiles[input.file];
        if (typeof text !== 'string') continue;
        if (!byFile.has(input.file)) byFile.set(input.file, loadFile(input.file, text).layer);
        const layer = byFile.get(input.file);
        if (layer) layers[input.id] = layer;
    }
    return layers;
}

/**
 * Generates one job of a project file.
 * @param {{ project: object, boardFiles?: Record<string,string>, jobs?: object[] }} doc project file content
 * @param {string} jobId
 * @param {{ layers?: Record<string, object>, toolChangeOption?: string }} [opts] `layers` reuses
 *   files already parsed (input id → layer); otherwise they are parsed from `doc.boardFiles`
 * @returns {object} `generate`'s result ({ ok, issues, files, ... }); a frozen job returns its kept result
 */
export function generateJob(doc, jobId, { layers, toolChangeOption } = {}) {
    const job = (doc.jobs ?? []).find((j) => j.id === jobId);
    if (!job) return { ok: false, issues: [{ severity: 'error', code: 'no-job', message: `There is no job "${jobId}" in this project` }] };
    if (job.frozen) {
        return job.result?.ok && job.result.files?.length
            ? { ...job.result, frozen: true }
            : { ok: false, issues: [{ severity: 'error', code: 'frozen-no-gcode', message: `"${job.name}" was kept without its G-code` }] };
    }
    const { project } = doc;
    layers = layers ?? layersFromFiles(project, doc.boardFiles);
    const ops = job.ops.map((id) => project.operations.find((o) => o.id === id)).filter(Boolean);
    if (ops.length < job.ops.length) {
        return { ok: false, issues: [{ severity: 'error', code: 'missing-operation', message: `"${job.name}" uses a geometry that was deleted from the project` }] };
    }
    const issues = [];
    for (const input of new Set(ops.map((o) => project.inputs.find((i) => i.id === o.input)))) {
        if (!input) continue;
        if (!layers[input.id]) {
            issues.push({ severity: 'error', code: 'missing-file', message: `"${job.name}" needs ${input.file}, which is not in the project file`, input: input.id });
        } else if (!usable(layers[input.id])) {
            issues.push({ severity: 'error', code: 'bad-file', message: `${input.file} has errors, so "${job.name}" can't be generated`, input: input.id });
        }
    }
    if (issues.length) return { ok: false, issues };
    // G-code files are named after the project; use the job's name.
    return generate(runnableProject({ ...project, name: job.name }, layers), layers, { toolChangeOption, only: job.ops });
}

/** SHA-256 (hex) of a job's G-code files, as written to the project file's `gcodeHash`. */
export async function gcodeHash(files) {
    return sha256Hex(files.map((f) => `${f.name}\n${f.gcode}`).join('\0'));
}

export async function sha256Hex(text) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
