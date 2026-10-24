// Job planning: runs the enabled operations in list order, maps them to
// machine coordinates (board side, origin) and emits G-code. Pure function of
// the project and the parsed input files.

import * as G from './geometry.js';
import { cuttingFor } from './tools.js';
import { validateProject } from './project.js';
import { regionMask } from './regions.js';
import { boardFromOutline } from './board.js';
import { isolation } from './ops/isolation.js';
import { drilling } from './ops/drilling.js';
import { cutout } from './ops/cutout.js';
import { clearing } from './ops/clearing.js';
import { round } from './ops/common.js';
import { emitGrbl } from './gcode/grbl.js';

const COPPER_OPS = new Set(['isolation', 'clearing']);

/** Board side each enabled operation runs on (see the `face` schema description). */
export function resolveFaces(project) {
    const inputs = new Map(project.inputs.map((i) => [i.id, i]));
    const ops = project.operations.filter((o) => o.enabled);
    const copperSides = ops.filter((o) => COPPER_OPS.has(o.type)).map((o) => inputs.get(o.input)?.side);
    const allBottom = copperSides.length > 0 && copperSides.every((s) => s === 'bottom');
    const faces = {};
    for (const op of ops) {
        faces[op.id] = op.face ?? (COPPER_OPS.has(op.type) ? (inputs.get(op.input)?.side === 'bottom' ? 'bottom' : 'top') : allBottom ? 'bottom' : 'top');
    }
    return faces;
}

/**
 * Generates toolpaths and G-code.
 * @param {object} project project document
 * @param {Record<string, object>} layers input id → parsed Gerber/Excellon
 * @param {{ toolChangeOption?: string, only?: string[] }} [opts] gSender's workspace
 *   tool-change option, for warnings; `only` limits the run to these enabled
 *   operations while the rest of the project still shapes regions and faces
 * @returns {{
 *   ok: boolean, issues: object[],
 *   operations?: { id, type, tool, face, cuts, stats }[],
 *   files?: { name, tools: number[], gcode: string, stats }[],
 *   transform?: { mirrorX: number, shift: number[] },
 *   stats?: object
 * }}
 */
export function generate(project, layers, { toolChangeOption, only } = {}) {
    const issues = validateProject(project, { layers }).map((i) => ({ severity: i.severity, code: i.code, message: i.message, path: i.path }));
    if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };
    const ops = project.operations.filter((o) => o.enabled && (!only || only.includes(o.id)));
    if (!ops.length) {
        issues.push({ severity: 'error', code: 'no-operations', message: 'No enabled operations' });
        return { ok: false, issues };
    }

    const inputs = new Map(project.inputs.map((i) => [i.id, i]));
    const tools = new Map(project.tools.map((t) => [t.id, t]));
    const faces = resolveFaces(project);

    // Board shapes from outline inputs. A broken outline only fails a cutout;
    // clearing falls back to the copper's bounding box.
    const boards = new Map();
    const boardOf = (inputId) => {
        if (!boards.has(inputId)) boards.set(inputId, boardFromOutline(layers[inputId]));
        return boards.get(inputId);
    };
    const outlineInput = project.inputs.find((i) => i.role === 'outline');
    const outline = outlineInput ? boardOf(outlineInput.id) : null;
    const board = outline && !outline.issues.length ? outline.shape : null;
    if (outline?.issues.length && ops.some((o) => o.type === 'clearing')) {
        issues.push(...outline.issues.map((i) => ({ ...i, severity: 'warning', input: outlineInput.id })));
    }

    // Area each copper input has had removed so far (for rest machining).
    const removed = new Map();
    const results = [];
    let from = [0, 0];
    for (const op of ops) {
        const tool = tools.get(op.tool);
        const cutting = cuttingFor(tool, project.setup.material);
        const layer = layers[op.input];
        const mask = regionMask(project, op, layers);
        if (mask && !mask.length) issues.push({ severity: 'warning', code: 'empty-region', message: `Region "${op.region}" of "${op.id}" is empty`, opId: op.id });
        // `mirror`: the result will be mirrored, so the op must turn the other way.
        const ctx = { op, tool, cutting, layer, mask, project, from, mirror: faces[op.id] === 'bottom' };
        let r;
        if (op.type === 'isolation') r = isolation(ctx);
        else if (op.type === 'drilling') r = drilling(ctx);
        else if (op.type === 'clearing') r = clearing({ ...ctx, board, removed: removed.get(op.input) });
        else {
            const b = boardOf(op.input);
            if (b.issues.length) {
                issues.push(...b.issues.map((i) => ({ ...i, opId: op.id, input: op.input })));
                continue;
            }
            r = cutout({ ...ctx, board: b.shape });
        }
        issues.push(...r.issues);
        // Swept area is only needed by a later rest-machining clearing on this input.
        const later = ops.slice(ops.indexOf(op) + 1);
        if (r.loops && later.some((o) => o.type === 'clearing' && o.rest && o.input === op.input)) {
            const cut = G.sweep(r.loops, r.lines, r.width);
            removed.set(op.input, G.union(removed.get(op.input) ?? [], cut));
        }
        if (r.cuts.length) from = r.end;
        results.push({ op, tool, cutting, face: faces[op.id], cuts: r.cuts, marks: r.marks, extra: { holes: r.holes, breakdown: r.breakdown, tabs: r.tabs, width: r.width } });
    }
    if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };

    const lastCut = ops.map((o) => o.type).lastIndexOf('cutout');
    if (lastCut >= 0 && lastCut < ops.length - 1) {
        issues.push({ severity: 'warning', code: 'cutout-not-last', message: `Operations after the cutout "${ops[lastCut].id}" run on a board held only by tabs`, opId: ops[lastCut].id });
    }
    const faceList = [...new Set(results.filter((r) => r.cuts.length).map((r) => r.face))];
    if (faceList.length > 1) {
        issues.push({ severity: 'warning', code: 'flip-board', message: 'Operations run on both board sides; the G-code pauses (M0) to flip the board, which needs alignment pins or a fixed mirror axis' });
    }

    // Machine coordinates: mirror the bottom side about the board centre, then shift the origin.
    const frame = board ? G.bounds(board) : G.mergeBounds(...Object.values(layers).map((l) => l.bounds));
    const mirrorX = frame ? frame.xmin + frame.xmax : 0;
    const shift = project.setup.origin === 'board-lower-left' && frame ? [-frame.xmin, -frame.ymin] : [0, 0];
    const map = (face) => (x, y) => [(face === 'bottom' ? mirrorX - x : x) + shift[0], y + shift[1]];
    for (const r of results) {
        const m = map(r.face);
        r.cuts = r.cuts.map((c) => {
            if (c.kind === 'drill') {
                const [x, y] = m(c.x, c.y);
                return { ...c, x, y };
            }
            // Operations on the bottom were generated turning the other way, so
            // mirroring restores climb / conventional.
            return { ...c, points: c.points.map(([x, y, z]) => [...m(x, y), z]) };
        });
        if (r.marks) r.marks = r.marks.map((k) => { const [x, y] = m(k.x, k.y); return { ...k, x, y }; });
    }

    const steps = results.filter((r) => r.cuts.length);
    if (!steps.length) {
        issues.push({ severity: 'error', code: 'no-toolpaths', message: 'No operation produced any toolpaths' });
        return { ok: false, issues };
    }
    const used = [...new Map(steps.map((r) => [r.tool.id, r.tool])).values()];
    if (used.length > 1 && project.output.toolChange === 'm6' && toolChangeOption === 'Ignore') {
        issues.push({ severity: 'warning', code: 'toolchange-ignored', message: `The job uses ${used.length} tools but gSender's tool change option is "Ignore": M6 will not pause. Choose a tool change option in gSender or split the output per tool` });
    }

    const job = (steps) => ({ name: project.name, setup: project.setup, output: project.output, steps });
    const files = [];
    if (project.output.toolChange === 'split' && used.length > 1) {
        // One file per tool and side, in order of first use.
        const groups = new Map();
        for (const r of steps) {
            const key = `${r.tool.id}|${r.face}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(r);
        }
        let n = 0;
        for (const steps of groups.values()) {
            const t = steps[0].tool;
            const suffix = faceList.length > 1 ? `-${steps[0].face}` : '';
            const name = `${slug(project.name)}-${String(++n).padStart(2, '0')}-T${t.toolNumber}${suffix}.nc`;
            const { gcode, stats } = emitGrbl(job(steps), { title: `PCB CAM: ${project.name}, part ${n} of ${groups.size}: T${t.toolNumber} ${t.name}` });
            files.push({ name, tools: [t.toolNumber], gcode, stats: roundStats(stats) });
        }
    } else {
        const { gcode, stats } = emitGrbl(job(steps));
        files.push({ name: `${slug(project.name)}.nc`, tools: used.map((t) => t.toolNumber), gcode, stats: roundStats(stats) });
    }

    const operations = results.map((r) => ({
        id: r.op.id,
        type: r.op.type,
        tool: r.tool.id,
        face: r.face,
        cuts: r.cuts,
        ...(r.marks ? { marks: r.marks } : {}),
        stats: opStats(r),
    }));
    const total = files.reduce((a, f) => ({ minutes: a.minutes + f.stats.minutes, cutLength: a.cutLength + f.stats.cutLength }), { minutes: 0, cutLength: 0 });
    // How file coordinates map to machine coordinates: x' = (bottom ? mirrorX - x : x) + shift[0], y' = y + shift[1].
    const transform = { mirrorX, shift };
    return { ok: true, issues, operations, files, transform, stats: { minutes: round(total.minutes, 1), cutLength: round(total.cutLength, 1), tools: used.length, files: files.length } };
}

function opStats(r) {
    let cutLength = 0;
    let minZ = 0;
    for (const c of r.cuts) {
        if (c.kind === 'drill') { minZ = Math.min(minZ, c.z); continue; }
        for (let i = 1; i < c.points.length; i++) {
            const [x0, y0, z0] = c.points[i - 1];
            const [x1, y1, z1] = c.points[i];
            cutLength += Math.hypot(x1 - x0, y1 - y0, z1 - z0);
        }
        for (const p of c.points) minZ = Math.min(minZ, p[2]);
    }
    const s = { cuts: r.cuts.length, cutLength: round(cutLength, 1), minutes: round(cutLength / r.cutting.feed, 1), minZ: round(minZ) };
    if (r.extra.holes !== undefined) s.holes = r.extra.holes;
        if (r.extra.breakdown) s.breakdown = r.extra.breakdown;
    if (r.extra.tabs !== undefined) s.tabs = r.extra.tabs;
    if (r.extra.width !== undefined) s.width = round(r.extra.width);
    return s;
}

function roundStats(s) {
    return {
        cutLength: round(s.cutLength, 1),
        rapidLength: round(s.rapidLength, 1),
        plunges: s.plunges,
        toolChanges: s.toolChanges,
        minutes: round(s.minutes, 1),
        bounds: s.bounds && { xmin: round(s.bounds.xmin, 3), ymin: round(s.bounds.ymin, 3), xmax: round(s.bounds.xmax, 3), ymax: round(s.bounds.ymax, 3) },
    };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'board';
