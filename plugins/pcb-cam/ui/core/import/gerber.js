// Gerber RS-274X / X2 parser and plotter. Produces the layer image (normalised
// Shape, mm) plus every graphical object with its X2 attributes, so later
// stages can select pads by component or net.
//
// Unsupported or ambiguous constructs are reported as `error` issues instead of
// being guessed: a layer with errors must not be machined.

import * as G from '../geometry.js';

const MM_PER_INCH = 25.4;

// Extended commands that carry no geometry and can be ignored.
const IGNORED_EXTENDED = new Set(['IN', 'LN']);

/**
 * @param {string} text Gerber file contents
 * @param {{ tol?: number }} [opts] arc/circle tolerance in mm
 * @returns {{
 *   format: 'gerber', units: 'mm'|'in'|null, fileAttributes: Record<string, string[]>,
 *   objects: object[], image: object[], bounds: object|null, extent: object|null, issues: object[]
 * }}
 */
export function parseGerber(text, { tol = G.ARC_TOLERANCE } = {}) {
    const issues = [];
    const issue = (severity, code, message, line) => issues.push({ severity, code, message, line });
    const p = new Plotter(issue, tol);
    for (const tok of tokenize(String(text), issue)) {
        if (p.done) {
            issue('warning', 'data-after-end', 'Data after M02 was ignored', tok.line);
            break;
        }
        if (tok.kind === 'word') p.word(tok);
        else p.extended(tok);
    }
    p.finish();
    const image = buildImage(p.objects);
    return {
        format: 'gerber',
        units: p.units,
        fileAttributes: p.fileAttributes,
        objects: p.objects,
        image,
        bounds: G.bounds(image),
        extent: extentOf(p.objects),
        issues,
    };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Splits the file into word commands (`X..Y..D01*`) and extended commands
 * (`%...*...*%`, one token holding all its words). CR/LF are not part of the
 * data and are dropped; spaces are kept (they matter in attribute values).
 */
export function tokenize(text, issue = () => {}) {
    const tokens = [];
    let buf = '';
    let line = 1;
    let start = 1;
    let ext = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') { line++; continue; }
        if (ch === '\r') continue;
        // '%' delimits an extended block only between words; inside a word
        // (e.g. a G04 comment or an attribute value) it is ordinary text.
        if (ch === '%' && buf.trim() === '') {
            buf = '';
            if (!ext) {
                ext = { kind: 'extended', words: [], line };
            } else {
                tokens.push(ext);
                ext = null;
            }
            continue;
        }
        if (ch === '*') {
            const w = buf.trim();
            if (ext) ext.words.push({ text: w, line: start });
            else if (w) tokens.push({ kind: 'word', text: w, line: start });
            buf = '';
            continue;
        }
        if (buf === '') start = line;
        buf += ch;
    }
    if (ext) issue('error', 'unterminated-extended', 'Extended command is missing its closing %', ext.line);
    if (buf.trim()) issue('error', 'unterminated-word', `Command without closing *: "${buf.trim().slice(0, 40)}"`, start);
    return tokens;
}

// ---------------------------------------------------------------------------
// Plotter
// ---------------------------------------------------------------------------

class Plotter {
    constructor(issue, tol) {
        this.issue = issue;
        this.tol = tol;
        this.units = null;
        this.k = null; // mm per file unit
        this.format = null; // { zero, x: [int, dec], y: [int, dec] }
        this.absolute = true;
        this.interp = 'linear';
        this.quadrant = null;
        this.regionMode = false;
        this.polarity = 'dark';
        this.rotation = 0;
        this.scale = 1;
        this.pos = [0, 0];
        this.aperture = null;
        this.lastOp = null;
        this.done = false;
        this.apertures = new Map();
        this.macros = new Map();
        this.fileAttributes = {};
        this.apertureAttrs = {};
        this.objectAttrs = {};
        this.objects = [];
        // Where new objects go: the main list, or an open SR / AB block.
        this.target = this.objects;
        this.blocks = []; // stack of { kind: 'SR'|'AB', ... , parent, objects }
        this.track = null;
        this.contour = null;
        this.warnedUnits = false;
        this.warnedFormat = false;
    }

    // --- words --------------------------------------------------------------

    word(tok) {
        const t = tok.text;
        if (/^G0*4(?!\d)/.test(t)) {
            const m = /^G0*4\s*#@!\s*(.*)$/.exec(t);
            if (m) this.attribute(m[1].trim(), tok.line);
            return;
        }
        const fields = [];
        const re = /([A-Z])([+-]?(?:\d+\.?\d*|\.\d+))/y;
        let at = 0;
        while (at < t.length) {
            re.lastIndex = at;
            const m = re.exec(t);
            if (!m) {
                this.issue('error', 'bad-command', `Cannot parse command "${t.slice(0, 40)}"`, tok.line);
                return;
            }
            fields.push([m[1], m[2]]);
            at = re.lastIndex;
        }
        const coords = {};
        let d = null;
        for (const [letter, value] of fields) {
            if (letter === 'G') this.gcode(Number(value), tok.line);
            else if (letter === 'D') d = Number(value);
            else if (letter === 'M') this.mcode(Number(value), tok.line);
            else if ('XYIJ'.includes(letter)) coords[letter] = value;
            else this.issue('error', 'bad-command', `Unknown code ${letter}${value}`, tok.line);
        }
        const hasCoords = Object.keys(coords).length > 0;
        if (d !== null && d >= 10) {
            if (hasCoords) this.issue('error', 'bad-command', 'Coordinates combined with an aperture selection', tok.line);
            this.selectAperture(d, tok.line);
        } else if (d === 1 || d === 2 || d === 3) {
            this.lastOp = d;
            this.operation(d, coords, tok.line);
        } else if (d !== null) {
            this.issue('error', 'bad-command', `Unknown operation D${d}`, tok.line);
        } else if (hasCoords) {
            if (this.lastOp === null) {
                this.issue('error', 'missing-operation', 'Coordinates without a D01/D02/D03 operation', tok.line);
            } else {
                this.issue('warning', 'modal-operation', `Coordinates without an operation code; repeating D0${this.lastOp} (deprecated)`, tok.line);
                this.operation(this.lastOp, coords, tok.line);
            }
        }
    }

    gcode(n, line) {
        switch (n) {
            case 1: this.interp = 'linear'; break;
            case 2: this.interp = 'cw'; break;
            case 3: this.interp = 'ccw'; break;
            case 74: this.quadrant = 'single'; break;
            case 75: this.quadrant = 'multi'; break;
            case 36:
                if (this.regionMode) this.issue('error', 'region-nested', 'G36 while already in region mode', line);
                this.flushTrack();
                this.regionMode = true;
                this.contour = null;
                break;
            case 37:
                if (!this.regionMode) this.issue('warning', 'region-end', 'G37 without G36', line);
                this.closeContour(line);
                this.regionMode = false;
                break;
            case 70: this.setUnits('in', line, true); break;
            case 71: this.setUnits('mm', line, true); break;
            case 90: this.absolute = true; break;
            case 91:
                this.absolute = false;
                this.issue('warning', 'incremental', 'Incremental coordinates (G91) are deprecated', line);
                break;
            case 54: case 55: break; // deprecated prefixes for aperture select / flash
            default:
                this.issue('error', 'unsupported-gcode', `Unsupported G${n}`, line);
        }
    }

    mcode(n, line) {
        if (n === 2 || n === 0 || n === 1) {
            if (n !== 2) this.issue('warning', 'deprecated-end', `M0${n} used as end of file (deprecated)`, line);
            this.done = true;
        } else {
            this.issue('error', 'unsupported-mcode', `Unsupported M${n}`, line);
        }
    }

    // --- extended commands --------------------------------------------------

    extended(tok) {
        const words = tok.words.filter((w) => w.text !== '');
        if (!words.length) return;
        const head = words[0].text;
        if (head.startsWith('AM')) {
            this.defineMacro(head.slice(2), words.slice(1), words[0].line);
            return;
        }
        // Some writers put several commands in one block: %FSLAX24Y24*MOIN*%
        for (const w of words) this.extendedCommand(w.text, w.line);
    }

    extendedCommand(t, line) {
        const code = t.slice(0, 2);
        const body = t.slice(2);
        switch (code) {
            case 'FS': return this.setFormat(body, line);
            case 'MO':
                if (body === 'MM') return this.setUnits('mm', line);
                if (body === 'IN') return this.setUnits('in', line);
                return this.issue('error', 'bad-units', `Unknown units "${body}"`, line);
            case 'AD': return this.defineAperture(body, line);
            case 'LP':
                this.flushTrack();
                if (body === 'D') this.polarity = 'dark';
                else if (body === 'C') this.polarity = 'clear';
                else this.issue('error', 'bad-polarity', `Unknown polarity "${body}"`, line);
                return;
            case 'LM':
                if (body !== 'N') this.issue('error', 'unsupported-mirror', `Aperture mirroring (LM${body}) is not supported`, line);
                return;
            case 'LR': {
                const v = Number(body);
                if (!Number.isFinite(v)) return this.issue('error', 'bad-rotation', `Bad rotation "${body}"`, line);
                this.flushTrack();
                this.rotation = v;
                return;
            }
            case 'LS': {
                const v = Number(body);
                if (!(v > 0)) return this.issue('error', 'bad-scale', `Bad scale "${body}"`, line);
                this.flushTrack();
                this.scale = v;
                return;
            }
            case 'SR': return this.stepRepeat(body, line);
            case 'AB': return this.apertureBlock(body, line);
            case 'TF': case 'TA': case 'TO': case 'TD':
                return this.attribute(t, line);
            case 'IP':
                if (body !== 'POS') this.issue('error', 'unsupported-image-polarity', `Image polarity ${body} is not supported`, line);
                return;
            case 'MI':
                if (!/^(A0)?(B0)?$/.test(body)) this.issue('error', 'unsupported-mirror-image', `Image mirroring (MI${body}) is not supported`, line);
                return;
            case 'OF':
                if (!/^(A0*\.?0*)?(B0*\.?0*)?$/.test(body)) this.issue('error', 'unsupported-offset', `Image offset (OF${body}) is not supported`, line);
                return;
            case 'SF':
                if (!/^(A1(\.0*)?)?(B1(\.0*)?)?$/.test(body)) this.issue('error', 'unsupported-scale-factor', `Image scale (SF${body}) is not supported`, line);
                return;
            case 'IR':
                if (!/^0*$/.test(body)) this.issue('error', 'unsupported-image-rotation', `Image rotation (IR${body}) is not supported`, line);
                return;
            case 'AS':
                if (body !== 'AXBY') this.issue('error', 'unsupported-axis-select', `Axis select ${body} is not supported`, line);
                return;
            default:
                if (IGNORED_EXTENDED.has(code)) return;
                this.issue('error', 'unsupported-command', `Unsupported command %${t.slice(0, 20)}%`, line);
        }
    }

    setFormat(body, line) {
        const m = /^([LTD]?)([AI])(?:N\d+)?(?:G\d+)?X(\d)(\d)Y(\d)(\d)(?:D\d+)?(?:M\d+)?$/.exec(body);
        if (!m) return this.issue('error', 'bad-format', `Cannot parse format "FS${body}"`, line);
        if (m[2] === 'I') {
            this.absolute = false;
            this.issue('warning', 'incremental', 'Incremental coordinates are deprecated', line);
        }
        if (m[1] === 'T') this.issue('warning', 'trailing-zeros', 'Trailing zero omission is deprecated', line);
        this.format = { zero: m[1] === 'T' ? 'T' : 'L', x: [+m[3], +m[4]], y: [+m[5], +m[6]] };
    }

    setUnits(units, line, deprecated = false) {
        if (deprecated) this.issue('warning', 'deprecated-units', `G${units === 'in' ? 70 : 71} units command is deprecated`, line);
        if (this.units && this.units !== units) {
            this.issue('error', 'units-changed', `Units changed from ${this.units} to ${units} mid-file`, line);
        }
        this.units = units;
        this.k = units === 'in' ? MM_PER_INCH : 1;
    }

    /** mm per file unit; reports (once) and assumes mm when MO is missing. */
    unitScale(line) {
        if (this.k === null) {
            if (!this.warnedUnits) this.issue('error', 'units-missing', 'Units (MO) not set before first use; assuming mm', line);
            this.warnedUnits = true;
            this.k = 1;
        }
        return this.k;
    }

    coordinate(str, axis, line) {
        if (!this.format && !this.warnedFormat) {
            this.issue('error', 'format-missing', 'Coordinate format (FS) not set; assuming 3.6 leading-zero omission', line);
            this.warnedFormat = true;
        }
        const fmt = this.format || { zero: 'L', x: [3, 6], y: [3, 6] };
        const [int, dec] = axis === 'Y' || axis === 'J' ? fmt.y : fmt.x;
        let v;
        if (str.includes('.')) {
            v = Number(str);
        } else {
            const neg = str.startsWith('-');
            let digits = str.replace(/^[+-]/, '');
            if (fmt.zero === 'T') digits = digits.padEnd(int + dec, '0');
            v = Number(digits) / 10 ** dec;
            if (neg) v = -v;
        }
        return v * this.unitScale(line);
    }

    // --- attributes ---------------------------------------------------------

    attribute(t, line) {
        const kind = t.slice(0, 2);
        const rest = t.slice(2);
        if (kind === 'TD') {
            this.flushTrack();
            if (rest === '') {
                this.apertureAttrs = {};
                this.objectAttrs = {};
            } else {
                delete this.apertureAttrs[rest];
                delete this.objectAttrs[rest];
            }
            return;
        }
        const parts = rest.split(',').map(decodeAttr);
        const name = parts.shift();
        if (!name) return this.issue('warning', 'bad-attribute', `Attribute without a name: "${t}"`, line);
        if (kind === 'TF') this.fileAttributes[name] = parts;
        else if (kind === 'TA') this.apertureAttrs = { ...this.apertureAttrs, [name]: parts };
        else if (kind === 'TO') {
            this.flushTrack();
            this.objectAttrs = { ...this.objectAttrs, [name]: parts };
        } else this.issue('warning', 'bad-attribute', `Unknown attribute command "${kind}"`, line);
    }

    // --- apertures ----------------------------------------------------------

    defineAperture(body, line) {
        const m = /^D(\d+)([A-Za-z_.$][^,]*?)(?:,(.*))?$/.exec(body);
        if (!m) return this.issue('error', 'bad-aperture', `Cannot parse aperture "AD${body}"`, line);
        const code = Number(m[1]);
        if (code < 10) return this.issue('error', 'bad-aperture', `Aperture number D${code} is reserved`, line);
        const name = m[2];
        const params = m[3] === undefined || m[3] === '' ? [] : m[3].split('X').map(Number);
        if (params.some((v) => !Number.isFinite(v))) return this.issue('error', 'bad-aperture', `Bad aperture parameters "${m[3]}"`, line);
        if (this.apertures.has(code)) this.issue('warning', 'aperture-redefined', `Aperture D${code} redefined`, line);
        const k = this.unitScale(line);
        let ap;
        try {
            ap = standardAperture(name, params, k, this.tol) ?? this.macroAperture(name, params, k, line);
        } catch (e) {
            return this.issue('error', 'bad-aperture', `D${code}: ${e.message}`, line);
        }
        if (!ap) return;
        ap.code = code;
        ap.attrs = { ...this.apertureAttrs };
        this.apertures.set(code, ap);
    }

    defineMacro(name, words, line) {
        if (!name) return this.issue('error', 'bad-macro', 'Aperture macro without a name', line);
        this.macros.set(name, words.map((w) => ({ text: w.text, line: w.line })));
    }

    macroAperture(name, params, k, line) {
        const body = this.macros.get(name);
        if (!body) {
            this.issue('error', 'unknown-aperture-template', `Unknown aperture template or macro "${name}"`, line);
            return null;
        }
        const shape = evaluateMacro(body, params, k, this.tol);
        return { template: name, params, shape, macro: true };
    }

    apertureBlock(body, line) {
        this.flushTrack();
        if (body === '') {
            const top = this.blocks[this.blocks.length - 1];
            if (!top || top.kind !== 'AB') return this.issue('error', 'aperture-block', 'AB close without an open block', line);
            this.blocks.pop();
            this.target = top.parent;
            this.apertures.set(top.code, { code: top.code, template: 'block', params: [], block: top.objects, shape: null, attrs: {} });
            return;
        }
        const m = /^D(\d+)$/.exec(body);
        if (!m || Number(m[1]) < 10) return this.issue('error', 'aperture-block', `Bad aperture block "AB${body}"`, line);
        const blk = { kind: 'AB', code: Number(m[1]), parent: this.target, objects: [] };
        this.blocks.push(blk);
        this.target = blk.objects;
    }

    stepRepeat(body, line) {
        this.flushTrack();
        const top = this.blocks[this.blocks.length - 1];
        if (top && top.kind === 'SR') this.closeStepRepeat(top, line);
        if (body === '') return;
        const m = /^X(\d+)Y(\d+)I([\d.]+)J([\d.]+)$/.exec(body);
        if (!m) return this.issue('error', 'bad-step-repeat', `Cannot parse "SR${body}"`, line);
        const nx = +m[1], ny = +m[2];
        if (nx < 1 || ny < 1) return this.issue('error', 'bad-step-repeat', 'Step & repeat counts must be ≥ 1', line);
        if (nx === 1 && ny === 1) return; // a 1×1 block is a no-op
        const k = this.unitScale(line);
        const blk = { kind: 'SR', nx, ny, dx: +m[3] * k, dy: +m[4] * k, parent: this.target, objects: [], line };
        this.blocks.push(blk);
        this.target = blk.objects;
    }

    closeStepRepeat(blk, line) {
        this.blocks.pop();
        this.target = blk.parent;
        const src = blk.objects;
        if (src.some((o) => o.polarity === 'clear') && blockCopiesOverlap(src, blk)) {
            this.issue('error', 'step-repeat-overlap', 'Overlapping step & repeat copies with clear polarity are ambiguous', line ?? blk.line);
        }
        for (let j = 0; j < blk.ny; j++) {
            for (let i = 0; i < blk.nx; i++) {
                for (const o of src) this.target.push(translateObject(o, i * blk.dx, j * blk.dy));
            }
        }
    }

    selectAperture(code, line) {
        this.flushTrack();
        if (this.regionMode) this.issue('warning', 'aperture-in-region', 'Aperture selected inside a region (ignored by regions)', line);
        const ap = this.apertures.get(code);
        if (!ap) this.issue('error', 'unknown-aperture', `Aperture D${code} is not defined`, line);
        this.aperture = ap ?? null;
    }

    // --- operations ---------------------------------------------------------

    operation(d, c, line) {
        const prev = this.pos;
        let x = prev[0], y = prev[1];
        if (c.X !== undefined) x = this.absolute ? this.coordinate(c.X, 'X', line) : prev[0] + this.coordinate(c.X, 'X', line);
        if (c.Y !== undefined) y = this.absolute ? this.coordinate(c.Y, 'Y', line) : prev[1] + this.coordinate(c.Y, 'Y', line);
        const i = c.I !== undefined ? this.coordinate(c.I, 'I', line) : 0;
        const j = c.J !== undefined ? this.coordinate(c.J, 'J', line) : 0;
        const next = [x, y];
        this.pos = next;

        if (this.regionMode) {
            if (d === 3) return this.issue('error', 'flash-in-region', 'D03 is not allowed in a region', line);
            if (d === 2) {
                this.closeContour(line);
                this.contour = { points: [next], line };
                return;
            }
            if (!this.contour) this.contour = { points: [prev], line };
            this.contour.points.push(...this.segment(prev, next, i, j, line));
            return;
        }

        if (d === 2) return this.flushTrack();
        if (d === 3) {
            this.flushTrack();
            return this.flash(next, line);
        }
        // D01: draw
        const ap = this.aperture;
        if (!ap) return this.issue('error', 'no-aperture', 'D01 without a selected aperture', line);
        if (!ap.stroke) {
            return this.issue('error', 'stroke-aperture', `Aperture D${ap.code} (${ap.template}) cannot be used for drawing`, line);
        }
        if (this.interp !== 'linear' && ap.stroke.kind !== 'circle') {
            this.issue('warning', 'arc-noncircular', `Arc drawn with non-circular aperture D${ap.code} (not allowed by the spec)`, line);
        }
        if (this.track && this.track.aperture !== ap) this.flushTrack();
        if (!this.track) this.track = { aperture: ap, points: [prev], line };
        this.track.points.push(...this.segment(prev, next, i, j, line));
    }

    /** Points from `a` (exclusive) to `b` for the current interpolation mode. */
    segment(a, b, i, j, line) {
        if (this.interp === 'linear') return [b];
        const cw = this.interp === 'cw';
        let quadrant = this.quadrant;
        if (!quadrant) {
            this.issue('warning', 'quadrant-missing', 'Arc without G74/G75; assuming single-quadrant (G74)', line);
            this.quadrant = quadrant = 'single';
        }
        let center, sweep;
        if (quadrant === 'multi') {
            center = [a[0] + i, a[1] + j];
            if (a[0] === b[0] && a[1] === b[1]) sweep = cw ? -2 * Math.PI : 2 * Math.PI;
            else sweep = sweepAngle(a, b, center, cw);
        } else {
            if (a[0] === b[0] && a[1] === b[1]) return [b];
            let best = null;
            for (const sx of [1, -1]) {
                for (const sy of [1, -1]) {
                    const c = [a[0] + sx * Math.abs(i), a[1] + sy * Math.abs(j)];
                    const s = sweepAngle(a, b, c, cw);
                    if (Math.abs(s) > Math.PI / 2 + 1e-6) continue;
                    const err = Math.abs(Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]));
                    if (!best || err < best.err) best = { c, s, err };
                }
            }
            if (!best) {
                this.issue('error', 'arc-center', 'No valid single-quadrant arc center', line);
                return [b];
            }
            center = best.c;
            sweep = best.s;
        }
        const r0 = Math.hypot(a[0] - center[0], a[1] - center[1]);
        const r1 = Math.hypot(b[0] - center[0], b[1] - center[1]);
        if (Math.abs(r0 - r1) > 0.002) {
            this.issue('warning', 'arc-radius', `Arc start/end radius differ by ${(Math.abs(r0 - r1)).toFixed(4)} mm`, line);
        }
        return G.arcPoints(a, b, center, sweep, this.tol);
    }

    flash(at, line) {
        const ap = this.aperture;
        if (!ap) return this.issue('error', 'no-aperture', 'D03 without a selected aperture', line);
        if (ap.block) {
            if (this.polarity === 'clear') {
                return this.issue('error', 'unsupported-block-clear', 'Flashing an aperture block with clear polarity is not supported', line);
            }
            if (this.rotation || this.scale !== 1) {
                return this.issue('error', 'unsupported-block-transform', 'Rotated or scaled aperture blocks are not supported', line);
            }
            for (const o of ap.block) this.target.push(translateObject(o, at[0], at[1]));
            return;
        }
        const shape = translateShape(transformShape(ap.shape, this.rotation, this.scale), at[0], at[1]);
        this.target.push({
            kind: 'flash',
            polarity: this.polarity,
            aperture: ap.code,
            at,
            shape,
            apertureAttrs: ap.attrs,
            attrs: { ...this.objectAttrs },
            line,
        });
    }

    flushTrack() {
        const t = this.track;
        this.track = null;
        if (!t) return;
        const ap = t.aperture;
        const s = ap.stroke;
        let shape;
        let width = null;
        if (s.kind === 'circle') {
            width = s.diameter * this.scale;
            shape = width > 0 ? G.stroke(t.points, width, { tol: this.tol }) : [];
        } else {
            shape = sweepConvex(t.points, transformPoints(s.ring, this.rotation, this.scale));
        }
        this.target.push({
            kind: 'stroke',
            polarity: this.polarity,
            aperture: ap.code,
            path: t.points,
            width,
            shape,
            apertureAttrs: ap.attrs,
            attrs: { ...this.objectAttrs },
            line: t.line,
        });
    }

    closeContour(line) {
        const c = this.contour;
        this.contour = null;
        if (!c) return;
        const pts = c.points;
        if (pts.length < 2) return;
        const first = pts[0], last = pts[pts.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-9) {
            this.issue('warning', 'region-open', 'Region contour is not closed; closing it', c.line ?? line);
        }
        const shape = G.fillEach([G.toPath(pts)]);
        this.target.push({
            kind: 'region',
            polarity: this.polarity,
            aperture: null,
            contour: pts,
            shape,
            apertureAttrs: { ...this.apertureAttrs },
            attrs: { ...this.objectAttrs },
            line: c.line,
        });
    }

    finish() {
        this.flushTrack();
        if (this.regionMode) {
            this.issue('error', 'region-unterminated', 'File ends inside a region (missing G37)', undefined);
            this.closeContour();
            this.regionMode = false;
        }
        while (this.blocks.length) {
            const top = this.blocks[this.blocks.length - 1];
            if (top.kind === 'SR') this.closeStepRepeat(top);
            else {
                this.issue('error', 'aperture-block', 'File ends inside an aperture block', undefined);
                this.blocks.pop();
                this.target = top.parent;
            }
        }
        if (!this.done) this.issue('warning', 'no-end', 'No M02 end-of-file command: the file may be truncated', undefined);
    }
}

// ---------------------------------------------------------------------------
// Standard apertures
// ---------------------------------------------------------------------------

/** C / R / O / P apertures, or null for macro names. Sizes are scaled by `k` to mm. */
function standardAperture(name, params, k, tol) {
    const p = params.map((v) => v * k);
    const need = (min, max) => {
        if (params.length < min || params.length > max) throw new Error(`${name} needs ${min}–${max} parameters, got ${params.length}`);
    };
    let ring;
    let stroke = null;
    let holeIndex;
    switch (name) {
        case 'C': {
            need(1, 3);
            if (!(p[0] >= 0)) throw new Error('circle diameter must be ≥ 0');
            ring = p[0] > 0 ? G.circle(0, 0, p[0], tol) : null;
            holeIndex = 1;
            if (params.length === 1) stroke = { kind: 'circle', diameter: p[0] };
            break;
        }
        case 'R': case 'O': {
            need(2, 4);
            if (!(p[0] > 0 && p[1] > 0)) throw new Error('width and height must be > 0');
            ring = name === 'R' ? G.rect(0, 0, p[0], p[1]) : G.obround(0, 0, p[0], p[1], tol);
            holeIndex = 2;
            if (params.length === 2) stroke = { kind: 'convex', ring };
            break;
        }
        case 'P': {
            need(2, 4);
            const n = params[1];
            if (!(p[0] > 0)) throw new Error('polygon diameter must be > 0');
            if (!Number.isInteger(n) || n < 3 || n > 12) throw new Error('polygon needs 3–12 vertices');
            ring = G.regularPolygon(0, 0, p[0], n, params[2] ?? 0);
            holeIndex = 3;
            if (params.length <= 3) stroke = { kind: 'convex', ring };
            break;
        }
        default:
            return null;
    }
    let shape = ring ? G.normalize([G.toPath(ring)]) : [];
    const hole = p.slice(holeIndex);
    if (hole.length === 1 && hole[0] > 0) {
        shape = G.difference(shape, G.normalize([G.toPath(G.circle(0, 0, hole[0], tol))]));
    } else if (hole.length === 2 && name !== 'P') {
        // Rectangular holes were removed from the spec but still appear in old files.
        shape = G.difference(shape, G.normalize([G.toPath(G.rect(0, 0, hole[0], hole[1]))]));
    } else if (hole.length > 1) {
        throw new Error('bad hole parameters');
    }
    return { template: name, params, shape, stroke };
}

// ---------------------------------------------------------------------------
// Aperture macros
// ---------------------------------------------------------------------------

/**
 * Evaluates a macro body with the AD parameters. Primitive coordinates are in
 * file units; they are scaled by `k` to mm. Returns a normalised Shape.
 */
export function evaluateMacro(body, params, k, tol = G.ARC_TOLERANCE) {
    const vars = new Map(params.map((v, i) => [i + 1, v]));
    const ftol = tol / k; // tolerance in file units
    let shape = [];
    for (const { text } of body) {
        if (/^0(?![\d.])/.test(text)) continue; // comment primitive
        const t = text.replace(/\s+/g, '');
        if (!t) continue;
        const assign = /^\$(\d+)=(.*)$/.exec(t);
        if (assign) {
            vars.set(Number(assign[1]), evalExpression(assign[2], vars));
            continue;
        }
        const [codeStr, ...mods] = t.split(',');
        const code = Number(codeStr);
        const m = mods.map((e) => evalExpression(e, vars));
        const prim = macroPrimitive(code, m, k, ftol);
        if (!prim) continue;
        shape = prim.on ? G.union(shape, prim.shape) : G.difference(shape, prim.shape);
    }
    return shape;
}

function macroPrimitive(code, m, k, ftol) {
    const need = (n, label) => {
        if (m.length < n) throw new Error(`macro ${label} primitive needs ${n} modifiers, got ${m.length}`);
    };
    const exposure = (v) => {
        if (v !== 0 && v !== 1) throw new Error(`exposure must be 0 or 1, got ${v}`);
        return v === 1;
    };
    // Rotation is about the macro origin; then scale file units to mm.
    const place = (points, rot) => G.toPath(G.rotatePoints(points, rot).map(([x, y]) => [x * k, y * k]));
    const fill = (points, rot) => G.fillEach([place(points, rot)]);
    switch (code) {
        case 1: { // circle: exposure, diameter, cx, cy[, rotation]
            need(4, 'circle');
            if (!(m[1] >= 0)) throw new Error('circle diameter must be ≥ 0');
            return { on: exposure(m[0]), shape: m[1] > 0 ? fill(G.circle(m[2], m[3], m[1], ftol), m[4] ?? 0) : [] };
        }
        case 2: case 20: { // vector line: exposure, width, sx, sy, ex, ey, rotation
            need(7, 'vector line');
            const [, w, sx, sy, ex, ey, rot] = m;
            const len = Math.hypot(ex - sx, ey - sy);
            if (!(w > 0) || len === 0) return { on: exposure(m[0]), shape: [] };
            const nx = (-(ey - sy) / len) * (w / 2), ny = ((ex - sx) / len) * (w / 2);
            return { on: exposure(m[0]), shape: fill([[sx + nx, sy + ny], [sx - nx, sy - ny], [ex - nx, ey - ny], [ex + nx, ey + ny]], rot) };
        }
        case 21: { // center line: exposure, width, height, cx, cy, rotation
            need(6, 'center line');
            const [, w, h, cx, cy, rot] = m;
            if (!(w > 0 && h > 0)) return { on: exposure(m[0]), shape: [] };
            return { on: exposure(m[0]), shape: fill(G.rect(cx, cy, w, h), rot) };
        }
        case 22: { // lower-left line (deprecated): exposure, width, height, x, y, rotation
            need(6, 'lower left line');
            const [, w, h, x, y, rot] = m;
            if (!(w > 0 && h > 0)) return { on: exposure(m[0]), shape: [] };
            return { on: exposure(m[0]), shape: fill(G.rect(x + w / 2, y + h / 2, w, h), rot) };
        }
        case 4: { // outline: exposure, n, x0, y0, ..., xn, yn, rotation
            need(2, 'outline');
            const n = m[1];
            if (!Number.isInteger(n) || n < 3) throw new Error('outline needs at least 3 vertices');
            need(2 + 2 * (n + 1) + 1, 'outline');
            const pts = [];
            for (let i = 0; i <= n; i++) pts.push([m[2 + 2 * i], m[3 + 2 * i]]);
            const rot = m[2 + 2 * (n + 1)];
            const [fx, fy] = pts[0], [lx, ly] = pts[n];
            if (Math.abs(fx - lx) > 1e-9 || Math.abs(fy - ly) > 1e-9) throw new Error('outline must end at its start point');
            return { on: exposure(m[0]), shape: fill(pts.slice(0, n), rot) };
        }
        case 5: { // polygon: exposure, vertices, cx, cy, diameter, rotation
            need(6, 'polygon');
            const [, n, cx, cy, d, rot] = m;
            if (!Number.isInteger(n) || n < 3 || n > 12) throw new Error('polygon needs 3–12 vertices');
            if (!(d > 0)) return { on: exposure(m[0]), shape: [] };
            return { on: exposure(m[0]), shape: fill(G.regularPolygon(cx, cy, d, n, 0), rot) };
        }
        case 6: { // moiré (deprecated): cx, cy, outer d, thickness, gap, max rings, cross thickness, cross length, rotation
            need(9, 'moire');
            const [cx, cy, od, th, gap, rings, ct, cl, rot] = m;
            let shape = [];
            for (let i = 0; i < rings; i++) {
                const outer = od - 2 * i * (th + gap);
                if (outer <= 0) break;
                const inner = outer - 2 * th;
                let ring = fill(G.circle(cx, cy, outer, ftol), rot);
                if (inner > 0) ring = G.difference(ring, fill(G.circle(cx, cy, inner, ftol), rot));
                shape = G.union(shape, ring);
            }
            if (ct > 0 && cl > 0) {
                shape = G.union(shape, fill(G.rect(cx, cy, cl, ct), rot), fill(G.rect(cx, cy, ct, cl), rot));
            }
            return { on: true, shape };
        }
        case 7: { // thermal: cx, cy, outer d, inner d, gap, rotation
            need(6, 'thermal');
            const [cx, cy, od, id, gap, rot] = m;
            if (!(od > id && id >= 0)) throw new Error('thermal outer diameter must exceed inner diameter');
            let ring = fill(G.circle(cx, cy, od, ftol), rot);
            if (id > 0) ring = G.difference(ring, fill(G.circle(cx, cy, id, ftol), rot));
            if (gap > 0) {
                const cut = G.union(fill(G.rect(cx, cy, od * 2, gap), rot), fill(G.rect(cx, cy, gap, od * 2), rot));
                ring = G.difference(ring, cut);
            }
            return { on: true, shape: ring };
        }
        default:
            throw new Error(`unknown macro primitive ${code}`);
    }
}

/** Arithmetic in aperture macros: + - x X / parentheses, unary minus, $n variables. */
export function evalExpression(src, vars = new Map()) {
    const s = src.replace(/\s+/g, '');
    let i = 0;
    const fail = (msg) => { throw new Error(`${msg} in expression "${src}"`); };
    const expr = () => {
        let v = term();
        while (s[i] === '+' || s[i] === '-') {
            const op = s[i++];
            const r = term();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    };
    const term = () => {
        let v = factor();
        while (s[i] === 'x' || s[i] === 'X' || s[i] === '/') {
            const op = s[i++];
            const r = factor();
            if (op === '/') {
                if (r === 0) fail('division by zero');
                v /= r;
            } else v *= r;
        }
        return v;
    };
    const factor = () => {
        const ch = s[i];
        if (ch === '+') { i++; return factor(); }
        if (ch === '-') { i++; return -factor(); }
        if (ch === '(') {
            i++;
            const v = expr();
            if (s[i] !== ')') fail('missing )');
            i++;
            return v;
        }
        if (ch === '$') {
            const m = /^\$(\d+)/.exec(s.slice(i));
            if (!m) fail('bad variable');
            i += m[0].length;
            return vars.get(Number(m[1])) ?? 0;
        }
        const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
        if (!m) fail(`unexpected "${ch ?? 'end'}"`);
        i += m[0].length;
        return Number(m[1]);
    };
    if (!s) fail('empty value');
    const v = expr();
    if (i !== s.length) fail(`unexpected "${s[i]}"`);
    return v;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sweepAngle(a, b, c, cw) {
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    const a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    const TAU = 2 * Math.PI;
    if (cw) {
        let s = (a0 - a1) % TAU;
        if (s <= 0) s += TAU;
        return -s;
    }
    let s = (a1 - a0) % TAU;
    if (s <= 0) s += TAU;
    return s;
}

function transformPoints(points, rotation, scale) {
    let pts = points;
    if (rotation) pts = G.rotatePoints(pts, rotation);
    if (scale !== 1) pts = pts.map(([x, y]) => [x * scale, y * scale]);
    return pts;
}

function transformShape(shape, rotation, scale) {
    if (!rotation && scale === 1) return shape;
    return G.normalize(shape.map((path) => G.toPath(transformPoints(G.fromPath(path), rotation, scale))));
}

function translateShape(shape, dx, dy) {
    const ux = G.toUnits(dx), uy = G.toUnits(dy);
    return shape.map((path) => path.map((p) => ({ X: p.X + ux, Y: p.Y + uy })));
}

/** Area swept by a convex pen (mm ring centred on the origin) along a polyline. */
function sweepConvex(points, ring) {
    const at = (p) => ring.map(([x, y]) => [x + p[0], y + p[1]]);
    if (points.length === 1) return G.normalize([G.toPath(at(points[0]))]);
    const parts = [];
    for (let i = 1; i < points.length; i++) {
        parts.push(G.toPath(G.convexHull([...at(points[i - 1]), ...at(points[i])])));
    }
    return G.normalize(parts);
}

function translateObject(o, dx, dy) {
    const out = { ...o, shape: translateShape(o.shape, dx, dy) };
    const mv = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
    if (o.at) out.at = [o.at[0] + dx, o.at[1] + dy];
    if (o.path) out.path = mv(o.path);
    if (o.contour) out.contour = mv(o.contour);
    return out;
}

function blockCopiesOverlap(objects, blk) {
    const b = extentOf(objects);
    if (!b) return false;
    const w = b.xmax - b.xmin, h = b.ymax - b.ymin;
    return (blk.nx > 1 && blk.dx < w) || (blk.ny > 1 && blk.dy < h);
}

/** Bounding box over all object geometry, including zero-width strokes (outlines). */
function extentOf(objects) {
    let box = null;
    for (const o of objects) {
        box = G.mergeBounds(box, G.bounds(o.shape));
        const pts = o.path ?? o.contour ?? (o.at ? [o.at] : []);
        if (pts.length) {
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            for (const [x, y] of pts) {
                xmin = Math.min(xmin, x); ymin = Math.min(ymin, y);
                xmax = Math.max(xmax, x); ymax = Math.max(ymax, y);
            }
            box = G.mergeBounds(box, { xmin, ymin, xmax, ymax });
        }
    }
    return box;
}

/** Applies polarity in file order: dark objects add, clear objects remove. */
function buildImage(objects) {
    let image = [];
    let batch = [];
    let pol = null;
    const flush = () => {
        if (!batch.length) return;
        image = pol === 'dark' ? G.union(image, ...batch) : G.difference(image, G.union(...batch));
        batch = [];
    };
    for (const o of objects) {
        if (!o.shape.length) continue;
        if (o.polarity !== pol) {
            flush();
            pol = o.polarity;
        }
        batch.push(o.shape);
    }
    flush();
    return image;
}

function decodeAttr(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
