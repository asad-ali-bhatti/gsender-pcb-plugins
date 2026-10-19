// Copper clearing: concentric offset passes over the copper-free area, inside
// the region or board. With `rest`, only passes that touch copper earlier
// operations left behind are kept.

import { widthAtDepth } from '../tools.js';
import * as G from '../geometry.js';
import { PATH_TOLERANCE, clipRings, cutsAtLevels, depthLevels, orderNearest, reversed, rings } from './common.js';

/** Safety cap on concentric passes. */
const MAX_RINGS = 5000;

/**
 * @param {object} ctx { op, tool, cutting, layer, mask, board, removed, from, mirror }
 *   `board` is the board shape or null; `removed` is the area earlier
 *   operations on the same input already cut (for rest machining).
 */
export function clearing({ op, tool, cutting, layer, mask, board, removed, from, mirror }) {
    const issues = [];
    const width = widthAtDepth(tool, op.depth);
    const step = width * (1 - op.overlap);
    let area = board ?? boxAround(layer.bounds, 1);
    if (mask) area = G.intersection(area, mask);
    const free = G.difference(area, layer.image);
    const loops = [];
    const lines = [];
    // With rest machining, keep only the parts of each pass whose tool disc
    // reaches copper that is still there.
    const reach = op.rest ? G.offset(G.difference(free, removed ?? []), width / 2 - 0.005) : null;
    let count = 0;
    // Each pass is offset from the previous one: the shape gets simpler as it
    // shrinks, which is much faster than offsetting the whole free area again.
    let shape = G.offset(free, -width / 2, { tol: PATH_TOLERANCE });
    for (; shape.length && count < MAX_RINGS; shape = G.offset(shape, -step, { tol: PATH_TOLERANCE })) {
        // Free area is on the left of normalised rings, so the copper wall is on
        // the right: climb milling as given.
        let ringList = rings(shape);
        if (!ringList.length) break;
        count += ringList.length;
        if (mirror) ringList = ringList.map(reversed);
        const clipped = clipRings(ringList, reach);
        loops.push(...clipped.loops);
        lines.push(...clipped.lines);
    }
    if (count >= MAX_RINGS) issues.push({ severity: 'warning', code: 'clearing-truncated', message: `Clearing "${op.id}" stopped after ${MAX_RINGS} passes`, opId: op.id });
    const levels = depthLevels(op.depth, cutting.stepdown);
    const ordered = orderNearest([...loops.map((loop) => ({ loop })), ...lines.map((line) => ({ line }))], from);
    const cuts = ordered.items.flatMap((item) => cutsAtLevels(item, levels));
    if (!cuts.length) issues.push({ severity: 'warning', code: 'empty-operation', message: `Clearing "${op.id}" produced no toolpaths`, opId: op.id });
    return { cuts, loops, lines, width, end: ordered.end, issues };
}

function boxAround(b, m) {
    if (!b) return [];
    return G.normalize([G.toPath([[b.xmin - m, b.ymin - m], [b.xmax + m, b.ymin - m], [b.xmax + m, b.ymax + m], [b.xmin - m, b.ymax + m]])]);
}
