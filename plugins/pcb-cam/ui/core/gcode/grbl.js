// Grbl / grblHAL G-code emitter. Input is the planned job from plan.js: steps
// (one per operation) with cuts already in machine coordinates.
//
// Conventions: mm (G21), absolute (G90), Z0 at the copper surface. No canned
// cycles (Grbl has no G81–G83), so pecking is written out as moves.

/** Rapid speed assumed for time estimates, mm/min. */
export const RAPID_ESTIMATE = 1500;
/** Clearance above the previous peck depth when re-entering a hole, mm. */
const PECK_CLEARANCE = 0.1;

/**
 * @param {object} job { name, setup, output, steps: [{ op, tool, cutting, face, cuts }] }
 * @param {{ title?: string }} [opts]
 * @returns {{ gcode: string, stats: object }}
 */
export function emitGrbl(job, { title } = {}) {
    const { setup, output, steps } = job;
    const dec = output.decimals;
    const fmt = (v) => {
        const s = (Math.round(v * 10 ** dec) / 10 ** dec).toFixed(dec).replace(/\.?0+$/, '');
        return s === '-0' ? '0' : s;
    };
    const lines = [];
    const out = (s) => lines.push(s);
    // Comments stay printable ASCII: some senders and controllers choke on anything else.
    const comment = (s) => out(`(${String(s).replace(/°/g, ' deg').replace(/⌀/g, 'D').replace(/[^\x20-\x7e]|[()]/g, '')})`);

    const pos = { x: null, y: null, z: null };
    let feed = null;
    let spindle = null; // current rpm
    let tool = null;
    const stats = { cutLength: 0, rapidLength: 0, plunges: 0, minutes: 0, toolChanges: 0, bounds: null };
    const grow = (x, y) => {
        const b = stats.bounds;
        stats.bounds = b
            ? { xmin: Math.min(b.xmin, x), ymin: Math.min(b.ymin, y), xmax: Math.max(b.xmax, x), ymax: Math.max(b.ymax, y) }
            : { xmin: x, ymin: y, xmax: x, ymax: y };
    };
    const delta = (v, cur) => (v === undefined || cur === null ? 0 : v - cur);
    const dist = (x, y, z) => Math.hypot(delta(x, pos.x), delta(y, pos.y), delta(z, pos.z));
    const words = (x, y, z) => {
        let s = '';
        if (x !== undefined && x !== pos.x) s += ` X${fmt(x)}`;
        if (y !== undefined && y !== pos.y) s += ` Y${fmt(y)}`;
        if (z !== undefined && z !== pos.z) s += ` Z${fmt(z)}`;
        return s;
    };
    const set = (x, y, z) => {
        if (x !== undefined) pos.x = x;
        if (y !== undefined) pos.y = y;
        if (z !== undefined) pos.z = z;
    };
    const rapid = (x, y, z) => {
        const w = words(x, y, z);
        if (!w) return;
        const d = dist(x, y, z);
        stats.rapidLength += d;
        stats.minutes += d / RAPID_ESTIMATE;
        out(`G0${w}`);
        set(x, y, z);
    };
    const linear = (x, y, z, f) => {
        const w = words(x, y, z);
        if (!w) return;
        const d = dist(x, y, z);
        stats.cutLength += d;
        stats.minutes += d / f;
        out(`G1${w}${f !== feed ? ` F${fmt(f)}` : ''}`);
        feed = f;
        set(x, y, z);
        grow(pos.x, pos.y);
    };

    comment(title ?? `PCB CAM: ${job.name}`);
    comment('Units mm, Z0 = copper surface / stock top');
    const used = [...new Map(steps.map((s) => [s.tool.id, s.tool])).values()];
    for (const t of used) comment(`T${t.toolNumber}: ${t.name}`);
    out('G90 G94 G17');
    out('G21');
    rapid(undefined, undefined, setup.safeZ);

    const multiTool = used.length > 1;
    const delay = output.spindleDelay ?? 2;
    let face = steps[0]?.face;
    for (const step of steps) {
        if (step.face !== face) {
            rapid(undefined, undefined, setup.safeZ);
            if (spindle) out('M5');
            spindle = null;
            comment(`Flip the board: ${step.face} side up`);
            out('M0');
            face = step.face;
        }
        comment(`${step.op.name || step.op.id}: ${step.op.type}, T${step.tool.toolNumber} ${step.tool.name}${step.face === 'bottom' ? ', bottom side (mirrored)' : ''}`);
        if (tool !== step.tool.id) {
            if (tool !== null || (multiTool && output.toolChange === 'm6')) {
                rapid(undefined, undefined, setup.safeZ);
                if (spindle) out('M5');
                spindle = null;
                if (output.toolChange === 'm6' && multiTool) {
                    out(`M6 T${step.tool.toolNumber}`);
                    stats.toolChanges++;
                }
            }
            tool = step.tool.id;
        }
        const rpm = step.cutting.rpm;
        if (rpm > 0 && spindle !== rpm) {
            out(`M3 S${fmt(rpm)}`);
            if (spindle === null && delay > 0) out(`G4 P${fmt(delay)}`);
            spindle = rpm;
        }
        const { feed: f, plunge: pf } = step.cutting;
        feed = null; // state the feed again for every operation
        let first = true;
        for (const cut of step.cuts) {
            const [x0, y0] = cut.kind === 'drill' ? [cut.x, cut.y] : cut.points[0];
            if (first) {
                rapid(undefined, undefined, setup.safeZ);
                rapid(x0, y0);
                first = false;
            } else {
                rapid(undefined, undefined, setup.travelZ);
                rapid(x0, y0);
            }
            rapid(undefined, undefined, setup.travelZ);
            stats.plunges++;
            if (cut.kind === 'drill') {
                const total = -cut.z;
                const n = cut.peck > 0 ? Math.max(1, Math.ceil(total / cut.peck - 1e-9)) : 1;
                for (let i = 1; i <= n; i++) {
                    linear(undefined, undefined, -(total * i) / n, pf);
                    if (i < n) {
                        rapid(undefined, undefined, setup.travelZ);
                        rapid(undefined, undefined, -(total * i) / n + PECK_CLEARANCE);
                    }
                }
                rapid(undefined, undefined, setup.travelZ);
                continue;
            }
            const pts = cut.points;
            linear(undefined, undefined, pts[0][2], pf);
            for (let i = 1; i < pts.length; i++) {
                const [x, y, z] = pts[i];
                const zOnly = x === pos.x && y === pos.y;
                linear(x, y, z, zOnly && z < pos.z ? pf : f);
            }
            rapid(undefined, undefined, setup.travelZ);
        }
    }
    rapid(undefined, undefined, setup.safeZ);
    if (spindle) out('M5');
    out('M30');
    return { gcode: lines.join('\n') + '\n', stats };
}
