// Built-in levelling: one height map per run, probed once over the jobs that
// cut at copper depth, then applied to each of those jobs exactly once (always
// to the regenerated original, never to a levelled file). Pure module: the
// probing and the G-code rewriting come from synced copies of the
// Autoleveler's scan.js and leveling.js, and machine access goes through `io`.
//
// The map is relative to the copper at X0 Y0 (zeroAt 'origin'), so it stays
// valid through every later Zero Z at X0 Y0. It is not valid once X0 Y0 moves:
// `originMoved` checks that before a levelled job loads.

import { gridPoints, createHeightMap, levelGcode, isComplete, mapStats, anchorIdx } from '../vendor/autoleveler/leveling.js';
import { runScan } from '../vendor/autoleveler/scan.js';
import { lineCount } from './jobs.js';

/** Operations that cut at copper depth and so follow the board's surface. */
export const LEVEL_OPS = new Set(['isolation', 'clearing']);
/** Whether a job file (or a whole job: any of its files) gets levelled. */
export const needsLevel = (f) => (f?.files ? f.files.some(needsLevel) : (f?.opTypes ?? []).some((t) => LEVEL_OPS.has(t)));

export const LEVEL_DEFAULTS = {
    margin: 1,        // mm past the jobs' cuts (on the high side; see probeArea)
    pitch: 10,        // mm between probe points, about
    minPoints: 3,     // per axis
    maxPoints: 12,    // per axis
    minSize: 2,       // mm: a narrower area is widened to this
    segment: 1,       // mm: long moves are split this fine when levelled
    maxBeyond: 1,     // mm a levelled job may run past the map before it is refused
    originTolerance: 0.05, // mm X0 Y0 may differ from where it was when probed
    secondsPerPoint: 8,
};

/** Autoleveler's scan settings, with work Z0 left where Zero Z put it. */
export const SCAN_SETTINGS = {
    clearance: 2, maxBelow: 1, firstTravel: 10, feed: 60, slowFeed: 15, backoff: 0.5,
    zeroFirst: false, zeroAt: 'origin',
};

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The area to probe: the cuts of every selected job that gets levelled, plus
 * the margin, stretched to include X0 Y0 (Z is zeroed there, so the map must
 * reach it). The low sides never go below 0 or the cuts themselves: X0 Y0 is
 * the board's corner, and past it there may be no copper to touch.
 * @returns {{ xmin, xmax, ymin, ymax } | null} null when no selected job is levelled
 */
export function probeArea(jobs, ids, s = LEVEL_DEFAULTS) {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    let b = null;
    for (const id of ids) {
        const j = byId.get(id);
        if (!j || j.status !== 'ready') continue;
        for (const f of j.files) {
            const fb = f.bounds;
            if (!fb || !needsLevel(f)) continue;
            b = b ? { xmin: Math.min(b.xmin, fb.xmin), ymin: Math.min(b.ymin, fb.ymin), xmax: Math.max(b.xmax, fb.xmax), ymax: Math.max(b.ymax, fb.ymax) } : { ...fb };
        }
    }
    if (!b) return null;
    const low = (v) => Math.min(0, Math.max(v - s.margin, Math.min(0, v)));
    const area = { xmin: low(b.xmin), ymin: low(b.ymin), xmax: Math.max(0, b.xmax + s.margin), ymax: Math.max(0, b.ymax + s.margin) };
    if (area.xmax - area.xmin < s.minSize) area.xmax = area.xmin + s.minSize;
    if (area.ymax - area.ymin < s.minSize) area.ymax = area.ymin + s.minSize;
    return { xmin: r3(area.xmin), xmax: r3(area.xmax), ymin: r3(area.ymin), ymax: r3(area.ymax) };
}

/** Grid over `area`: about `pitch` apart, 3 to 12 points per axis. */
export function autoGrid(area, s = LEVEL_DEFAULTS) {
    const n = (len) => Math.min(s.maxPoints, Math.max(s.minPoints, Math.ceil(len / s.pitch - 1e-9) + 1));
    return { ...area, nx: n(area.xmax - area.xmin), ny: n(area.ymax - area.ymin) };
}

/** Rough probing time for a grid, in minutes. */
export const probeMinutes = (grid, s = LEVEL_DEFAULTS) => (grid.nx * grid.ny * s.secondsPerPoint) / 60;

/** The probe step for a plan, or null when no selected job is levelled. */
export function probeStep(jobs, ids) {
    const area = probeArea(jobs, ids);
    if (!area) return null;
    return { id: 'probe', kind: 'probe', grid: autoGrid(area), status: 'pending', startedAt: null, endedAt: null, note: null };
}

const GRID_KEYS = ['xmin', 'xmax', 'ymin', 'ymax', 'nx', 'ny'];
export const sameGrid = (a, b) => !!a && !!b && GRID_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-6);

/** A partly probed map for this grid that a new scan can continue (its first point is measured). */
export const canResume = (map, grid) => !!map && sameGrid(map, grid) && !isComplete(map) && Number.isFinite(map.z[anchorIdx(map)]);

/**
 * Probes the map for `grid` into `map` (a new one unless it can be resumed).
 * `io` is the scan's io (see scan.js runScan); `onPoint(p, z, map)` follows each point.
 * @returns {Promise<object>} the map
 */
export async function probeMap(io, grid, map = null, { touchTest = true } = {}) {
    const resume = canResume(map, grid);
    const m = resume ? map : createHeightMap(grid);
    if (!resume) io.onMap?.(m);
    await runScan(io, SCAN_SETTINGS, m, gridPoints(grid), { resume, touchTest });
    return m;
}

/** How much the copper height varies over the map, in mm (null when incomplete). */
export const mapRange = (map) => (isComplete(map) ? mapStats(map).range : null);

/**
 * Whether X0 Y0 has moved since the map was probed. `origin` is the machine
 * XY of work X0 Y0 now (machine minus work position), `map.origin` the same
 * when probed. Unknown either side counts as not moved.
 */
export function originMoved(map, origin, s = LEVEL_DEFAULTS) {
    const o = map?.origin;
    if (!o || !origin) return false;
    return Math.abs(o.x - origin.x) > s.originTolerance || Math.abs(o.y - origin.y) > s.originTolerance;
}

/** gSender's name for a levelled file: "job.nc" → "job_leveled.nc". */
export const leveledName = (name) => String(name || 'job.nc').replace(/(\.[^.]+)?$/, (ext) => `_leveled${ext || '.nc'}`);

/**
 * Levels one job file with the map.
 * @returns {{ ok: true, gcode, lines, warnings: string[], beyond } | { ok: false, message, beyond }}
 */
export function levelFile(gcode, map, s = LEVEL_DEFAULTS) {
    if (!isComplete(map)) return { ok: false, message: 'The height map isn\'t complete. Probe the board first.', beyond: 0 };
    if (/\(Autoleveled by/.test(gcode)) return { ok: false, message: 'This file is already levelled.', beyond: 0 };
    const r = levelGcode(gcode, map, { segment: s.segment, zeroAt: 'origin' });
    const beyond = r.stats.beyond;
    if (beyond > s.maxBeyond) {
        return { ok: false, beyond, message: `This job goes ${beyond.toFixed(1)} mm past the height map. Probe again to cover it.` };
    }
    return { ok: true, gcode: r.gcode, lines: lineCount(r.gcode), warnings: r.warnings, beyond };
}
