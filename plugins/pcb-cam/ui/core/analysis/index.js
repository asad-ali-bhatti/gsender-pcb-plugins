// Board analysis for isolation: where a tool is too wide to separate copper,
// copper that no isolation operation covers, and region suggestions for a
// finer tool. All results are plain JSON with mm coordinates.

import * as G from '../geometry.js';
import { widthAtDepth } from '../tools.js';
import { netOf } from '../project.js';
import { regionMask } from '../regions.js';

/** Gap pieces smaller than this are ignored (concave-corner fillets, numeric noise), mm². */
const MIN_PIECE_AREA = 1e-4;

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

function boxOfPath(path) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const p of path) {
        if (p.X < xmin) xmin = p.X;
        if (p.X > xmax) xmax = p.X;
        if (p.Y < ymin) ymin = p.Y;
        if (p.Y > ymax) ymax = p.Y;
    }
    return { xmin, ymin, xmax, ymax };
}
const inBox = (b, p) => p.X >= b.xmin && p.X <= b.xmax && p.Y >= b.ymin && p.Y <= b.ymax;
const overlaps = (a, b) => a.xmin <= b.xmax && b.xmin <= a.xmax && a.ymin <= b.ymax && b.ymin <= a.ymax;

/** Copper islands of a layer with their nets (from X2 attributes). */
function copperIslands(layer) {
    const list = G.islands(layer.image).map((isl) => ({ shape: [isl.outer, ...isl.holes], box: boxOfPath(isl.outer), nets: new Set() }));
    for (const o of layer.objects) {
        const net = netOf(o);
        if (!net || o.polarity !== 'dark' || !o.shape.length || !o.shape[0].length) continue;
        const p = o.shape[0][0];
        for (const isl of list) {
            if (inBox(isl.box, p) && G.containsPoint(isl.shape, p.X / G.SCALE, p.Y / G.SCALE)) {
                isl.nets.add(net);
                break;
            }
        }
    }
    return list;
}

/** Shortest distance between the boundaries of two shapes, looking only at vertices inside `box` (units). */
function boundaryGap(a, b, box) {
    const segDist = (p, s0, s1) => {
        const dx = s1.X - s0.X, dy = s1.Y - s0.Y;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p.X - s0.X) * dx + (p.Y - s0.Y) * dy) / len2)) : 0;
        return Math.hypot(p.X - (s0.X + t * dx), p.Y - (s0.Y + t * dy));
    };
    let best = Infinity;
    const scan = (from, to) => {
        for (const pa of from) for (const p of pa) {
            if (!inBox(box, p)) continue;
            for (const pb of to) for (let i = 0; i < pb.length; i++) {
                const s0 = pb[i], s1 = pb[(i + 1) % pb.length];
                if (!inBox(box, s0) && !inBox(box, s1)) continue;
                const d = segDist(p, s0, s1);
                if (d < best) best = d;
            }
        }
    };
    scan(a, b);
    scan(b, a);
    return best === Infinity ? null : best / G.SCALE;
}

/**
 * Places where copper features of different nets are closer than `width`, so
 * an isolation pass of that width cannot separate them.
 * @returns {{ at: number[], gap: number|null, width: number, nets: string[], bounds: object, piece: object[] }[]}
 */
export function narrowGaps(layer, width, { mask = null } = {}) {
    const copper = layer.image;
    if (!copper.length) return [];
    const isl = copperIslands(layer);
    const grown = G.islands(G.offset(copper, width / 2));
    const out = [];
    for (const g of grown) {
        const gShape = [g.outer, ...g.holes];
        const gBox = boxOfPath(g.outer);
        const members = isl.filter((c) => overlaps(gBox, c.box) && G.containsPoint(gShape, c.shape[0][0].X / G.SCALE, c.shape[0][0].Y / G.SCALE));
        if (members.length < 2) continue;
        // Morphological closing minus copper: the slivers the tool cannot enter.
        const pieces = G.islands(G.difference(G.offset(gShape, -width / 2), copper));
        for (const piece of pieces) {
            const pShape = [piece.outer, ...piece.holes];
            if (G.area(pShape) < MIN_PIECE_AREA) continue;
            const touch = G.offset(pShape, 0.002);
            const pBox = boxOfPath(touch[0] ?? piece.outer);
            const touching = members.filter((c) => overlaps(pBox, c.box) && G.intersection(touch, c.shape).length);
            if (touching.length < 2) continue;
            const nets = [...new Set(touching.flatMap((c) => [...c.nets]))].sort();
            // Same net on every touching island: merging them is harmless.
            if (touching.every((c) => c.nets.size === 1) && nets.length === 1) continue;
            const b = G.bounds(pShape);
            const at = [round((b.xmin + b.xmax) / 2), round((b.ymin + b.ymax) / 2)];
            if (mask && !G.containsPoint(mask, at[0], at[1])) continue;
            const m = width * G.SCALE;
            const search = { xmin: pBox.xmin - m, ymin: pBox.ymin - m, xmax: pBox.xmax + m, ymax: pBox.ymax + m };
            let gap = null;
            for (let i = 0; i < touching.length; i++) for (let j = i + 1; j < touching.length; j++) {
                const d = boundaryGap(touching[i].shape, touching[j].shape, search);
                if (d !== null && (gap === null || d < gap)) gap = d;
            }
            out.push({ at, gap: gap === null ? null : round(gap), width: round(width), nets, bounds: { xmin: round(b.xmin), ymin: round(b.ymin), xmax: round(b.xmax), ymax: round(b.ymax) }, piece: pShape });
        }
    }
    return out;
}

/**
 * Analysis issues for a project: isolation tools too wide for a gap
 * (`tool-too-wide`) and copper edges no isolation operation covers
 * (`not-isolated`). Each has `at` [x, y] and `opId` or `input`.
 */
export function analyzeProject(project, layers, { only } = {}) {
    const issues = [];
    // With `only`, gaps are checked for those operations, and coverage for the
    // inputs they cut (counting every isolation operation on those inputs).
    const inputs = only ? new Set(project.operations.filter((o) => only.includes(o.id)).map((o) => o.input)) : null;
    const tools = new Map(project.tools.map((t) => [t.id, t]));
    const byInput = new Map();
    for (const op of project.operations) {
        if (!op.enabled || op.type !== 'isolation' || !layers[op.input] || !tools.has(op.tool)) continue;
        if (inputs && !inputs.has(op.input)) continue;
        const layer = layers[op.input];
        const width = widthAtDepth(tools.get(op.tool), op.depth);
        const mask = regionMask(project, op, layers);
        if (!only || only.includes(op.id)) for (const g of narrowGaps(layer, width, { mask })) {
            issues.push({
                severity: 'warning', code: 'tool-too-wide', opId: op.id, at: g.at, gap: g.gap, width: g.width, nets: g.nets,
                message: `"${op.id}": ${g.gap === null ? 'a gap' : `gap of ${g.gap} mm`} at (${g.at[0]}, ${g.at[1]}) is narrower than the ${g.width} mm cut${g.nets.length ? ` (${g.nets.join(', ')})` : ''}; copper stays connected`,
            });
        }
        if (!byInput.has(op.input)) byInput.set(op.input, []);
        byInput.get(op.input).push({ mask, width });
    }
    for (const [input, list] of byInput) {
        if (list.some((x) => x.mask === null)) continue;
        const copper = layers[input].image;
        const edge = G.difference(G.offset(copper, 0.01), copper);
        const covered = G.union(...list.map((x) => G.offset(x.mask, x.width)));
        for (const piece of G.islands(G.difference(edge, covered))) {
            const s = [piece.outer, ...piece.holes];
            if (G.area(s) < MIN_PIECE_AREA) continue;
            const b = G.bounds(s);
            const at = [round((b.xmin + b.xmax) / 2), round((b.ymin + b.ymax) / 2)];
            issues.push({ severity: 'warning', code: 'not-isolated', input, at, message: `Copper edge near (${at[0]}, ${at[1]}) on "${input}" is outside every isolation region` });
        }
    }
    return issues;
}

/**
 * Proposes polygon regions around the gaps `tool` (at `depth`) cannot cut, so
 * an agent or user can assign a finer tool there.
 * @returns {{ points: number[][], gaps: number, minGap: number|null }[]}
 */
export function suggestRegions(layer, tool, depth, { margin = 1 } = {}) {
    const gaps = narrowGaps(layer, widthAtDepth(tool, depth));
    if (!gaps.length) return [];
    const blobs = G.islands(G.union(...gaps.map((g) => G.offset(g.piece, margin))));
    return blobs.map((b) => {
        const shape = [b.outer, ...b.holes];
        const inside = gaps.filter((g) => G.containsPoint(shape, g.at[0], g.at[1]));
        const hull = G.convexHull(G.fromPath(b.outer)).map(([x, y]) => [round(x, 3), round(y, 3)]);
        const known = inside.map((g) => g.gap).filter((g) => g !== null);
        return { points: hull, gaps: inside.length, minGap: known.length ? Math.min(...known) : null };
    });
}
