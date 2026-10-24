// Guesses what a fabrication file is (copper / outline / drill / ...) from its
// X2 file function, then its name, then its content. The guess is only a
// default for the user (or an agent) to confirm; `source` says how sure it is.

/**
 * @typedef {{ role: 'copper'|'outline'|'drill'|'soldermask'|'silkscreen'|'paste'|'other'|'unknown',
 *   side: 'top'|'bottom'|'inner'|null, layer?: number, plated?: boolean|null,
 *   format: 'gerber'|'excellon'|null, source: 'x2'|'filename'|'content'|'none', reason: string }} LayerGuess
 */

/** Sniffs the file format from its first bytes. */
export function sniffFormat(text) {
    const head = String(text).slice(0, 4000);
    if (/%FS[LTD]?[AI]/.test(head) || /%MO(MM|IN)\*%/.test(head) || /^G04 /m.test(head)) return 'gerber';
    if (/^\s*M48\s*$/m.test(head) || (/^(METRIC|INCH)\b/m.test(head) && /^T\d+C[\d.]+/m.test(head))) return 'excellon';
    return null;
}

/** Role from an X2 `.FileFunction` value list (Gerber or KiCad drill comment). */
export function roleFromFileFunction(ff) {
    if (!ff || !ff.length) return null;
    const [kind, a, b] = ff;
    const sideOf = (v) => (v === 'Top' ? 'top' : v === 'Bot' ? 'bottom' : v === 'Inr' ? 'inner' : null);
    switch (kind) {
        case 'Copper': {
            const layer = /^L(\d+)$/.exec(a ?? '');
            return { role: 'copper', side: sideOf(b), layer: layer ? Number(layer[1]) : undefined };
        }
        case 'Profile': return { role: 'outline', side: null };
        case 'Soldermask': return { role: 'soldermask', side: sideOf(a) };
        case 'Legend': return { role: 'silkscreen', side: sideOf(a) };
        case 'Paste': return { role: 'paste', side: sideOf(a) };
        case 'Plated': return { role: 'drill', side: null, plated: true };
        case 'NonPlated': return { role: 'drill', side: null, plated: false };
        case 'MixedPlating': return { role: 'drill', side: null, plated: null };
        default: return { role: 'other', side: null };
    }
}

// Filename rules, most specific first. Tested against the lower-cased base name.
const NAME_RULES = [
    // KiCad layer suffixes
    [/[-_.]f[._]cu\b|[-_]top[-_]?(copper|layer)\b|toplayer/, { role: 'copper', side: 'top' }],
    [/[-_.]b[._]cu\b|[-_]bot(tom)?[-_]?(copper|layer)\b|bottomlayer/, { role: 'copper', side: 'bottom' }],
    [/[-_.]in(\d+)[._]cu\b/, { role: 'copper', side: 'inner' }],
    [/edge[._]cuts|board[-_]?outline|outline|profile|[-_.]dimension\b/, { role: 'outline', side: null }],
    [/[-_.]f[._]mask\b|topsoldermask/, { role: 'soldermask', side: 'top' }],
    [/[-_.]b[._]mask\b|bottomsoldermask/, { role: 'soldermask', side: 'bottom' }],
    [/[-_.]f[._]silks(creen)?\b|topsilk/, { role: 'silkscreen', side: 'top' }],
    [/[-_.]b[._]silks(creen)?\b|bottomsilk/, { role: 'silkscreen', side: 'bottom' }],
    [/[-_.]f[._]paste\b|toppaste/, { role: 'paste', side: 'top' }],
    [/[-_.]b[._]paste\b|bottompaste/, { role: 'paste', side: 'bottom' }],
    [/(^|[-_.])npth\b|non[-_]?plated/, { role: 'drill', side: null, plated: false }],
    [/(^|[-_.])pth\b|[-_]plated/, { role: 'drill', side: null, plated: true }],
];

// Extension rules (Protel/Altium, Eagle, KiCad defaults).
const EXT_RULES = {
    gtl: { role: 'copper', side: 'top' },
    cmp: { role: 'copper', side: 'top' },
    gbl: { role: 'copper', side: 'bottom' },
    sol: { role: 'copper', side: 'bottom' },
    gko: { role: 'outline', side: null },
    gm1: { role: 'outline', side: null },
    gml: { role: 'outline', side: null },
    dim: { role: 'outline', side: null },
    gts: { role: 'soldermask', side: 'top' },
    stc: { role: 'soldermask', side: 'top' },
    gbs: { role: 'soldermask', side: 'bottom' },
    sts: { role: 'soldermask', side: 'bottom' },
    gto: { role: 'silkscreen', side: 'top' },
    plc: { role: 'silkscreen', side: 'top' },
    gbo: { role: 'silkscreen', side: 'bottom' },
    pls: { role: 'silkscreen', side: 'bottom' },
    gtp: { role: 'paste', side: 'top' },
    crc: { role: 'paste', side: 'top' },
    gbp: { role: 'paste', side: 'bottom' },
    crs: { role: 'paste', side: 'bottom' },
    drl: { role: 'drill', side: null },
    drd: { role: 'drill', side: null },
    xln: { role: 'drill', side: null },
    exc: { role: 'drill', side: null },
};

/**
 * @param {string} name file name (path allowed)
 * @param {{ text?: string, parsed?: { format: string, fileAttributes: object } }} [info]
 * @returns {LayerGuess}
 */
export function detectLayer(name, { text, parsed } = {}) {
    const base = String(name).split(/[\\/]/).pop();
    const lower = base.toLowerCase();
    const format = parsed?.format ?? (text !== undefined ? sniffFormat(text) : null);

    const ff = parsed?.fileAttributes?.['.FileFunction'];
    const fromX2 = roleFromFileFunction(ff);
    if (fromX2 && fromX2.role !== 'other') {
        return { plated: undefined, ...fromX2, format, source: 'x2', reason: `X2 file function ${ff.join(',')}` };
    }

    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    for (const [re, guess] of NAME_RULES) {
        const m = re.exec(lower);
        if (m) {
            const g = { ...guess, format, source: 'filename', reason: `file name matches ${re.source.slice(0, 40)}` };
            if (guess.side === 'inner' && m[1]) g.layer = Number(m[1]) + 1;
            return consistent(g);
        }
    }
    if (EXT_RULES[ext]) return consistent({ ...EXT_RULES[ext], format, source: 'filename', reason: `.${ext} extension` });
    if (/^g(\d+)$/.test(ext) || /^gp(\d+)$/.test(ext) || /^g\d+l$/.test(ext)) {
        return consistent({ role: 'copper', side: 'inner', format, source: 'filename', reason: `.${ext} inner layer extension` });
    }
    if (format === 'excellon') return { role: 'drill', side: null, plated: null, format, source: 'content', reason: 'Excellon content' };
    if (fromX2) return { ...fromX2, format, source: 'x2', reason: `X2 file function ${ff.join(',')}` };
    return { role: 'unknown', side: null, format, source: 'none', reason: 'no X2 file function and no known naming convention' };
}

/** A drill name on a Gerber file (or vice versa) means the name lied; trust the content. */
function consistent(g) {
    if (g.format === 'excellon' && g.role !== 'drill') {
        return { role: 'drill', side: null, plated: null, format: g.format, source: 'content', reason: `Excellon content (name suggested ${g.role})` };
    }
    if (g.format === 'gerber' && g.role === 'drill') {
        return { role: 'unknown', side: null, format: g.format, source: 'content', reason: 'Gerber content with a drill file name (Gerber drill files are not supported yet)' };
    }
    return g;
}
