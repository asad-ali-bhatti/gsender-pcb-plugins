// Excellon (NC drill) parser: round holes and slots (G85 or routed), in mm,
// with KiCad's X2 comments (file function, per-tool aperture function).
//
// As with Gerber, anything we cannot interpret with certainty is reported as
// an `error` issue rather than guessed.

const MM_PER_INCH = 25.4;
// Header statements that do not change geometry.
const BENIGN_HEADER = /^(VER,\d|DETECT,(ON|OFF)|ATC,(ON|OFF)|BLKD,\d|SBK,(ON|OFF)|TCST,(ON|OFF)|R,[A-Z]+|OM48|M47.*|G90|G05)$/;

/**
 * @param {string} text drill file contents
 * @returns {{
 *   format: 'excellon', units: 'mm'|'in'|null, fileAttributes: Record<string, string[]>,
 *   plated: boolean|null, tools: Record<number, object>, holes: object[], slots: object[],
 *   bounds: object|null, issues: object[]
 * }}
 */
export function parseExcellon(text) {
    const issues = [];
    const issue = (severity, code, message, line) => issues.push({ severity, code, message, line });
    const st = {
        units: null,
        zeros: null, // 'LZ' (leading zeros kept) | 'TZ' (trailing zeros kept) | null
        format: null, // [int, dec]
        formatFromComment: null,
        absolute: true,
        header: false,
        sawHeader: false,
        tool: null,
        pos: [null, null],
        mode: 'drill', // 'drill' | 'route'
        route: null, // { tool, points, down }
        pendingAttrs: {},
        warned: new Set(),
        done: false,
    };
    const fileAttributes = {};
    const tools = {};
    const holes = [];
    const slots = [];
    const once = (severity, code, message, line) => {
        if (st.warned.has(code)) return;
        st.warned.add(code);
        issue(severity, code, message, line);
    };

    const k = (line) => {
        if (!st.units) {
            once('error', 'units-missing', 'Units (METRIC/INCH) not set; assuming mm', line);
            st.units = 'mm';
        }
        return st.units === 'in' ? MM_PER_INCH : 1;
    };

    const number = (s, line) => {
        if (s.includes('.')) return Number(s) * k(line);
        const neg = s.startsWith('-');
        let digits = s.replace(/^[+-]/, '');
        let fmt = st.format ?? st.formatFromComment;
        if (!fmt) {
            fmt = st.units === 'in' ? [2, 4] : [3, 3];
            once('warning', 'format-assumed', `Integer coordinates without a digit format; assuming ${fmt[0]}:${fmt[1]}`, line);
        }
        const [int, dec] = fmt;
        let v;
        if (st.zeros === 'LZ') {
            v = Number(digits.padEnd(int + dec, '0')) / 10 ** dec;
        } else if (st.zeros === 'TZ' || digits.length === int + dec) {
            v = Number(digits) / 10 ** dec;
        } else {
            once('error', 'zeros-ambiguous', 'Integer coordinates without LZ/TZ and of varying length are ambiguous', line);
            v = Number(digits) / 10 ** dec;
        }
        return (neg ? -v : v) * k(line);
    };

    const coords = (s, line) => {
        const out = {};
        const re = /([XYIJA])([+-]?(?:\d+\.?\d*|\.\d+))/g;
        let m;
        while ((m = re.exec(s))) out[m[1]] = m[2];
        const p = [...st.pos];
        if (out.X !== undefined) p[0] = st.absolute ? number(out.X, line) : (p[0] ?? 0) + number(out.X, line);
        if (out.Y !== undefined) p[1] = st.absolute ? number(out.Y, line) : (p[1] ?? 0) + number(out.Y, line);
        return { p, raw: out };
    };

    const currentTool = (line) => {
        if (st.tool === null) {
            issue('error', 'no-tool', 'Coordinates before any tool was selected', line);
            return null;
        }
        const t = tools[st.tool];
        if (!t) {
            once('error', `tool-undefined-${st.tool}`, `Tool T${st.tool} is used but has no diameter`, line);
            return null;
        }
        return t;
    };

    const addHole = (p, line) => {
        const t = currentTool(line);
        if (!t) return;
        if (p[0] === null || p[1] === null) return issue('error', 'bad-coordinate', 'Hole without both X and Y', line);
        holes.push({ tool: t.number, diameter: t.diameter, x: p[0], y: p[1], attrs: t.attrs, line });
    };

    const addSlot = (points, line) => {
        const t = currentTool(line);
        if (!t) return;
        slots.push({ tool: t.number, diameter: t.diameter, path: points, attrs: t.attrs, line });
    };

    const endRoute = (line) => {
        const r = st.route;
        st.route = null;
        if (r && r.points.length >= 2) addSlot(r.points, line);
    };

    const defineTool = (s, line) => {
        const m = /^T(\d+)((?:[A-Z][+-]?(?:\d+\.?\d*|\.\d+))*)$/.exec(s);
        if (!m) return issue('error', 'bad-tool', `Cannot parse tool "${s}"`, line);
        const n = Number(m[1]);
        const fields = {};
        for (const f of m[2].matchAll(/([A-Z])([+-]?(?:\d+\.?\d*|\.\d+))/g)) fields[f[1]] = f[2];
        if (fields.C === undefined) return false; // a tool selection, not a definition
        const d = Number(fields.C) * k(line);
        if (!(d > 0)) return issue('error', 'bad-tool', `Tool T${n} has diameter ${fields.C}`, line);
        if (tools[n]) issue('warning', 'tool-redefined', `Tool T${n} redefined`, line);
        tools[n] = { number: n, diameter: d, attrs: st.pendingAttrs };
        st.pendingAttrs = {};
        return true;
    };

    const comment = (s) => {
        const x2 = /^#@!\s*T([FA])(\.?[^,]+)((?:,[^,]*)*)$/.exec(s);
        if (x2) {
            const values = x2[3] ? x2[3].slice(1).split(',') : [];
            if (x2[1] === 'F') fileAttributes[x2[2]] = values;
            else st.pendingAttrs = { ...st.pendingAttrs, [x2[2]]: values };
            return;
        }
        const fmt = /^FORMAT=\{(\d+):(\d+)\//.exec(s);
        if (fmt) st.formatFromComment = [Number(fmt[1]), Number(fmt[2])];
    };

    const units = (s, line) => {
        const m = /^(METRIC|INCH)(?:,(LZ|TZ))?(?:,(0*)\.(0*))?$/.exec(s);
        if (!m) return issue('error', 'bad-units', `Cannot parse "${s}"`, line);
        st.units = m[1] === 'INCH' ? 'in' : 'mm';
        if (m[2]) st.zeros = m[2];
        if (m[3] !== undefined) st.format = [m[3].length, m[4].length];
    };

    const lines = String(text).split(/\r?\n|\r/);
    for (let li = 0; li < lines.length && !st.done; li++) {
        const line = li + 1;
        let s = lines[li].trim();
        if (!s) continue;
        if (s.startsWith(';')) {
            comment(s.slice(1).trim());
            continue;
        }
        // Inline comments: everything after ';' or inside ( ... ).
        s = s.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim();
        if (!s) continue;

        if (s === 'M48') { st.header = true; st.sawHeader = true; continue; }
        if (st.header) {
            if (s === '%' || s === 'M95') { st.header = false; continue; }
            if (/^(METRIC|INCH)/.test(s)) { units(s, line); continue; }
            if (/^FMAT,/.test(s)) {
                if (s !== 'FMAT,2') issue('error', 'unsupported-format', `${s} is not supported (only FMAT,2)`, line);
                continue;
            }
            if (s === 'ICI,ON' || s === 'ICI') { st.absolute = false; continue; }
            if (s === 'ICI,OFF') { st.absolute = true; continue; }
            if (s === 'M71') { st.units = 'mm'; continue; }
            if (s === 'M72') { st.units = 'in'; continue; }
            if (/^T\d/.test(s)) {
                if (defineTool(s, line) === false) issue('warning', 'tool-select-in-header', `Tool selection "${s}" in header ignored`, line);
                continue;
            }
            if (BENIGN_HEADER.test(s)) continue;
            issue('error', 'unsupported-header', `Unsupported header statement "${s}"`, line);
            continue;
        }

        // --- body ---
        if (s === '%') continue; // some writers repeat the header terminator
        if (s === 'M30' || s === 'M00') { endRoute(line); st.done = true; continue; }
        if (s === 'M71') { st.units = 'mm'; continue; }
        if (s === 'M72') { st.units = 'in'; continue; }
        if (/^T\d+/.test(s)) {
            endRoute(line);
            // Tools may also be defined inline in the body (T1C0.8).
            const m = /^T(\d+)/.exec(s);
            if (/C/.test(s)) defineTool(s, line);
            st.tool = Number(m[1]);
            if (st.tool === 0) st.tool = null;
            continue;
        }
        if (s === 'G90') { st.absolute = true; continue; }
        if (s === 'G91') { st.absolute = false; continue; }
        if (s === 'G05' || s === 'G81') { endRoute(line); st.mode = 'drill'; continue; }
        if (s === 'M15') {
            if (st.route) st.route.down = true;
            else issue('error', 'route-plunge', 'M15 without a preceding G00 route start', line);
            continue;
        }
        if (s === 'M16' || s === 'M17') { endRoute(line); continue; }
        if (s === 'M70' || s === 'G40' || s === 'M09' || s === 'M08') continue;

        const g = /^G(\d\d)/.exec(s);
        if (g && !s.includes('G85')) {
            const code = Number(g[1]);
            const rest = s.slice(g[0].length);
            if (code === 0) {
                endRoute(line);
                const { p } = coords(rest, line);
                st.pos = p;
                st.mode = 'route';
                st.route = { points: [p], down: false };
                continue;
            }
            if (code === 1) {
                const { p } = coords(rest, line);
                if (!st.route) {
                    issue('error', 'route-without-start', 'G01 routing without G00 start', line);
                } else {
                    if (!st.route.down) issue('warning', 'route-not-plunged', 'G01 route before M15 plunge', line);
                    st.route.points.push(p);
                }
                st.pos = p;
                continue;
            }
            if (code === 2 || code === 3) {
                issue('error', 'unsupported-route-arc', 'Arc routing (G02/G03) in drill files is not supported', line);
                continue;
            }
            issue('error', 'unsupported-gcode', `Unsupported ${g[0]}`, line);
            continue;
        }

        if (/^[XY]/.test(s) && s.includes('G85')) {
            const [a, b] = s.split('G85');
            const start = coords(a, line).p;
            st.pos = start;
            const end = coords(b, line).p;
            st.pos = end;
            addSlot([start, end], line);
            continue;
        }

        const rep = /^R(\d+)(.*)$/.exec(s);
        if (rep) {
            // Repeat the last hole n times, stepping by the given X/Y each time.
            const n = Number(rep[1]);
            const raw = {};
            for (const f of rep[2].matchAll(/([XY])([+-]?(?:\d+\.?\d*|\.\d+))/g)) raw[f[1]] = number(f[2], line);
            for (let i = 0; i < n; i++) {
                st.pos = [(st.pos[0] ?? 0) + (raw.X ?? 0), (st.pos[1] ?? 0) + (raw.Y ?? 0)];
                addHole(st.pos, line);
            }
            continue;
        }

        if (/^[XY]/.test(s)) {
            const { p, raw } = coords(s, line);
            if (raw.I !== undefined || raw.J !== undefined || raw.A !== undefined) {
                issue('error', 'unsupported-arc', 'Arc parameters in a drill hit are not supported', line);
            }
            st.pos = p;
            if (st.mode === 'route') {
                if (st.route) st.route.points.push(p);
            } else {
                addHole(p, line);
            }
            continue;
        }

        if (s === 'M48') continue;
        issue('error', 'unsupported-statement', `Unsupported statement "${s}"`, line);
    }

    if (!st.sawHeader) issue('warning', 'no-header', 'No M48 header', undefined);
    if (!st.done) issue('warning', 'no-end', 'No M30 end-of-program: the file may be truncated', undefined);
    endRoute();

    let plated = null;
    const ff = fileAttributes['.FileFunction'];
    if (ff?.[0] === 'Plated') plated = true;
    else if (ff?.[0] === 'NonPlated') plated = false;

    return { format: 'excellon', units: st.units, fileAttributes, plated, tools, holes, slots, bounds: drillBounds(holes, slots), issues };
}

/** Bounds of all holes and slots including their radius, mm. */
function drillBounds(holes, slots) {
    let b = null;
    const grow = (x, y, r) => {
        b = b
            ? { xmin: Math.min(b.xmin, x - r), ymin: Math.min(b.ymin, y - r), xmax: Math.max(b.xmax, x + r), ymax: Math.max(b.ymax, y + r) }
            : { xmin: x - r, ymin: y - r, xmax: x + r, ymax: y + r };
    };
    for (const h of holes) grow(h.x, h.y, h.diameter / 2);
    for (const s of slots) for (const [x, y] of s.path) grow(x, y, s.diameter / 2);
    return b;
}

/** Whether a hole/slot is plated: from its tool's X2 attribute, else the file's. */
export function isPlated(item, file) {
    const af = item.attrs?.['.AperFunction'];
    if (af?.[0] === 'Plated') return true;
    if (af?.[0] === 'NonPlated') return false;
    return file.plated;
}
