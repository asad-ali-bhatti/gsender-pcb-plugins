// 2D geometry for PCB CAM: shape construction in millimetres, boolean ops and
// offsetting through clipper-lib in integer units. Pure module (no DOM / SDK),
// shared by the plugin UI and Node.
//
// Conventions:
// - A Point is [x, y] in mm. Construction helpers take and return mm.
// - A Path is an array of { X, Y } integer points in units (1 unit = 0.1 µm).
// - A Shape is an array of Paths filled with the non-zero rule. Shapes returned
//   by this module are normalised: outer rings counter-clockwise (positive
//   area), holes clockwise, no self-intersections.

import ClipperLib from '../vendor/clipper-lib.js';

const C = ClipperLib;

/**
 * Integer units per mm: 1 unit = 0.1 µm. clipper-lib switches to slow
 * big-integer maths beyond ±47,453,132 units, so this keeps everything within
 * ±4.7 m on the fast path (KiCad boards sit at page coordinates of 100–600 mm).
 */
export const SCALE = 1e4;
/** Default max deviation when approximating arcs and circles, in mm. */
export const ARC_TOLERANCE = 0.0005;

export const toUnits = (mm) => Math.round(mm * SCALE) + 0; // + 0 turns -0 into 0
export const toMm = (units) => units / SCALE;

/** mm points → Path. */
export function toPath(points) {
    return points.map(([x, y]) => ({ X: toUnits(x), Y: toUnits(y) }));
}

/** Path → mm points. */
export function fromPath(path) {
    return path.map((p) => [p.X / SCALE, p.Y / SCALE]);
}

// ---------------------------------------------------------------------------
// Construction (mm)
// ---------------------------------------------------------------------------

/** Number of segments so a chord deviates from an arc of `radius` by at most `tol`. */
export function arcSegments(radius, sweepRad, tol = ARC_TOLERANCE) {
    const r = Math.abs(radius);
    const sweep = Math.abs(sweepRad);
    if (r <= tol || sweep === 0) return 1;
    const step = 2 * Math.acos(1 - tol / r);
    return Math.max(1, Math.ceil(sweep / step));
}

/** Circle as a CCW polygon with vertices on the circle. */
export function circle(cx, cy, diameter, tol = ARC_TOLERANCE) {
    const r = diameter / 2;
    const n = Math.max(8, arcSegments(r, 2 * Math.PI, tol));
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
}

/** Axis-aligned rectangle centred on (cx, cy), CCW. */
export function rect(cx, cy, w, h) {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** Obround (stadium) centred on (cx, cy): rectangle w×h with fully rounded short ends, CCW. */
export function obround(cx, cy, w, h, tol = ARC_TOLERANCE) {
    if (Math.abs(w - h) < 1e-12) return circle(cx, cy, w, tol);
    const r = Math.min(w, h) / 2;
    const pts = [];
    // Centres of the two end semicircles.
    const horizontal = w > h;
    const d = (Math.max(w, h) - 2 * r) / 2;
    const c1 = horizontal ? [cx + d, cy] : [cx, cy + d];
    const c2 = horizontal ? [cx - d, cy] : [cx, cy - d];
    const start1 = horizontal ? -Math.PI / 2 : 0;
    const n = Math.max(4, arcSegments(r, Math.PI, tol));
    for (let i = 0; i <= n; i++) {
        const a = start1 + (Math.PI * i) / n;
        pts.push([c1[0] + r * Math.cos(a), c1[1] + r * Math.sin(a)]);
    }
    for (let i = 0; i <= n; i++) {
        const a = start1 + Math.PI + (Math.PI * i) / n;
        pts.push([c2[0] + r * Math.cos(a), c2[1] + r * Math.sin(a)]);
    }
    return pts;
}

/** Regular polygon with `n` vertices on a circle of `diameter`, first vertex at `rotationDeg`, CCW. */
export function regularPolygon(cx, cy, diameter, n, rotationDeg = 0) {
    const r = diameter / 2;
    const a0 = (rotationDeg * Math.PI) / 180;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = a0 + (2 * Math.PI * i) / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
}

/**
 * Points along an arc from `start` to `end` around `center`, excluding `start`
 * and ending exactly at `end`. `sweep` is the signed sweep angle in radians
 * (positive = CCW). The radius is interpolated from the start to the end
 * radius so slightly inconsistent arcs stay continuous.
 */
export function arcPoints(start, end, center, sweep, tol = ARC_TOLERANCE) {
    const [cx, cy] = center;
    const r0 = Math.hypot(start[0] - cx, start[1] - cy);
    const r1 = Math.hypot(end[0] - cx, end[1] - cy);
    const a0 = Math.atan2(start[1] - cy, start[0] - cx);
    const n = arcSegments(Math.max(r0, r1), sweep, tol);
    const pts = [];
    for (let i = 1; i < n; i++) {
        const t = i / n;
        const a = a0 + sweep * t;
        const r = r0 + (r1 - r0) * t;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    pts.push([end[0], end[1]]);
    return pts;
}

/** Convex hull (Andrew's monotone chain), CCW, no repeated end point. */
export function convexHull(points) {
    const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

/** Rotates mm points about the origin by `deg` (CCW positive). */
export function rotatePoints(points, deg) {
    if (!deg) return points;
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    return points.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

export function translatePoints(points, dx, dy) {
    return points.map(([x, y]) => [x + dx, y + dy]);
}

// ---------------------------------------------------------------------------
// Boolean ops and offsetting (Shapes)
// ---------------------------------------------------------------------------

function execute(clipType, subject, clip) {
    const c = new C.Clipper();
    // AddPaths ignores degenerate paths and reports whether any were added;
    // with no subject, every operation we use yields an empty result.
    if (!subject.length || !c.AddPaths(subject, C.PolyType.ptSubject, true)) return [];
    if (clip && clip.length) c.AddPaths(clip, C.PolyType.ptClip, true);
    const out = new C.Paths();
    const ok = c.Execute(clipType, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    if (!ok) throw new Error('Polygon operation failed');
    return out;
}

/**
 * Normalises arbitrary closed paths (any orientation, possibly self-overlapping)
 * into a Shape, filling with the non-zero rule.
 */
export function normalize(paths) {
    return execute(C.ClipType.ctUnion, paths.filter((p) => p.length >= 3));
}

/**
 * Like `normalize`, but each path is filled on its own first, so its
 * orientation does not matter (a clockwise ring does not cancel a
 * counter-clockwise one). Use for independent contours such as Gerber regions.
 */
export function fillEach(paths) {
    const parts = [];
    for (const p of paths) if (p.length >= 3) parts.push(...normalize([p]));
    return normalize(parts);
}

/** Union of normalised shapes. */
export function union(...shapes) {
    return execute(C.ClipType.ctUnion, shapes.flat());
}

export function difference(a, b) {
    if (!a.length) return [];
    if (!b.length) return a;
    return execute(C.ClipType.ctDifference, a, b);
}

export function intersection(a, b) {
    if (!a.length || !b.length) return [];
    return execute(C.ClipType.ctIntersection, a, b);
}

const JOIN = { round: C.JoinType.jtRound, miter: C.JoinType.jtMiter, square: C.JoinType.jtSquare };
const CAP = { round: C.EndType.etOpenRound, square: C.EndType.etOpenSquare, butt: C.EndType.etOpenButt };

function offsetter(join, tol) {
    if (!(join in JOIN)) throw new Error(`Unknown join type: ${join}`);
    return new C.ClipperOffset(2, Math.max(1, tol * SCALE));
}

/** Grows (delta > 0) or shrinks (delta < 0) a normalised shape by `delta` mm. */
export function offset(shape, delta, { join = 'round', tol = ARC_TOLERANCE } = {}) {
    if (!shape.length) return [];
    if (delta === 0) return shape;
    const co = offsetter(join, tol);
    co.AddPaths(shape, JOIN[join], C.EndType.etClosedPolygon);
    const out = new C.Paths();
    co.Execute(out, delta * SCALE);
    return normalize(out);
}

/**
 * Area swept by a pen of `width` mm along an open polyline of mm points.
 * A single point with a round cap gives a disc.
 */
export function stroke(points, width, { cap = 'round', join = 'round', tol = ARC_TOLERANCE } = {}) {
    if (!(width > 0) || !points.length) return [];
    if (!(cap in CAP)) throw new Error(`Unknown cap type: ${cap}`);
    let path = toPath(points);
    // Drop consecutive duplicates; clipper treats a 1-point open path as a dot.
    path = path.filter((p, i) => i === 0 || p.X !== path[i - 1].X || p.Y !== path[i - 1].Y);
    if (path.length === 1) {
        if (cap === 'butt') return [];
        if (cap === 'round') return normalize([toPath(circle(points[0][0], points[0][1], width, tol))]);
        return normalize([toPath(rect(points[0][0], points[0][1], width, width))]);
    }
    const co = offsetter(join, tol);
    co.AddPath(path, JOIN[join], CAP[cap]);
    const out = new C.Paths();
    co.Execute(out, (width / 2) * SCALE);
    return normalize(out);
}

/** Total filled area of a normalised shape, mm² (holes subtract). */
export function area(shape) {
    let a = 0;
    for (const p of shape) a += C.Clipper.Area(p);
    return a / (SCALE * SCALE);
}

/** Bounding box of a shape in mm, or null when empty. */
export function bounds(shape) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const path of shape) {
        for (const p of path) {
            if (p.X < xmin) xmin = p.X;
            if (p.X > xmax) xmax = p.X;
            if (p.Y < ymin) ymin = p.Y;
            if (p.Y > ymax) ymax = p.Y;
        }
    }
    if (xmin === Infinity) return null;
    return { xmin: xmin / SCALE, ymin: ymin / SCALE, xmax: xmax / SCALE, ymax: ymax / SCALE };
}

/** Merges bounding boxes (null entries are ignored). */
export function mergeBounds(...boxes) {
    let out = null;
    for (const b of boxes) {
        if (!b) continue;
        out = out
            ? { xmin: Math.min(out.xmin, b.xmin), ymin: Math.min(out.ymin, b.ymin), xmax: Math.max(out.xmax, b.xmax), ymax: Math.max(out.ymax, b.ymax) }
            : { ...b };
    }
    return out;
}

/** Splits a normalised shape into islands: [{ outer: Path, holes: Path[] }]. */
export function islands(shape) {
    if (!shape.length) return [];
    const c = new C.Clipper();
    c.AddPaths(shape, C.PolyType.ptSubject, true);
    const tree = new C.PolyTree();
    c.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    return C.JS.PolyTreeToExPolygons(tree).map((e) => ({ outer: e.outer, holes: e.holes }));
}

/** True when the mm point lies inside the shape (boundary counts as inside). */
export function containsPoint(shape, x, y) {
    const pt = { X: toUnits(x), Y: toUnits(y) };
    let winding = 0;
    for (const path of shape) {
        const r = C.Clipper.PointInPolygon(pt, path);
        if (r === -1) return true;
        if (r === 1) winding += C.Clipper.Orientation(path) ? 1 : -1;
    }
    return winding !== 0;
}
