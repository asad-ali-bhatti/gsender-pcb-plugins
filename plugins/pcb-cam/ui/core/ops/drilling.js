// Drilling: plunge (optionally pecked) holes with a drill, or with an end mill
// plunge holes its own size and helix-mill larger holes and slots.

import * as G from '../geometry.js';
import { isPlated } from '../import/excellon.js';
import { PATH_TOLERANCE, cutsAtLevels, depthLevels, offsetRings, orderNearest, reversed, round } from './common.js';

/** Hole and tool diameters closer than this count as the same size, mm. */
export const SIZE_TOL = 0.05;
/** An end mill plunges holes up to this much larger than itself instead of milling them, mm. */
const PLUNGE_TOL = 0.02;

/** Holes and slots selected by a drilling operation (filters and region), in file order. */
export function selectHoles(op, layer, mask) {
    const keep = (item, [x, y]) => {
        const plated = isPlated(item, layer);
        if (op.holes === 'plated' && plated !== true) return false;
        if (op.holes === 'nonplated' && plated !== false) return false;
        if (op.minDiameter !== undefined && item.diameter < op.minDiameter - 1e-6) return false;
        if (op.maxDiameter !== undefined && item.diameter > op.maxDiameter + 1e-6) return false;
        return !mask || G.containsPoint(mask, x, y);
    };
    return {
        holes: layer.holes.filter((h) => keep(h, [h.x, h.y])),
        slots: layer.slots.filter((s) => keep(s, s.path[0])),
    };
}

export function drilling({ op, tool, cutting, layer, mask, project, from, mirror }) {
    const issues = [];
    const depth = project.setup.stockThickness + op.breakthrough;
    const z = -depth;
    const peck = op.peck ?? 0;
    const { holes, slots } = selectHoles(op, layer, mask);
    const mismatch = new Map(); // diameter → count
    const tooSmall = new Map();
    const slotsSkipped = [];
    const items = [];

    for (const h of holes) {
        const diff = h.diameter - tool.diameter;
        if (tool.type === 'drill' || Math.abs(diff) <= PLUNGE_TOL) {
            if (tool.type === 'drill' && Math.abs(diff) > SIZE_TOL) mismatch.set(round(h.diameter, 3), (mismatch.get(round(h.diameter, 3)) ?? 0) + 1);
            items.push({ line: [[h.x, h.y]], drill: true });
        } else if (diff < 0) {
            tooSmall.set(round(h.diameter, 3), (tooSmall.get(round(h.diameter, 3)) ?? 0) + 1);
        } else {
            items.push({ line: [[h.x, h.y]], helix: { r: (h.diameter - tool.diameter) / 2 } });
        }
    }
    for (const s of slots) {
        if (tool.type === 'drill') {
            slotsSkipped.push(s);
            continue;
        }
        if (s.diameter < tool.diameter - PLUNGE_TOL) {
            tooSmall.set(round(s.diameter, 3), (tooSmall.get(round(s.diameter, 3)) ?? 0) + 1);
            continue;
        }
        if (s.diameter - tool.diameter <= PLUNGE_TOL) {
            items.push({ line: s.path.map(([x, y]) => [x, y]), slot: true });
            continue;
        }
        // Wider than the tool: concentric contours inside the slot outline.
        const outline = G.stroke(s.path, s.diameter, { tol: PATH_TOLERANCE });
        // Rings are counter-clockwise with the wall on the right: climb.
        for (let d = tool.diameter / 2; ; d += tool.diameter / 2) {
            const ringList = offsetRings(outline, -d);
            if (!ringList.length) break;
            for (const loop of ringList) items.push({ loop: mirror ? reversed(loop) : loop, slot: true });
        }
    }
    if (slotsSkipped.length) {
        const sizes = [...new Set(slotsSkipped.map((s) => round(s.diameter, 3)))].join(', ');
        issues.push({ severity: 'warning', code: 'slot-needs-endmill', message: `${slotsSkipped.length} slot(s) (⌀${sizes} mm) skipped: slots need an end mill`, opId: op.id, at: slotsSkipped[0].path[0] });
    }
    for (const [d, n] of mismatch) {
        issues.push({ severity: 'warning', code: 'drill-size-mismatch', message: `${n} hole(s) of ⌀${d} mm drilled with the ⌀${tool.diameter} mm drill "${tool.id}"`, opId: op.id });
    }
    for (const [d, n] of tooSmall) {
        issues.push({ severity: 'warning', code: 'hole-smaller-than-tool', message: `${n} hole(s)/slot(s) of ⌀${d} mm skipped: smaller than the ⌀${tool.diameter} mm tool "${tool.id}"`, opId: op.id });
    }
    if (!items.length) issues.push({ severity: 'warning', code: 'empty-operation', message: `Drilling "${op.id}" selected no holes`, opId: op.id });

    const ordered = orderNearest(items, from);
    const levels = depthLevels(depth, cutting.stepdown);
    const cuts = [];
    let count = 0;
    for (const item of ordered.items) {
        const [x, y] = item.points[0];
        if (item.drill) {
            cuts.push({ kind: 'drill', x, y, z, peck });
            count++;
        } else if (item.helix) {
            cuts.push(helix(x, y, item.helix.r, depth, cutting.stepdown, mirror ? -1 : 1));
            count++;
        } else {
            cuts.push(...cutsAtLevels(item, levels));
        }
    }
    return { cuts, holes: count, end: ordered.end, issues };
}

/**
 * Helix of radius `r` down to `depth`, then one full circle at the bottom.
 * `turn` 1 is counter-clockwise (climb inside a hole), -1 clockwise.
 */
export function helix(cx, cy, r, depth, pitch, turn = 1) {
    const n = Math.max(16, G.arcSegments(r, 2 * Math.PI, PATH_TOLERANCE));
    const turns = Math.max(1, Math.ceil(depth / pitch - 1e-9));
    const pts = [[cx + r, cy, 0]];
    for (let i = 1; i <= turns * n; i++) {
        const a = (turn * 2 * Math.PI * i) / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), -(depth * i) / (turns * n)]);
    }
    for (let i = 1; i <= n; i++) {
        const a = (turn * 2 * Math.PI * i) / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), -depth]);
    }
    return { kind: 'path', points: pts };
}
