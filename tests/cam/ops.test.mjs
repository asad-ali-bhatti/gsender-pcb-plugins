import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const C = await import(new URL('../../plugins/pcb-cam/ui/core/index.js', import.meta.url));
const { geometry: G } = C;
const { depthLevels, orderNearest, clipRings, passDepth } = await import(new URL('../../plugins/pcb-cam/ui/core/ops/common.js', import.meta.url));

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
const c = (v) => String(Math.round(v * 1e6));
const xy = (x, y) => `X${c(x)}Y${c(y)}`;

// 30 × 20 mm board. U1: two 1 × 1 pads 0.15 mm apart on different nets (too
// close for a wide tool); R1: two pads joined by a 0.3 mm trace (GND).
const TOP = `%TF.FileFunction,Copper,L1,Top*%
%FSLAX46Y46*%
%MOMM*%
%LPD*%
%ADD10R,1X1*%
%ADD11C,0.3*%
%ADD12C,1.6*%
D10*
%TO.P,U1,1*%
%TO.N,VCC*%
${xy(10, 10)}D03*
%TO.P,U1,2*%
%TO.N,SIG*%
${xy(11.15, 10)}D03*
%TO.P,R1,1*%
%TO.N,GND*%
${xy(20, 5)}D03*
%TO.P,R1,2*%
${xy(25, 5)}D03*
%TD*%
%TO.N,GND*%
D11*
${xy(20, 5)}D02*
${xy(25, 5)}D01*
%TD*%
D12*
%TO.P,J1,1*%
%TO.N,GND*%
${xy(5, 15)}D03*
%TD*%
M02*
`;
const EDGE = `%TF.FileFunction,Profile,NP*%
%FSLAX46Y46*%
%MOMM*%
%ADD10C,0.1*%
D10*
${xy(0, 0)}D02*
${xy(30, 0)}D01*
${xy(30, 20)}D01*
${xy(0, 20)}D01*
${xy(0, 0)}D01*
M02*
`;
const DRILL = `M48
; #@! TF.FileFunction,MixedPlating,1,2
FMAT,2
METRIC
; #@! TA.AperFunction,Plated,PTH,ComponentDrill
T1C0.800
; #@! TA.AperFunction,Plated,PTH,ComponentDrill
T2C3.000
; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill
T3C1.000
%
G90
G05
T1
X5.0Y15.0
X26.0Y15.0
X6.0Y5.0G85X8.0Y5.0
T2
X15.0Y15.0
T3
X28.0Y2.0
M30
`;

const layers = () => ({ top: C.parseGerber(TOP), edge: C.parseGerber(EDGE), drill: C.parseExcellon(DRILL) });
const cut = { feed: 120, plunge: 60, rpm: 12000, stepdown: 0.1 };
const TOOLS = {
    v20: { id: 'v20', name: '20 deg V-bit 0.1 mm', type: 'vbit', toolNumber: 1, tipDiameter: 0.1, angle: 20, cutting: cut },
    v60: { id: 'v60', name: '60 deg V-bit 0.3 mm', type: 'vbit', toolNumber: 2, tipDiameter: 0.3, angle: 60, cutting: cut },
    d08: { id: 'd08', name: '0.8 mm drill', type: 'drill', toolNumber: 3, diameter: 0.8, cutting: { ...cut, stepdown: 2 } },
    em1: { id: 'em1', name: '1 mm end mill', type: 'endmill', toolNumber: 4, diameter: 1, cutting: { ...cut, feed: 300, stepdown: 0.6 } },
};

function project(ops, { tools = Object.values(TOOLS), regions = [], setup = {}, output = {}, inputs } = {}) {
    let p = C.createProject('Test board');
    const cmds = [
        ...(inputs ?? [
            { id: 'top', file: 'b-F_Cu.gtl', role: 'copper', side: 'top' },
            { id: 'edge', file: 'b-Edge_Cuts.gm1', role: 'outline', side: null },
            { id: 'drill', file: 'b.drl', role: 'drill', side: null },
        ]).map((args) => ({ name: 'input.add', args })),
        { name: 'setup.update', args: { stockThickness: 1.6, ...setup } },
        { name: 'output.update', args: output },
        ...tools.map((tool) => ({ name: 'tool.set', args: { tool } })),
        ...regions.map((r) => ({ name: 'region.set', args: r })),
        ...ops.map((operation) => ({ name: 'operation.set', args: { operation } })),
    ];
    for (const cmd of cmds) {
        const r = C.applyCommand(p, cmd);
        assert.ok(r.ok, `${cmd.name}: ${JSON.stringify(r.error)}`);
        p = r.project;
    }
    return p;
}

const ISO = { id: 'iso', type: 'isolation', enabled: true, input: 'top', tool: 'v20', depth: 0.05, passes: 2, overlap: 0.4, direction: 'climb' };
const DRL = { id: 'drl', type: 'drilling', enabled: true, input: 'drill', tool: 'd08', holes: 'all', maxDiameter: 0.9, breakthrough: 0.2, peck: 0 };
const MILL = { id: 'mill', type: 'drilling', enabled: true, input: 'drill', tool: 'em1', holes: 'all', minDiameter: 0.9, breakthrough: 0.2 };
const CUT = { id: 'cut', type: 'cutout', enabled: true, input: 'edge', tool: 'em1', breakthrough: 0.2, side: 'outside', tabs: { count: 4, width: 2, height: 0.6 } };
const CLEAR = { id: 'clear', type: 'clearing', enabled: true, input: 'top', tool: 'em1', depth: 0.1, overlap: 0.3, rest: false };

function generate(p, opts) {
    const r = C.generate(p, layers(), opts);
    assert.ok(r.ok, JSON.stringify(r.issues));
    return r;
}

/** Signed area of a closed mm polyline (positive = counter-clockwise). */
const signedArea = (pts) => pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
/** Distance from a point to the copper boundary, sampled by offsetting. */
const insideGrown = (shape, d, [x, y]) => G.containsPoint(G.offset(shape, d), x, y);

// ---------------------------------------------------------------------------
// G-code sanity checker
// ---------------------------------------------------------------------------

/**
 * Parses G-code and checks the rules every file must follow. Returns a
 * summary: tool changes, deepest Z, XY bounds of cutting moves.
 */
function checkGcode(gcode, { safeZ, travelZ, minZ, bounds }) {
    const lines = gcode.trim().split('\n');
    assert.match(lines.find((l) => !l.startsWith('(')), /^G90 G94 G17$/);
    assert.ok(lines.includes('G21'), 'metric');
    assert.equal(lines[lines.length - 1], 'M30');
    const pos = { X: null, Y: null, Z: null };
    let feed = null;
    let spindle = false;
    const tools = [];
    let deepest = 0;
    let box = null;
    for (const [n, line] of lines.entries()) {
        const at = `line ${n + 1}: ${line}`;
        if (line.startsWith('(')) {
            assert.ok(line.endsWith(')') && /^[\x20-\x7e]+$/.test(line), `ASCII comment, ${at}`);
            continue;
        }
        assert.doesNotMatch(line, /[()]/, at);
        const words = Object.fromEntries([...line.matchAll(/([A-Z])(-?[\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
        const code = line.split(' ')[0];
        if (code === 'M6') { assert.ok(!spindle, `spindle off for tool change, ${at}`); assert.ok(pos.Z >= safeZ - 1e-9, `tool change at safe Z, ${at}`); tools.push(words.T); continue; }
        if (code === 'M3') { spindle = true; continue; }
        if (code === 'M5') { spindle = false; continue; }
        if (code === 'M0') { assert.ok(!spindle && pos.Z >= safeZ - 1e-9, `pause with spindle off at safe Z, ${at}`); continue; }
        if (code !== 'G0' && code !== 'G1') continue;
        const next = { X: words.X ?? pos.X, Y: words.Y ?? pos.Y, Z: words.Z ?? pos.Z };
        if (code === 'G0') {
            const movesXY = words.X !== undefined || words.Y !== undefined;
            if (movesXY) assert.ok(pos.Z >= travelZ - 1e-9, `rapid XY only above travel Z, ${at}`);
        } else {
            if (words.F !== undefined) feed = words.F;
            assert.ok(feed > 0, `feed set before cutting, ${at}`);
            assert.ok(spindle, `spindle on while cutting, ${at}`);
            if (next.Z < 0) box = G.mergeBounds(box, { xmin: next.X, ymin: next.Y, xmax: next.X, ymax: next.Y });
        }
        deepest = Math.min(deepest, next.Z);
        Object.assign(pos, next);
    }
    assert.ok(deepest >= minZ - 1e-9, `never below ${minZ} (got ${deepest})`);
    if (bounds && box) {
        assert.ok(box.xmin >= bounds.xmin && box.ymin >= bounds.ymin && box.xmax <= bounds.xmax && box.ymax <= bounds.ymax, `cuts inside ${JSON.stringify(bounds)}: ${JSON.stringify(box)}`);
    }
    assert.ok(!spindle, 'spindle off at the end');
    assert.ok(pos.Z >= safeZ - 1e-9, 'ends at safe Z');
    return { tools, deepest, box };
}

// ---------------------------------------------------------------------------

test('depth levels and nearest-neighbour ordering', () => {
    assert.deepEqual(depthLevels(0.05, 0.1), [-0.05]);
    assert.deepEqual(depthLevels(1.8, 0.6).map((z) => +z.toFixed(9)), [-0.6, -1.2, -1.8]);
    assert.equal(depthLevels(1.0, 0.3).length, 4);
    const cut = { stepdown: 0.1 };
    assert.equal(passDepth({ type: 'isolation' }, cut, 0.3), 0.3, 'isolation defaults to one pass');
    assert.equal(passDepth({ type: 'cutout' }, cut, 1.8), 0.1, 'cutout defaults to multi-depth');
    assert.equal(passDepth({ type: 'isolation', multiDepth: true }, cut, 0.3), 0.1);
    assert.equal(passDepth({ type: 'cutout', multiDepth: false }, cut, 1.8), 1.8);
    const sq = (x) => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]];
    const r = orderNearest([{ loop: sq(10) }, { line: [[5, 0], [6, 0]] }, { loop: sq(2) }], [0, 0]);
    assert.deepEqual(r.items.map((i) => i.points[0]), [[2, 0], [5, 0], [10, 0]], 'nearest first, loops start at the nearest vertex');
    assert.deepEqual(r.end, [10, 0]);
});

test('clipRings keeps direction and rejoins pieces across the ring start', () => {
    const mask = G.normalize([G.toPath(G.rect(0, 0, 10, 10))]);
    const ring = [[-20, -2], [20, -2], [20, 2], [-20, 2]];
    const { loops, lines } = clipRings([ring], G.difference(G.normalize([G.toPath(G.rect(0, 0, 100, 100))]), mask));
    assert.equal(loops.length, 0);
    assert.equal(lines.length, 2, 'ring start joined back up');
    const all = clipRings([ring.slice().reverse()], null);
    assert.equal(all.loops.length, 1);
});

test('isolation: offsets at the right distance, climb is clockwise around copper', () => {
    const L = layers();
    const r = generate(project([ISO]));
    const op = r.operations[0];
    const w = C.widthAtDepth(TOOLS.v20, 0.05);
    near(op.stats.width, w, 1e-4);
    const step = w * (1 - ISO.overlap);
    for (const cut of op.cuts) {
        const p = cut.points[Math.floor(cut.points.length / 2)];
        // every point lies on the pass-1 or pass-2 offset contour
        const d1 = w / 2, d2 = w / 2 + step;
        const onPass = (d) => insideGrown(L.top.image, d + 0.003, p) && !insideGrown(L.top.image, d - 0.003, p);
        assert.ok(onPass(d1) || onPass(d2), `point ${p} on an offset contour`);
        assert.ok(cut.points.every((q) => q[2] === -0.05), 'single level at 0.05 mm');
    }
    // The J1 pad (round, isolated) gets two loops; climb = clockwise.
    const aroundJ1 = op.cuts.filter((cut) => Math.hypot(cut.points[0][0] - 5, cut.points[0][1] - 15) < 1.2);
    assert.equal(aroundJ1.length, 2);
    for (const cut of aroundJ1) assert.ok(signedArea(cut.points) < 0, 'clockwise');
    const conv = generate(project([{ ...ISO, direction: 'conventional' }])).operations[0].cuts.find((cut) => Math.hypot(cut.points[0][0] - 5, cut.points[0][1] - 15) < 1.2);
    assert.ok(signedArea(conv.points) > 0, 'conventional = counter-clockwise');
});

test('regions: fine bit around U1, coarse elsewhere, seams overlap', () => {
    const p = project([
        { ...ISO, id: 'fine', region: 'u1', passes: 1 },
        { ...ISO, id: 'rest', region: 'rest', tool: 'v60', passes: 1 },
    ], { regions: [{ id: 'u1', shape: { kind: 'component', ref: 'U1', margin: 0.5 } }, { id: 'rest', shape: { kind: 'remainder' } }] });
    const L = layers();
    const r = generate(p);
    const [fine, rest] = r.operations;
    const u1 = C.regionMask(p, p.operations[0], L);
    const wFine = C.widthAtDepth(TOOLS.v20, 0.05);
    const wRest = C.widthAtDepth(TOOLS.v60, 0.05);
    const seam = G.offset(u1, wFine + 1e-3);
    for (const cut of fine.cuts) for (const q of cut.points) assert.ok(G.containsPoint(seam, q[0], q[1]), 'fine paths stay within region + seam');
    // The coarse op skips the U1 interior but reaches into its seam.
    const deep = G.offset(u1, -wRest - 0.01);
    for (const cut of rest.cuts) for (const q of cut.points) assert.ok(!G.containsPoint(deep, q[0], q[1]), 'coarse paths stay out of U1');
    assert.ok(rest.cuts.some((cut) => cut.points.some((q) => G.containsPoint(u1, q[0], q[1]))), 'coarse paths overlap into the seam');
    assert.ok(rest.cuts.some((cut) => Math.hypot(cut.points[0][0] - 5, cut.points[0][1] - 15) < 2), 'J1 isolated by the coarse op');
    // Analysis: the coarse tool alone could not separate U1's pads, the fine one can.
    assert.equal(C.analyzeProject(p, L).filter((i) => i.code === 'tool-too-wide').length, 0);
    const coarseOnly = project([{ ...ISO, tool: 'v60', passes: 1 }]);
    const too = C.analyzeProject(coarseOnly, L).filter((i) => i.code === 'tool-too-wide');
    assert.equal(too.length, 1);
    near(too[0].gap, 0.15, 0.002, 'measured gap');
    assert.deepEqual(too[0].nets, ['SIG', 'VCC']);
    near(too[0].at[0], 10.575, 0.01);
    near(too[0].at[1], 10, 0.01);
    // Only the fine region: the rest of the board is reported as not isolated.
    const partial = project([{ ...ISO, region: 'u1' }], { regions: [{ id: 'u1', shape: { kind: 'component', ref: 'U1', margin: 0.5 } }] });
    assert.ok(C.analyzeProject(partial, L).some((i) => i.code === 'not-isolated'));
});

test('analysis: same-net neighbours are not shorts; region suggestions cover the gap', () => {
    const L = layers();
    // A tool wide enough to bridge R1's pads to its trace: all GND, so no report.
    const gaps = C.narrowGaps(L.top, 0.4);
    assert.deepEqual(gaps.map((g) => g.nets), [['SIG', 'VCC']]);
    assert.equal(C.narrowGaps(L.top, 0.1).length, 0, 'narrow tool fits the 0.15 mm gap');
    const s = C.suggestRegions(L.top, TOOLS.v60, 0.05);
    assert.equal(s.length, 1);
    assert.equal(s[0].gaps, 1);
    const poly = G.normalize([G.toPath(s[0].points)]);
    assert.ok(G.containsPoint(poly, 10.575, 10));
    assert.ok(!G.containsPoint(poly, 20, 5));
});

test('drilling: drill plunges and pecks, end mill helix-mills and slots, filters', () => {
    const r = generate(project([{ ...DRL, peck: 0.5 }, MILL]));
    const [drl, mill] = r.operations;
    assert.equal(drl.stats.holes, 2, 'two 0.8 mm holes; the slot needs an end mill');
    assert.ok(r.issues.some((i) => i.code === 'slot-needs-endmill'));
    for (const c2 of drl.cuts) { assert.equal(c2.kind, 'drill'); near(c2.z, -1.8, 1e-9); assert.equal(c2.peck, 0.5); }
    const gc = r.files[0].gcode;
    const drillBlock = gc.slice(gc.indexOf('(drl:'), gc.indexOf('(mill:'));
    assert.equal((drillBlock.match(/^G1 Z/gm) ?? []).length, 2 * 4, '1.8 mm in 0.5 mm pecks = 4 plunges per hole');
    // 3 mm hole: helix of radius (3 - 1) / 2 around (15, 15), down to -1.8; 1 mm NPTH hole: plunge.
    const helix = mill.cuts.find((c2) => c2.kind === 'path' && Math.hypot(c2.points[0][0] - 16, c2.points[0][1] - 15) < 1e-6);
    assert.ok(helix);
    for (const q of helix.points) near(Math.hypot(q[0] - 15, q[1] - 15), 1, 1e-6);
    near(Math.min(...helix.points.map((q) => q[2])), -1.8, 1e-9);
    assert.ok(signedArea(helix.points.slice(0, 20)) > 0, 'counter-clockwise = climb inside a hole');
    assert.ok(mill.cuts.some((c2) => c2.kind === 'drill' && c2.x === 28), 'NPTH 1 mm hole plunged with the 1 mm end mill');
    // Method Drill with an end mill: every hole plunged, even the 3 mm one; slots skipped
    const dr = generate(project([{ ...MILL, method: 'drill' }]));
    const dcuts = dr.operations[0].cuts;
    assert.ok(dcuts.every((c2) => c2.kind === 'drill'), 'no helix or slot paths');
    assert.ok(dcuts.some((c2) => Math.hypot(c2.x - 15, c2.y - 15) < 1e-6), '3 mm hole plunged at its centre');
    assert.ok(dr.issues.some((i) => i.code === 'drill-size-mismatch' && /undersize/.test(i.message)));
    const drAll = generate(project([{ ...MILL, method: 'drill', minDiameter: 0 }]));
    assert.ok(drAll.issues.some((i) => i.code === 'slot-needs-endmill' && /Method to Mill/.test(i.message)));
    assert.ok(drAll.issues.some((i) => i.code === 'drill-size-mismatch' && /oversize/.test(i.message)), '0.8 mm holes plunged with the 1 mm end mill');
    // preview marks: how each hole is cut, in the same coordinates as the cuts
    const mk = generate(project([{ ...MILL, minDiameter: 0 }])).operations[0].marks;
    const big = mk.find((k) => Math.hypot(k.x - 15, k.y - 15) < 1e-6);
    assert.deepEqual([big.how, big.d], ['milled', 3]);
    assert.ok(mk.some((k) => k.how === 'plunged' && k.x === 28), '1 mm hole plunged with the 1 mm end mill');
    assert.ok(mk.filter((k) => k.how === 'skipped').length >= 3, '0.8 mm holes and slot are smaller than the tool');
    assert.ok(generate(project([{ ...MILL, method: 'drill' }])).operations[0].marks.every((k) => k.how === 'plunged'));
    assert.equal(C.drillMethod({}, { type: 'drill' }), 'drill');
    assert.equal(C.drillMethod({ method: 'mill' }, { type: 'drill' }), 'drill', 'drill bits cannot mill');
    assert.equal(C.drillMethod({}, { type: 'endmill' }), 'mill');
    // pecking also lifts out of helix-milled holes
    const pk = generate(project([{ ...MILL, peck: 0.5 }]));
    const pieces = pk.operations[0].cuts.filter((c2) => c2.kind === 'path' && c2.points.every((q) => Math.hypot(q[0] - 15, q[1] - 15) < 1 + 1e-6));
    assert.equal(pieces.length, 4, '1.8 mm helix in 0.5 mm pecks');
    for (const [k, p2] of pieces.entries()) {
        const top = p2.points[0][2];
        assert.ok(top - Math.min(...p2.points.map((q) => q[2])) <= 0.5 + 1e-6, `piece ${k} no deeper than one peck`);
        if (k) { near(p2.reenter, top, 1e-9); assert.deepEqual(p2.points[0], pieces[k - 1].points.at(-1)); }
    }
    near(Math.min(...pieces.at(-1).points.map((q) => q[2])), -1.8, 1e-9);
    const pg = pk.files[0].gcode;
    assert.match(pg, /G0 Z1\nG0 Z-0\.\d+\nG1 Z-0\.\d+ F/, 'lift to travel Z, rapid back to just above the cut, then feed in');
    checkGcode(pg, { safeZ: 5, travelZ: 1, minZ: -1.8 });
    // a tight helix (hole barely bigger than the tool) never descends faster than the plunge rate
    const tight = generate(project([{ ...MILL, minDiameter: 0.95, maxDiameter: 1.1 }], { tools: [{ ...TOOLS.em1, diameter: 0.9 }] }));
    let at = {}, feed = 0, fastest = 0;
    for (const l of (tight.files?.[0]?.gcode ?? '').split('\n')) {
        const w = Object.fromEntries([...l.matchAll(/([XYZF])(-?[\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
        if (w.F) feed = w.F;
        const nx = { X: w.X ?? at.X, Y: w.Y ?? at.Y, Z: w.Z ?? at.Z };
        if (l.startsWith('G1') && nx.Z < at.Z) fastest = Math.max(fastest, feed * (at.Z - nx.Z) / Math.hypot(nx.X - at.X, nx.Y - at.Y, at.Z - nx.Z));
        at = nx;
    }
    assert.ok(fastest > 0 && fastest <= TOOLS.em1.cutting.plunge + 1, `descends at ${fastest} mm/min`);
    // without the size filter, the 0.8 mm holes and slot are narrower than the 1 mm end mill
    const small = generate(project([{ ...MILL, minDiameter: 0 }]));
    assert.match(small.issues.find((i) => i.code === 'hole-smaller-than-tool').message, /^3 hole\(s\)\/slot\(s\) of ⌀0.8 mm/);
    const plated = generate(project([{ ...MILL, holes: 'nonplated' }])).operations[0];
    assert.equal(plated.stats.holes, 1);
    const slotTool = { ...TOOLS.em1, id: 'em06', toolNumber: 5, diameter: 0.6 };
    const slot = generate(project([{ ...MILL, tool: 'em06', minDiameter: 0.7, maxDiameter: 0.85 }], { tools: [slotTool] })).operations[0];
    assert.ok(slot.cuts.length > 0 && slot.cuts.every((c2) => c2.kind === 'path'), 'holes and slot milled');
});

test('cutout: offset by the tool radius, tabs at the right height and length', () => {
    const r = generate(project([CUT]));
    const op = r.operations[0];
    assert.equal(op.stats.tabs, 4);
    assert.equal(op.cuts.length, 1);
    const pts = op.cuts[0].points;
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    near(Math.min(...xs), -0.5, 1e-3); near(Math.max(...xs), 30.5, 1e-3);
    near(Math.min(...ys), -0.5, 1e-3); near(Math.max(...ys), 20.5, 1e-3);
    // 1.8 mm in 0.6 mm levels: -0.6, -1.2, -1.8; tab top at -1.6 + 0.6 = -1.0.
    const zs = [...new Set(pts.map((q) => +q[2].toFixed(6)))].sort((a, b) => a - b);
    assert.deepEqual(zs, [-1.8, -1.2, -1, -0.6]);
    // Length cut at tab height on the deepest level ≈ 4 × (2 + 1) mm.
    let tabLen = 0;
    for (let i = 1; i < pts.length; i++) {
        if (Math.abs(pts[i][2] + 1) < 1e-9 && Math.abs(pts[i - 1][2] + 1) < 1e-9) tabLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    near(tabLen, 2 * 4 * 3, 0.05, 'tab length over the two levels below the tab top');
    assert.ok(signedArea(pts.filter((q) => q[2] === -0.6)) < 0, 'climb: clockwise around the board');
    const inside = generate(project([{ ...CUT, side: 'inside', tabs: { count: 0, width: 1, height: 0 } }])).operations[0].cuts[0].points;
    near(Math.min(...inside.map((q) => q[0])), 0.5, 1e-3);
});

test('clearing stays clear of copper; rest machining only covers what isolation left', () => {
    const L = layers();
    const full = generate(project([CLEAR])).operations[0];
    const keepOut = G.offset(L.top.image, 0.5 - 0.005);
    for (const cut of full.cuts) for (const q of cut.points) assert.ok(!G.containsPoint(keepOut, q[0], q[1]), `tool edge off copper at ${q}`);
    for (const cut of full.cuts) for (const q of cut.points) assert.ok(q[0] >= 0.5 - 1e-3 && q[0] <= 29.5 + 1e-3 && q[1] >= 0.5 - 1e-3 && q[1] <= 19.5 + 1e-3, 'inside the board');
    const rest = generate(project([{ ...ISO, tool: 'v60', passes: 6 }, { ...CLEAR, rest: true }])).operations[1];
    assert.ok(rest.stats.cutLength < full.stats.cutLength, `rest ${rest.stats.cutLength} < full ${full.stats.cutLength}`);
    assert.ok(rest.stats.cutLength > 0);
});

test('bottom side is mirrored about the board centre and keeps climb direction', () => {
    const inputs = [
        { id: 'bot', file: 'b-B_Cu.gbl', role: 'copper', side: 'bottom' },
        { id: 'edge', file: 'b-Edge_Cuts.gm1', role: 'outline', side: null },
        { id: 'drill', file: 'b.drl', role: 'drill', side: null },
    ];
    const L = layers();
    const bl = { bot: L.top, edge: L.edge, drill: L.drill };
    const p = project([{ ...ISO, input: 'bot', passes: 1 }, DRL], { inputs });
    assert.deepEqual(C.resolveFaces(p), { iso: 'bottom', drl: 'bottom' }, 'drilling follows an all-bottom board');
    const r = C.generate(p, bl);
    assert.ok(r.ok, JSON.stringify(r.issues));
    const j1 = r.operations[0].cuts.find((cut) => Math.hypot(cut.points[0][0] - 25, cut.points[0][1] - 15) < 1.2);
    assert.ok(j1, 'J1 at x = 30 - 5');
    assert.ok(signedArea(j1.points) < 0, 'still clockwise after mirroring');
    assert.deepEqual(r.operations[1].cuts.map((h) => [h.x, h.y]).sort(), [[25, 15], [4, 15]].sort());
    // Mixed sides: the job pauses to flip.
    const mixed = C.generate(project([{ ...ISO, input: 'bot', passes: 1 }, { ...DRL, face: 'top' }], { inputs }), bl);
    assert.ok(mixed.issues.some((i) => i.code === 'flip-board'));
    assert.equal((mixed.files[0].gcode.match(/^M0$/gm) ?? []).length, 1);
});

test('whole job: G-code passes the sanity checker; tool changes, split files, origin', () => {
    const p = project([ISO, DRL, MILL, CUT], { setup: { origin: 'board-lower-left' } });
    const r = generate(p, { toolChangeOption: 'Ignore' });
    assert.ok(r.issues.some((i) => i.code === 'toolchange-ignored'));
    assert.equal(r.files.length, 1);
    const sum = checkGcode(r.files[0].gcode, { safeZ: 5, travelZ: 1, minZ: -1.8, bounds: { xmin: -0.51, ymin: -0.51, xmax: 30.51, ymax: 20.51 } });
    assert.deepEqual(sum.tools, [1, 3, 4], 'M6 per tool change, end mill reused by mill and cut');
    assert.equal(r.files[0].stats.toolChanges, 3);
    assert.ok(r.stats.minutes > 0);
    assert.ok(!C.generate(p, layers(), { toolChangeOption: 'Pause' }).issues.some((i) => i.code === 'toolchange-ignored'));

    const split = generate(project([ISO, DRL, MILL, CUT], { output: { toolChange: 'split' } }));
    assert.deepEqual(split.files.map((f) => f.name), ['test-board-01-T1.nc', 'test-board-02-T3.nc', 'test-board-03-T4.nc']);
    for (const f of split.files) {
        const s = checkGcode(f.gcode, { safeZ: 5, travelZ: 1, minZ: -1.8 });
        assert.deepEqual(s.tools, [], 'no M6 in split files');
    }
    // single tool: no M6 at all
    assert.doesNotMatch(generate(project([ISO])).files[0].gcode, /M6/);
});

test('generate refuses invalid projects and reports why', () => {
    const p = project([{ ...ISO, tool: 'v20' }]);
    const r = C.generate(p, { top: layers().top });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'input-not-loaded'));
    const none = C.generate(project([{ ...ISO, enabled: false }]), layers());
    assert.equal(none.issues.at(-1).code, 'no-operations');
    const open = C.parseGerber(EDGE.replace(`${xy(0, 0)}D01*\nM02`, 'M02'));
    const b = C.boardFromOutline(open);
    assert.equal(b.issues[0].code, 'outline-open');
    const r2 = C.generate(project([CUT]), { ...layers(), edge: open });
    assert.equal(r2.ok, false);
    assert.ok(r2.issues.some((i) => i.code === 'outline-open'));
    // a broken outline does not block jobs that do not cut it out
    assert.ok(C.generate(project([ISO]), { ...layers(), edge: open }).ok);
    const cl = C.generate(project([CLEAR]), { ...layers(), edge: open });
    assert.ok(cl.ok && cl.issues.some((i) => i.code === 'outline-open' && i.severity === 'warning'), 'clearing falls back to the copper bounds');
    const empty = C.generate(project([{ ...DRL, minDiameter: 5, maxDiameter: 6 }]), layers());
    assert.deepEqual([empty.ok, empty.issues.at(-1).code], [false, 'no-toolpaths']);
});

test('golden G-code for the test board', () => {
    const p = project([ISO, DRL, MILL, { ...CLEAR, rest: true }, CUT], { setup: { origin: 'board-lower-left', material: 'FR1' } });
    const r = generate(p);
    const golden = new URL('../fixtures/test-board/test-board.nc', import.meta.url);
    if (process.env.UPDATE_GOLDEN) {
        mkdirSync(new URL('.', golden), { recursive: true });
        writeFileSync(golden, r.files[0].gcode);
    }
    assert.ok(existsSync(golden), 'golden file missing: run UPDATE_GOLDEN=1 npm test');
    assert.equal(r.files[0].gcode, readFileSync(golden, 'utf8'), 'output changed; review and run UPDATE_GOLDEN=1 npm test');
    checkGcode(r.files[0].gcode, { safeZ: 5, travelZ: 1, minZ: -1.8, bounds: { xmin: -0.51, ymin: -0.51, xmax: 30.51, ymax: 20.51 } });
});

// Real KiCad boards, when kicad-cli is installed (skipped on CI).
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find(existsSync);
const BOARD = KICAD_CLI && ['/Applications/KiCad/KiCad.app/Contents/SharedSupport/template/Arduino_Nano/Arduino_Nano.kicad_pcb', '/usr/share/kicad/template/Arduino_Nano/Arduino_Nano.kicad_pcb'].find(existsSync);

test('KiCad end to end: export, build the job through commands, generate, check', { skip: !BOARD && 'kicad-cli or template board not found' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcbcam-'));
    try {
        execFileSync(KICAD_CLI, ['pcb', 'export', 'gerbers', '-l', 'F.Cu,B.Cu,Edge.Cuts', '-o', dir + '/', BOARD], { stdio: 'ignore' });
        execFileSync(KICAD_CLI, ['pcb', 'export', 'drill', '-o', dir + '/', BOARD], { stdio: 'ignore' });
        const L = {};
        const inputs = [];
        for (const f of readdirSync(dir)) {
            const loaded = C.loadFile(f, readFileSync(join(dir, f), 'utf8'));
            if (!loaded.layer) continue;
            const id = loaded.guess.role === 'copper' ? loaded.guess.side : loaded.guess.role;
            L[id] = loaded.layer;
            inputs.push({ id, file: f, role: loaded.guess.role, side: loaded.guess.role === 'copper' ? loaded.guess.side : null });
        }
        const p = project([
            { ...ISO, id: 'iso', input: 'top' },
            { ...MILL, id: 'holes', input: 'drill', minDiameter: 0 },
            { ...CUT, input: 'outline' },
        ], { inputs, setup: { origin: 'board-lower-left' } });
        const r = C.generate(p, L);
        assert.ok(r.ok, JSON.stringify(r.issues));
        const board = C.inspectBoard(L, p).board;
        const sum = checkGcode(r.files[0].gcode, { safeZ: 5, travelZ: 1, minZ: -1.8, bounds: { xmin: -0.51, ymin: -0.51, xmax: board.width + 0.51, ymax: board.height + 0.51 } });
        assert.ok(sum.box, 'cut something');
        assert.ok(r.operations[1].stats.holes > 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// UI helpers (plugins/pcb-cam/ui/assets/defaults.js): pure, so tested here.
const D = await import(new URL('../../plugins/pcb-cam/ui/assets/defaults.js', import.meta.url));

test('standard job: commands apply cleanly and generate a full job', () => {
    let p = project([], { tools: [] });
    const cmds = D.standardJob(p, D.DEFAULT_TOOLS);
    for (const cmd of cmds) {
        const r = C.applyCommand(p, cmd);
        assert.ok(r.ok, `${cmd.name}: ${JSON.stringify(r.error)}`);
        p = r.project;
    }
    assert.deepEqual(p.operations.map((o) => o.type), ['isolation', 'drilling', 'cutout']);
    assert.deepEqual(new Set(p.tools.map((t) => t.id)), new Set(['vbit-30-0.2', 'em-0.8']));
    assert.deepEqual(C.validateProject(p, { layers: layers() }).filter((i) => i.severity === 'error'), []);
    const r = generate(p);
    assert.ok(r.files[0].gcode.includes('M30'));
    // Running it again adds nothing.
    assert.deepEqual(D.standardJob(p, D.DEFAULT_TOOLS), []);
});

test('default tools are valid and isolation defaults cut through 1 oz copper with margin', () => {
    for (const t of D.DEFAULT_TOOLS) assert.deepEqual(C.validateTool(t), [], t.id);
    assert.equal(new Set(D.DEFAULT_TOOLS.map((t) => t.toolNumber)).size, D.DEFAULT_TOOLS.length);
    assert.ok(D.operationDefaults('isolation').depth >= 0.08, 'isolation depth leaves margin over 35 µm copper on an uneven board');
    for (const type of ['isolation', 'drilling', 'cutout', 'clearing']) assert.ok(D.pickTool(D.DEFAULT_TOOLS, type), type);
});

test('generate reports the machine transform used for display', () => {
    const p = project([ISO], { setup: { origin: 'board-lower-left' } });
    const r = generate(p);
    const b = G.bounds(C.boardFromOutline(layers().edge).shape);
    near(r.transform.shift[0], -b.xmin, 1e-9, 'shift x');
    near(r.transform.shift[1], -b.ymin, 1e-9, 'shift y');
    near(r.transform.mirrorX, b.xmin + b.xmax, 1e-9, 'mirror axis');
    // Mapping a cut back with the transform lands on the file coordinates.
    const cut = r.operations[0].cuts[0].points[0];
    const fileX = cut[0] - r.transform.shift[0];
    assert.ok(fileX >= b.xmin - 1 && fileX <= b.xmax + 1);
});

test('generate/analyze with `only`: one geometry at a time, same coordinates as the whole job', () => {
    const regions = [{ id: 'u1', shape: { kind: 'component', ref: 'U1', margin: 0.5 } }, { id: 'rest', shape: { kind: 'remainder' } }];
    const ops = [
        { ...ISO, id: 'fine', region: 'u1', passes: 1 },
        { ...ISO, id: 'coarse', region: 'rest', tool: 'v60', passes: 1 },
        DRL, CUT,
    ];
    const p = project(ops, { regions, setup: { origin: 'board-lower-left' } });
    const L = layers();
    const all = generate(p);
    for (const id of ['fine', 'coarse', 'drl', 'cut']) {
        const one = generate(p, { only: [id] });
        assert.deepEqual(one.operations.map((o) => o.id), [id]);
        assert.deepEqual(one.transform, all.transform, 'same machine frame');
        // Order and loop start points can differ (they follow where the previous op ended); the points don't.
        const pts = (cuts) => [...new Set(cuts.flatMap((c) => (c.kind === 'drill' ? [[c.x, c.y, c.z]] : c.points)).map((q) => q.map((v) => v.toFixed(3)).join(',')))].sort();
        assert.deepEqual(pts(one.operations[0].cuts), pts(all.operations.find((o) => o.id === id).cuts), `${id} cuts match the whole job`);
    }
    // The remainder still excludes U1 when only the coarse op runs.
    const coarse = generate(p, { only: ['coarse'] }).operations[0];
    const deep = G.offset(C.regionMask(p, p.operations[0], L), -C.widthAtDepth(TOOLS.v60, 0.05) - 0.01);
    for (const c of coarse.cuts) for (const q of c.points) assert.ok(!G.containsPoint(deep, q[0] - all.transform.shift[0], q[1] - all.transform.shift[1]));
    // Analysis for one op: its own gaps, coverage counted over all isolation ops on the input.
    assert.equal(C.analyzeProject(p, L, { only: ['coarse'] }).length, 0);
    const coarseAll = project([{ ...ISO, tool: 'v60', passes: 1 }, DRL]);
    assert.equal(C.analyzeProject(coarseAll, L, { only: ['drl'] }).length, 0, 'no isolation op selected → nothing to report');
    assert.equal(C.analyzeProject(coarseAll, L, { only: ['iso'] }).filter((i) => i.code === 'tool-too-wide').length, 1);
});
