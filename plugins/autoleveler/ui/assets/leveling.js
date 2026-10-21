// Pure height-map math and G-code rewriting. No gSender / DOM dependencies,
// so it can be unit tested under plain Node.

const MM_PER_INCH = 25.4;

/** Probe points in serpentine order (row 0 left→right, row 1 right→left, ...). */
export function gridPoints({ xmin, xmax, ymin, ymax, nx, ny }) {
    const pts = [];
    for (let j = 0; j < ny; j++) {
        const y = ny === 1 ? ymin : ymin + ((ymax - ymin) * j) / (ny - 1);
        for (let k = 0; k < nx; k++) {
            const i = j % 2 === 0 ? k : nx - 1 - k;
            const x = nx === 1 ? xmin : xmin + ((xmax - xmin) * i) / (nx - 1);
            pts.push({ i, j, x, y, idx: j * nx + i });
        }
    }
    return pts;
}

export function createHeightMap({ xmin, xmax, ymin, ymax, nx, ny }) {
    return {
        version: 1,
        xmin, xmax, ymin, ymax, nx, ny,
        z: new Array(nx * ny).fill(null),
        createdAt: new Date().toISOString(),
    };
}

export function validateGrid(g) {
    const errs = [];
    for (const k of ['xmin', 'xmax', 'ymin', 'ymax', 'nx', 'ny']) {
        if (!Number.isFinite(g[k])) errs.push(`${k} is not a number`);
    }
    if (errs.length) return errs;
    if (g.xmax <= g.xmin) errs.push('X max must be greater than X min');
    if (g.ymax <= g.ymin) errs.push('Y max must be greater than Y min');
    if (!Number.isInteger(g.nx) || g.nx < 2) errs.push('X points must be an integer ≥ 2');
    if (!Number.isInteger(g.ny) || g.ny < 2) errs.push('Y points must be an integer ≥ 2');
    if (g.nx * g.ny > 2500) errs.push('Too many points (max 2500)');
    return errs;
}

export function isComplete(map) {
    return !!map && Array.isArray(map.z) && map.z.length === map.nx * map.ny && map.z.every(Number.isFinite);
}

export function mapStats(map) {
    const vals = (map?.z || []).filter(Number.isFinite);
    if (!vals.length) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of vals) { min = Math.min(min, v); max = Math.max(max, v); sum += v; }
    return { min, max, range: max - min, mean: sum / vals.length, count: vals.length };
}

/** Bilinear interpolation in mm; points outside the grid are clamped to its edge. */
export function heightAt(map, x, y) {
    const { xmin, xmax, ymin, ymax, nx, ny, z } = map;
    const outside = x < xmin - 1e-6 || x > xmax + 1e-6 || y < ymin - 1e-6 || y > ymax + 1e-6;
    const fx = clamp(((x - xmin) / (xmax - xmin)) * (nx - 1), 0, nx - 1);
    const fy = clamp(((y - ymin) / (ymax - ymin)) * (ny - 1), 0, ny - 1);
    const i0 = Math.min(Math.floor(fx), nx - 2);
    const j0 = Math.min(Math.floor(fy), ny - 2);
    const tx = fx - i0;
    const ty = fy - j0;
    const z00 = z[j0 * nx + i0];
    const z10 = z[j0 * nx + i0 + 1];
    const z01 = z[(j0 + 1) * nx + i0];
    const z11 = z[(j0 + 1) * nx + i0 + 1];
    const v = z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty;
    const beyond = Math.max(0, xmin - x, x - xmax, ymin - y, y - ymax);
    return { z: v, outside, beyond };
}

/** Finds `[PRB:x,y,z(,a...):1]` in captured lines. Coordinates are machine coordinates. */
export function parsePRB(lines) {
    for (const line of lines || []) {
        const m = /^\[PRB:([^:\]]+):([01])\]/.exec(String(line).trim());
        if (m) {
            const c = m[1].split(',').map(Number);
            if (c.length >= 3 && c.slice(0, 3).every(Number.isFinite)) {
                return { x: c[0], y: c[1], z: c[2], ok: m[2] === '1' };
            }
        }
    }
    return null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const fmt = (v, decimals = 4) => {
    const s = Number(v.toFixed(decimals)).toString();
    return s === '-0' ? '0' : s;
};

const WORD_RE = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

function splitComment(raw) {
    let code = '';
    let comment = '';
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (depth === 0 && ch === ';') { comment += raw.slice(i); break; }
        if (ch === '(') depth++;
        if (depth > 0) comment += ch; else code += ch;
        if (ch === ')' && depth > 0) depth--;
    }
    return { code, comment: comment.trim() };
}

function parseWords(code) {
    const upper = code.toUpperCase();
    const words = [];
    let consumed = '';
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(upper))) {
        words.push({ letter: m[1], value: parseFloat(m[2]), text: m[0].replace(/\s+/g, '') });
        consumed += m[0];
    }
    // Anything left that isn't whitespace means we don't understand the line.
    const leftover = upper.replace(WORD_RE, '').replace(/\s+/g, '');
    return { words, ok: leftover === '' || leftover === '/' };
}

const NON_LEVELABLE_G = new Set([4, 10, 28, 28.1, 30, 30.1, 38.2, 38.3, 38.4, 38.5, 53, 92, 92.1, 92.2, 92.3]);

/**
 * Rewrites absolute-mode G0/G1/G2/G3 moves so Z follows the height map.
 * Long G1 moves are split into `segment` long pieces and XY arcs are linearised.
 *
 * @param {string} text   G-code
 * @param {object} map    complete height map (mm, work coordinates)
 * @param {object} opts   { segment (mm), reference: 'first' | 'absolute', name }
 */
export function levelGcode(text, map, opts = {}) {
    if (!isComplete(map)) throw new Error('Height map is incomplete');
    const segmentMm = opts.segment > 0 ? opts.segment : 1;
    const refZ = opts.reference === 'absolute' ? 0 : map.z[0];

    const out = [];
    const warnings = new Set();
    const stats = { inLines: 0, outLines: 0, levelled: 0, arcs: 0, outside: 0, beyond: 0, skipped: 0 };

    const st = {
        abs: true, absArc: false, inch: false, plane: 17, motion: null,
        pos: { x: null, y: null, z: null },
    };
    const toMm = (v) => (st.inch ? v * MM_PER_INCH : v);
    const dec = () => (st.inch ? 5 : 4);
    const offsetAt = (x, y) => {
        const h = heightAt(map, toMm(x), toMm(y));
        if (h.beyond > 0.01) { stats.outside++; stats.beyond = Math.max(stats.beyond, h.beyond); }
        const off = h.z - refZ;
        return st.inch ? off / MM_PER_INCH : off;
    };

    out.push(`(Autoleveled by gSender Autoleveler: ${map.nx}x${map.ny} grid, X${fmt(map.xmin, 3)}..${fmt(map.xmax, 3)} Y${fmt(map.ymin, 3)}..${fmt(map.ymax, 3)}, ref=${opts.reference === 'absolute' ? 'absolute' : 'first point'})`);

    const lines = String(text).split(/\r?\n/);
    for (const raw of lines) {
        stats.inLines++;
        const { code, comment } = splitComment(raw);
        if (!code.trim() || code.trim().startsWith('%')) { out.push(raw); continue; }
        const { words, ok } = parseWords(code);
        if (!ok || code.trim().startsWith('/')) { out.push(raw); stats.skipped++; continue; }

        const g = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10) / 10);
        const get = (L) => { const w = words.find((x) => x.letter === L); return w ? w.value : undefined; };

        // Modal updates (order inside a block doesn't matter for these).
        let motionWordInLine = false;
        for (const v of g) {
            if (v === 90) st.abs = true;
            else if (v === 91) st.abs = false;
            else if (v === 90.1) st.absArc = true;
            else if (v === 91.1) st.absArc = false;
            else if (v === 20) st.inch = true;
            else if (v === 21) st.inch = false;
            else if (v === 17 || v === 18 || v === 19) st.plane = v;
            else if (v === 0 || v === 1 || v === 2 || v === 3) { st.motion = v; motionWordInLine = true; }
            else if (v === 80) st.motion = null;
        }

        const X = get('X'), Y = get('Y'), Z = get('Z');
        const hasAxis = X !== undefined || Y !== undefined || Z !== undefined;
        const special = g.find((v) => NON_LEVELABLE_G.has(v));

        if (special !== undefined) {
            out.push(raw);
            if ([28, 30, 92, 92.1, 10].includes(special) || (special === 53 && hasAxis) || String(special).startsWith('38')) {
                // Position in work coordinates is no longer known for these axes.
                if (special === 28 || special === 30 || special === 92.1) st.pos = { x: null, y: null, z: null };
                else {
                    if (X !== undefined) st.pos.x = null;
                    if (Y !== undefined) st.pos.y = null;
                    if (Z !== undefined) st.pos.z = null;
                }
                if (special === 92 || special === 10) warnings.add(`G${special} changes coordinates mid-file; following moves may be mis-levelled`);
            }
            continue;
        }

        if (!hasAxis || st.motion === null) { out.push(raw); continue; }

        // Words we carry over unchanged onto the first emitted segment.
        const passthrough = words.filter((w) => {
            if ('XYZIJKRN'.includes(w.letter)) return false;
            if (w.letter === 'G' && [0, 1, 2, 3].includes(Math.round(w.value * 10) / 10)) return false;
            return true;
        }).map((w) => w.text);

        const motionPrefix = motionWordInLine ? '' : `G${st.motion} `;

        if (!st.abs) {
            warnings.add('Incremental (G91) moves are passed through un-levelled');
            out.push(motionPrefix + raw.trimStart());
            if (X !== undefined && st.pos.x !== null) st.pos.x += X;
            if (Y !== undefined && st.pos.y !== null) st.pos.y += Y;
            if (Z !== undefined && st.pos.z !== null) st.pos.z += Z;
            continue;
        }

        const start = { ...st.pos };
        const end = {
            x: X !== undefined ? X : start.x,
            y: Y !== undefined ? Y : start.y,
            z: Z !== undefined ? Z : start.z,
        };

        const known = end.x !== null && end.y !== null && end.z !== null;
        const arc = st.motion === 2 || st.motion === 3;
        if (!known || (arc && (start.x === null || start.y === null || start.z === null)) || (arc && st.plane !== 17)) {
            if (arc && st.plane !== 17) warnings.add('Arcs outside the XY plane (G18/G19) are passed through un-levelled');
            out.push(motionPrefix + raw.trimStart());
            st.pos = end;
            continue;
        }

        if (comment) out.push(comment);
        const extras = passthrough.length ? ' ' + passthrough.join(' ') : '';
        const d = dec();
        const emit = (gnum, p, first) => {
            out.push(`G${gnum} X${fmt(p.x, d)} Y${fmt(p.y, d)} Z${fmt(p.z + offsetAt(p.x, p.y), d)}${first ? extras : ''}`);
            stats.levelled++;
        };

        if (st.motion === 0 || start.x === null || start.y === null || start.z === null) {
            emit(st.motion === 0 ? 0 : 1, end, true);
        } else if (st.motion === 1) {
            const seg = st.inch ? segmentMm / MM_PER_INCH : segmentMm;
            const len = Math.hypot(end.x - start.x, end.y - start.y);
            const n = Math.max(1, Math.ceil(len / seg - 1e-9));
            for (let k = 1; k <= n; k++) {
                const t = k / n;
                emit(1, k === n ? end : {
                    x: start.x + (end.x - start.x) * t,
                    y: start.y + (end.y - start.y) * t,
                    z: start.z + (end.z - start.z) * t,
                }, k === 1);
            }
        } else {
            stats.arcs++;
            const pts = linearizeArc(start, end, st.motion === 2, {
                I: get('I'), J: get('J'), R: get('R'), absArc: st.absArc,
                seg: st.inch ? segmentMm / MM_PER_INCH : segmentMm,
            });
            if (!pts) {
                warnings.add('An arc could not be parsed and was passed through un-levelled');
                out.push(motionPrefix + raw.trimStart());
            } else {
                pts.forEach((p, k) => emit(1, p, k === 0));
            }
        }
        st.pos = end;
    }

    stats.outLines = out.length;
    if (stats.outside > 0) warnings.add(`${stats.outside} point(s), up to ${fmt(stats.beyond, 2)} mm, lie outside the probed area; the nearest edge heights were used there`);
    return { gcode: out.join('\n'), stats, warnings: [...warnings] };
}

/** Returns arc points (excluding start, including end) or null. */
export function linearizeArc(start, end, cw, { I, J, R, absArc, seg }) {
    let cx, cy;
    if (R !== undefined && I === undefined && J === undefined) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0) return null;
        let h = 4 * R * R - d2;
        h = h < 0 ? 0 : -Math.sqrt(h) / Math.sqrt(d2);
        if (!cw) h = -h;
        if (R < 0) h = -h;
        cx = start.x + 0.5 * (dx - dy * h);
        cy = start.y + 0.5 * (dy + dx * h);
    } else {
        const i = I ?? 0;
        const j = J ?? 0;
        cx = absArc ? i : start.x + i;
        cy = absArc ? j : start.y + j;
    }
    const r = Math.hypot(start.x - cx, start.y - cy);
    if (!(r > 0)) return null;
    const a0 = Math.atan2(start.y - cy, start.x - cx);
    const a1 = Math.atan2(end.y - cy, end.x - cx);
    let sweep = a1 - a0;
    const full = Math.hypot(end.x - start.x, end.y - start.y) < 1e-9;
    if (cw) { if (sweep >= -1e-12 || full) sweep -= 2 * Math.PI; if (full) sweep = -2 * Math.PI; }
    else { if (sweep <= 1e-12 || full) sweep += 2 * Math.PI; if (full) sweep = 2 * Math.PI; }
    const n = Math.max(1, Math.ceil(Math.abs(sweep) * r / seg), Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    const pts = [];
    for (let k = 1; k <= n; k++) {
        if (k === n) { pts.push({ ...end }); break; }
        const a = a0 + (sweep * k) / n;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: start.z + ((end.z - start.z) * k) / n });
    }
    return pts;
}
