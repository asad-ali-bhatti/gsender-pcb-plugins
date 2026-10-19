// Isolation routing: contours around the copper at growing offsets, computed
// on the whole layer and then clipped to the region, so offsets near a region
// edge still respect copper outside it.

import { widthAtDepth } from '../tools.js';
import * as G from '../geometry.js';
import { clipRings, cutsAtLevels, depthLevels, offsetRings, orderNearest, reversed } from './common.js';

/**
 * @param {object} ctx { op, tool, cutting, layer, mask, from, mirror }
 * @returns {{ cuts: object[], loops: number[][][], lines: number[][][], width: number, end: number[], issues: object[] }}
 */
export function isolation({ op, tool, cutting, layer, mask, from, mirror }) {
    const width = widthAtDepth(tool, op.depth);
    const step = width * (1 - op.overlap);
    // Seam: paths reach one tool width past the region edge so neighbouring
    // regions overlap instead of leaving slivers.
    const clip = mask ? G.offset(mask, width) : null;
    const levels = depthLevels(op.depth, cutting.stepdown);
    const cuts = [];
    const allLoops = [];
    const allLines = [];
    let at = from;
    for (let pass = 0; pass < op.passes; pass++) {
        let ringList = offsetRings(layer.image, width / 2 + pass * step);
        // Copper is on the left of normalised rings; climb milling (M3) keeps the
        // copper wall on the tool's right. Mirrored output turns the other way.
        if ((op.direction === 'climb') !== !!mirror) ringList = ringList.map(reversed);
        const { loops, lines } = clipRings(ringList, clip);
        allLoops.push(...loops);
        allLines.push(...lines);
        const ordered = orderNearest([...loops.map((loop) => ({ loop })), ...lines.map((line) => ({ line }))], at);
        at = ordered.end;
        for (const item of ordered.items) cuts.push(...cutsAtLevels(item, levels));
    }
    const issues = [];
    if (!cuts.length) issues.push({ severity: 'warning', code: 'empty-operation', message: `Isolation "${op.id}" produced no toolpaths (no copper in its region?)`, opId: op.id });
    return { cuts, loops: allLoops, lines: allLines, width, end: at, issues };
}
