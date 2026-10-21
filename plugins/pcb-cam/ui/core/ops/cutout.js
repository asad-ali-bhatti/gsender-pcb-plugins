// Board cutout: the outline offset by the tool radius, cut in depth levels,
// with holding tabs on the outer edge.

import * as G from '../geometry.js';
import { clipRings, cutsAtLevels, depthLevels, offsetRings, orderNearest, passDepth, reversed, rings } from './common.js';

export function cutout({ op, tool, cutting, board, mask, project, from, mirror }) {
    const issues = [];
    const r = tool.diameter / 2;
    const delta = op.side === 'outside' ? r : op.side === 'inside' ? -r : 0;
    let ringList = delta ? offsetRings(board, delta) : rings(board);
    const holesBefore = G.islands(board).reduce((n, i) => n + i.holes.length, 0);
    const holesAfter = ringList.filter((p) => G.area([G.toPath(p)]) < 0).length;
    if (op.side === 'outside' && holesAfter < holesBefore) {
        issues.push({ severity: 'warning', code: 'cutout-too-small', message: `${holesBefore - holesAfter} cut-out(s) inside the board are smaller than the ⌀${tool.diameter} mm tool and are skipped`, opId: op.id });
    }
    // Outer edges (counter-clockwise before any reversal) get the tabs.
    const outer = new Set(ringList.filter((p) => G.area([G.toPath(p)]) > 0));
    // The board is on the left of normalised rings; climb keeps it on the right.
    // Mirrored output turns the other way.
    if ((op.direction !== 'conventional') !== !!mirror) ringList = ringList.map((p) => (outer.has(p) ? markOuter(reversed(p)) : reversed(p)));
    else ringList = ringList.map((p) => (outer.has(p) ? markOuter(p) : p));

    const depth = project.setup.stockThickness + op.breakthrough;
    const levels = depthLevels(depth, passDepth(op, cutting, depth));
    const { loops, lines } = clipRings(ringList, mask);
    const ordered = orderNearest([...loops.map((loop) => ({ loop, outer: loop.outer })), ...lines.map((line) => ({ line }))], from);
    const tabTop = -project.setup.stockThickness + op.tabs.height;
    const tabbed = op.tabs.count > 0 && op.tabs.height > 0;
    const cuts = [];
    let tabs = 0;
    for (const item of ordered.items) {
        if (tabbed && item.closed && item.outer) {
            const len = G.polylineLength(item.points, true);
            const span = op.tabs.width + tool.diameter;
            if (span * op.tabs.count >= len) {
                issues.push({ severity: 'warning', code: 'tabs-too-wide', message: `${op.tabs.count} tabs of ${op.tabs.width} mm do not fit on an edge of ${len.toFixed(1)} mm`, opId: op.id, at: item.points[0] });
            } else {
                // Spaced from the loop's lowest-left vertex, not from where the cut
                // starts (that depends on the previous operation), so tabs stay put.
                const s0 = arcTo(item.points, lowestLeft(item.points));
                const intervals = [];
                for (let k = 0; k < op.tabs.count; k++) {
                    const c = (s0 + (len * (k + 0.5)) / op.tabs.count) % len;
                    const [a, b] = [c - span / 2, c + span / 2];
                    if (a < 0) intervals.push([a + len, len], [0, b]);
                    else if (b > len) intervals.push([a, len], [0, b - len]);
                    else intervals.push([a, b]);
                }
                cuts.push(tabbedLoop(item.points, levels, intervals, tabTop));
                tabs += op.tabs.count;
                continue;
            }
        }
        cuts.push(...cutsAtLevels(item, levels));
    }
    if (!cuts.length) issues.push({ severity: 'warning', code: 'empty-operation', message: `Cutout "${op.id}" produced no toolpaths`, opId: op.id });
    return { cuts, tabs, end: ordered.end, issues };
}

function lowestLeft(points) {
    let k = 0;
    for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        const [bx, by] = points[k];
        if (y < by - 1e-9 || (Math.abs(y - by) <= 1e-9 && x < bx)) k = i;
    }
    return k;
}

/** Arc length along `points` from the first vertex to vertex `k`. */
function arcTo(points, k) {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return s;
}

function markOuter(points) {
    const p = [...points];
    p.outer = true;
    return p;
}

/**
 * One cut around a closed loop for each depth level; below `tabTop`, the tool
 * rises to `tabTop` over each tab interval [s0, s1] (arc length from the start).
 */
function tabbedLoop(points, levels, tabs, tabTop) {
    const ring = [...points, points[0]];
    const out = [];
    const inTab = (s) => tabs.some(([a, b]) => s > a + 1e-9 && s < b - 1e-9);
    for (const z of levels) {
        if (z >= tabTop) {
            for (const [x, y] of ring) out.push([x, y, z]);
            continue;
        }
        let s = 0;
        out.push([ring[0][0], ring[0][1], inTab(0) ? tabTop : z]);
        for (let i = 1; i < ring.length; i++) {
            const [x0, y0] = ring[i - 1];
            const [x1, y1] = ring[i];
            const seg = Math.hypot(x1 - x0, y1 - y0);
            // Tab boundaries inside this segment, in order.
            const marks = [];
            for (const [a, b] of tabs) for (const m of [a, b]) if (m > s && m < s + seg) marks.push(m);
            marks.sort((a, b) => a - b);
            for (const m of marks) {
                const t = (m - s) / seg;
                const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
                out.push([x, y, inTab(m - 1e-6) ? tabTop : z]);
                out.push([x, y, inTab(m + 1e-6) ? tabTop : z]);
            }
            s += seg;
            out.push([x1, y1, inTab(s) ? tabTop : z]);
        }
    }
    return { kind: 'path', points: out };
}
