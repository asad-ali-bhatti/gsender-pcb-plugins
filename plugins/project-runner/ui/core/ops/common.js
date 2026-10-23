// Shared helpers for toolpath operations.
//
// Toolpaths are plain data in mm. Z = 0 is the copper surface (stock top),
// cutting depths are negative. An operation produces a list of cuts:
// - { kind: 'path', points: [[x, y, z], ...] }: the tool plunges at the first
//   point, follows the points, then retracts.
// - { kind: 'drill', x, y, z, peck }: a plunge to `z`, in steps of `peck` mm
//   (0 = one plunge).

import * as G from '../geometry.js';

/** Max deviation for toolpath offsets, mm (coarser than the import tolerance to keep G-code small). */
export const PATH_TOLERANCE = 0.002;
/** Vertices closer than this are merged in toolpaths, mm. */
export const PATH_CLEAN = 0.001;

/** Whether `op` cuts in several passes; unset means on only for the through-board cuts (cutout, milled holes). */
export function multiDepth(op) {
    return op.multiDepth ?? (op.type === 'cutout' || op.type === 'drilling');
}

/** Max depth per pass for `op`: the tool's stepdown with multi-depth on, else the full `depth` in one pass. */
export function passDepth(op, cutting, depth) {
    return multiDepth(op) ? cutting.stepdown : depth;
}

/** Evenly spaced depth levels down to `depth` (positive), at most `stepdown` apart. Returns negative Z values. */
export function depthLevels(depth, stepdown) {
    const n = Math.max(1, Math.ceil(depth / stepdown - 1e-9));
    const out = [];
    for (let i = 1; i <= n; i++) out.push(-(depth * i) / n);
    return out;
}

/** Offsets a shape and returns its rings as closed mm polylines (filled side on the left). */
export function offsetRings(shape, delta) {
    const out = G.offset(shape, delta, { tol: PATH_TOLERANCE });
    return G.simplifyPaths(out, PATH_CLEAN).map(G.fromPath);
}

/** Rings of a shape as closed mm polylines. */
export function rings(shape) {
    return G.simplifyPaths(shape, PATH_CLEAN).map(G.fromPath);
}

/**
 * Clips closed rings (mm) to a mask Shape. Returns `{ loops, lines }`: rings
 * fully inside stay loops, cut rings become open lines (direction kept, pieces
 * that met at the ring's start joined again). A null mask keeps everything.
 */
export function clipRings(ringList, mask) {
    if (!mask) return { loops: ringList, lines: [] };
    const loops = [];
    const lines = [];
    for (const ring of ringList) {
        const path = G.toPath(ring);
        const pieces = G.clipOpen([[...path, path[0]]], mask).map(G.fromPath);
        if (!pieces.length) continue;
        if (pieces.length === 1 && samePoint(pieces[0][0], pieces[0][pieces[0].length - 1]) && pieces[0].length > 2) {
            loops.push(pieces[0].slice(0, -1));
            continue;
        }
        lines.push(...joinPieces(pieces));
    }
    return { loops, lines };
}

export const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** Joins open pieces where one ends exactly where another starts. */
export function joinPieces(pieces) {
    const list = pieces.map((p) => [...p]);
    let merged = true;
    while (merged) {
        merged = false;
        outer: for (let i = 0; i < list.length; i++) {
            for (let j = 0; j < list.length; j++) {
                if (i === j) continue;
                if (samePoint(list[i][list[i].length - 1], list[j][0])) {
                    list[i] = list[i].concat(list[j].slice(1));
                    list.splice(j, 1);
                    merged = true;
                    break outer;
                }
            }
        }
    }
    return list.filter((p) => G.polylineLength(p) > 1e-4);
}

function distToBox(p, b) {
    const dx = Math.max(b.xmin - p[0], 0, p[0] - b.xmax);
    const dy = Math.max(b.ymin - p[1], 0, p[1] - b.ymax);
    return Math.hypot(dx, dy);
}

function boxOf(points) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const [x, y] of points) {
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
    }
    return { xmin, ymin, xmax, ymax };
}

/**
 * Orders items by nearest neighbour starting at `from` ([x, y]). Items are
 * `{ loop: points }` (closed: may start at any vertex) or `{ line: points }`
 * (open: run as given). Returns `{ items: [{ points, closed, ...rest }], end }`
 * with loops rotated to start at their vertex nearest to the previous end.
 */
export function orderNearest(items, from = [0, 0]) {
    const left = items.map((it) => {
        const pts = it.loop ?? it.line;
        return { it, pts, closed: !!it.loop, box: it.loop ? boxOf(pts) : null };
    });
    const out = [];
    let at = from;
    while (left.length) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < left.length; i++) {
            const c = left[i];
            const d = c.closed ? distToBox(at, c.box) : Math.hypot(c.pts[0][0] - at[0], c.pts[0][1] - at[1]);
            if (d < bestD) { bestD = d; best = i; }
        }
        const [c] = left.splice(best, 1);
        let pts = c.pts;
        if (c.closed) {
            let k = 0, kd = Infinity;
            for (let i = 0; i < pts.length; i++) {
                const d = Math.hypot(pts[i][0] - at[0], pts[i][1] - at[1]);
                if (d < kd) { kd = d; k = i; }
            }
            pts = pts.slice(k).concat(pts.slice(0, k));
            at = pts[0];
        } else {
            at = pts[pts.length - 1];
        }
        const { loop, line, ...rest } = c.it;
        out.push({ ...rest, points: pts, closed: c.closed });
    }
    return { items: out, end: at };
}

/**
 * Turns an ordered 2D loop or line into cuts at the given depth levels. A loop
 * steps down in place and becomes one cut; a line becomes one cut per level.
 */
export function cutsAtLevels(item, levels) {
    const { points, closed } = item;
    if (closed) {
        const pts = [];
        for (const z of levels) {
            for (const [x, y] of points) pts.push([x, y, z]);
            pts.push([points[0][0], points[0][1], z]);
        }
        return [{ kind: 'path', points: pts }];
    }
    return levels.map((z) => ({ kind: 'path', points: points.map(([x, y]) => [x, y, z]) }));
}

export const reversed = (points) => [...points].reverse();

export const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
