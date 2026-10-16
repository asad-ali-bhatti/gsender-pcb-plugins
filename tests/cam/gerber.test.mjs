import { test } from 'node:test';
import assert from 'node:assert/strict';
const G = await import(new URL('../../plugins/pcb-cam/ui/core/geometry.js', import.meta.url));
const { parseGerber, tokenize, evalExpression } = await import(new URL('../../plugins/pcb-cam/ui/core/import/gerber.js', import.meta.url));

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
// Polygonised circles lose at most perimeter × tolerance of area.
const arcLoss = (perimeter) => perimeter * G.ARC_TOLERANCE + 1e-9;

/** Coordinate in 4.6 format, mm. */
const c = (v) => String(Math.round(v * 1e6));
const xy = (x, y) => `X${c(x)}Y${c(y)}`;
const doc = (body, { units = 'MM', fs = 'LAX46Y46' } = {}) => `%FS${fs}*%\n%MO${units}*%\n%LPD*%\n${body}\nM02*\n`;
const errors = (r) => r.issues.filter((i) => i.severity === 'error');
const codes = (r) => r.issues.map((i) => i.code);
const clean = (r) => assert.deepEqual(errors(r), [], JSON.stringify(r.issues));

test('tokenizer: CRLF, % inside comments and values, several commands in one block', () => {
    const toks = tokenize('%FSLAX46Y46*MOMM*%\r\nG04 50% done*\r\n%TO.N,100%*%\r\nD10*');
    assert.deepEqual(toks.map((t) => t.kind), ['extended', 'word', 'extended', 'word']);
    assert.deepEqual(toks[0].words.map((w) => w.text), ['FSLAX46Y46', 'MOMM']);
    assert.equal(toks[1].text, 'G04 50% done');
    assert.equal(toks[2].words[0].text, 'TO.N,100%');
    assert.equal(toks[3].line, 4);
    const issues = [];
    tokenize('%FSLAX46Y46*', (...a) => issues.push(a));
    assert.equal(issues[0][1], 'unterminated-extended');
});

test('macro expressions', () => {
    const v = new Map([[1, 0.5], [2, 3]]);
    assert.equal(evalExpression('$1+$1', v), 1);
    assert.equal(evalExpression('$2x2-1', v), 5);
    assert.equal(evalExpression('$2X(2-1)/4', v), 0.75);
    assert.equal(evalExpression('-$1', v), -0.5);
    assert.equal(evalExpression('--2', v), 2);
    assert.equal(evalExpression('.5+1.', v), 1.5);
    assert.equal(evalExpression('$9', v), 0, 'unset variables are 0');
    assert.equal(evalExpression('1+2x3'), 7, 'precedence');
    assert.throws(() => evalExpression('1/0'));
    assert.throws(() => evalExpression('1+'));
    assert.throws(() => evalExpression('(1'));
});

test('standard apertures flash with correct area', () => {
    const r = parseGerber(doc([
        '%ADD10C,1*%', '%ADD11R,2X1X0.5*%', '%ADD12O,3X1*%', '%ADD13P,2X4*%', '%ADD14R,2X2X1X1*%',
        'D10*', `${xy(0, 0)}D03*`,
        'D11*', `${xy(10, 0)}D03*`,
        'D12*', `${xy(20, 0)}D03*`,
        'D13*', `${xy(30, 0)}D03*`,
        'D14*', `${xy(40, 0)}D03*`,
    ].join('\n')));
    clean(r);
    const [c1, r1, o1, p1, r2] = r.objects.map((o) => G.area(o.shape));
    near(c1, Math.PI / 4, arcLoss(Math.PI), 'circle');
    near(r1, 2 - Math.PI * 0.0625, arcLoss(Math.PI * 0.5), 'rect with round hole');
    near(o1, 2 + Math.PI / 4, arcLoss(Math.PI), 'obround');
    near(p1, 2, 1e-5, 'square polygon, vertices on the axes (diagonals 2)');
    near(r2, 3, 1e-9, 'rect with rect hole');
    assert.deepEqual(r.objects[1].at, [10, 0]);
    assert.deepEqual(G.bounds(r.objects[3].shape), { xmin: 29, ymin: -1, xmax: 31, ymax: 1 });
    near(G.area(r.image), c1 + r1 + o1 + p1 + r2, 1e-6, 'image is the union');
});

test('strokes: circular and rectangular apertures, zero-width outlines', () => {
    const r = parseGerber(doc([
        '%ADD10C,0.2*%', '%ADD11R,1X1*%', '%ADD12C,0*%',
        'D10*', `${xy(0, 0)}D02*`, `G01*`, `${xy(10, 0)}D01*`,
        'D11*', `${xy(0, 10)}D02*`, `${xy(3, 14)}D01*`,
        'D12*', `${xy(0, 20)}D02*`, `${xy(5, 20)}D01*`, `${xy(5, 25)}D01*`,
    ].join('\n')));
    clean(r);
    const [s1, s2, s3] = r.objects;
    near(G.area(s1.shape), 10 * 0.2 + Math.PI * 0.01, arcLoss(0.2 * Math.PI), 'round stroke');
    assert.equal(s1.width, 0.2);
    near(G.area(s2.shape), 1 + 3 + 4, 1e-6, 'rect swept along (3,4): wh + |dx|h + |dy|w');
    assert.deepEqual(s3.shape, [], 'zero-size aperture draws nothing');
    assert.deepEqual(s3.path, [[0, 20], [5, 20], [5, 25]], 'but keeps its centreline');
    const e = r.extent;
    near(e.xmin, -0.5, 1e-9); near(e.ymin, -0.1, 0.001); near(e.xmax, 10.1, 0.001); near(e.ymax, 25, 1e-9);
});

test('connected D01 segments form one track; D02 starts a new one', () => {
    const r = parseGerber(doc(['%ADD10C,0.1*%', 'D10*', `${xy(0, 0)}D02*`, `${xy(1, 0)}D01*`, `${xy(1, 1)}D01*`, `${xy(5, 5)}D02*`, `${xy(6, 5)}D01*`].join('\n')));
    clean(r);
    assert.equal(r.objects.length, 2);
    assert.deepEqual(r.objects[0].path, [[0, 0], [1, 0], [1, 1]]);
});

test('arcs: G75 full circle, G75 half circle region, G74 quarter', () => {
    const r = parseGerber(doc([
        '%ADD10C,0.2*%', 'G75*', 'D10*',
        `${xy(5, 0)}D02*`, `G03${xy(5, 0)}I${c(-5)}J0D01*`,
        'G36*', `${xy(15, 0)}D02*`, `G01${xy(25, 0)}D01*`, `G03${xy(15, 0)}I${c(-5)}J0D01*`, 'G37*',
    ].join('\n')));
    clean(r);
    near(G.area(r.objects[0].shape), Math.PI * (5.1 ** 2 - 4.9 ** 2), arcLoss(2 * Math.PI * 10.2), 'annulus');
    for (const [x, y] of r.objects[0].path) near(Math.hypot(x, y), 5, 1e-9, 'on the circle');
    near(G.area(r.objects[1].shape), (Math.PI * 25) / 2, arcLoss(Math.PI * 5), 'half disc');
    assert.ok(r.objects[1].contour.some(([x, y]) => Math.abs(x - 20) < 1e-6 && Math.abs(y - 5) < 1e-6), 'passes over the top');

    const q = parseGerber(doc(['%ADD10C,0.1*%', 'G74*', 'D10*', `${xy(1, 0)}D02*`, `G03${xy(0, 1)}I${c(1)}J0D01*`].join('\n')));
    clean(q);
    const path = q.objects[0].path;
    for (const [x, y] of path) near(Math.hypot(x, y), 1, 1e-9, 'quarter on unit circle');
    assert.ok(path.every(([x, y]) => x >= -1e-9 && y >= -1e-9), 'stays in first quadrant');
    // clockwise G75 quarter from (0,1) to (1,0) around the origin
    const cw = parseGerber(doc(['%ADD10C,0.1*%', 'G75*', 'D10*', `${xy(0, 1)}D02*`, `G02${xy(1, 0)}I0J${c(-1)}D01*`].join('\n')));
    clean(cw);
    assert.ok(cw.objects[0].path.every(([x, y]) => x >= -1e-9 && y >= -1e-9 && Math.abs(Math.hypot(x, y) - 1) < 1e-9));
});

test('regions: cut-in hole, any orientation, several contours', () => {
    // 10×10 square with a 4×4 hole joined by a cut-in line
    const cutIn = ['G36*', `${xy(0, 0)}D02*`, 'G01*', `${xy(10, 0)}D01*`, `${xy(10, 10)}D01*`, `${xy(0, 10)}D01*`, `${xy(0, 5)}D01*`,
        `${xy(3, 5)}D01*`, `${xy(3, 7)}D01*`, `${xy(7, 7)}D01*`, `${xy(7, 3)}D01*`, `${xy(3, 3)}D01*`, `${xy(3, 5)}D01*`,
        `${xy(0, 5)}D01*`, `${xy(0, 0)}D01*`, 'G37*'];
    const r = parseGerber(doc(cutIn.join('\n')));
    clean(r);
    near(G.area(r.image), 84, 1e-9, 'cut-in hole');
    // two contours in one G36 (one clockwise) become two filled regions
    const two = parseGerber(doc(['G36*', `${xy(0, 0)}D02*`, 'G01*', `${xy(1, 0)}D01*`, `${xy(1, 1)}D01*`, `${xy(0, 1)}D01*`, `${xy(0, 0)}D01*`,
        `${xy(5, 0)}D02*`, `${xy(5, 1)}D01*`, `${xy(6, 1)}D01*`, `${xy(6, 0)}D01*`, `${xy(5, 0)}D01*`, 'G37*'].join('\n')));
    clean(two);
    assert.equal(two.objects.length, 2);
    near(G.area(two.image), 2, 1e-9);
    // unclosed contour is closed with a warning
    const open = parseGerber(doc(['G36*', `${xy(0, 0)}D02*`, 'G01*', `${xy(2, 0)}D01*`, `${xy(2, 2)}D01*`, 'G37*'].join('\n')));
    assert.ok(codes(open).includes('region-open'));
    near(G.area(open.image), 2, 1e-9);
});

test('polarity: clear removes from earlier dark only', () => {
    const r = parseGerber(doc([
        '%ADD10R,10X10*%', '%ADD11C,2*%',
        'D10*', `${xy(0, 0)}D03*`,
        '%LPC*%', 'D11*', `${xy(0, 0)}D03*`,
        '%LPD*%', `${xy(20, 0)}D03*`,
    ].join('\n')));
    clean(r);
    near(G.area(r.image), 100 - Math.PI + Math.PI, arcLoss(4 * Math.PI), 'hole in square plus a later dark disc');
    assert.equal(r.objects[1].polarity, 'clear');
    assert.equal(G.islands(r.image).length, 2);
    assert.equal(G.containsPoint(r.image, 0, 0), false);
});

test('KiCad RoundRect macro', () => {
    const am = ['%AMRoundRect*', '0 Rectangle with rounded corners*', '0 $1 Rounding radius*',
        '4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*',
        '1,1,$1+$1,$2,$3*', '1,1,$1+$1,$4,$5*', '1,1,$1+$1,$6,$7*', '1,1,$1+$1,$8,$9*',
        '20,1,$1+$1,$2,$3,$4,$5,0*', '20,1,$1+$1,$4,$5,$6,$7,0*', '20,1,$1+$1,$6,$7,$8,$9,0*', '20,1,$1+$1,$8,$9,$2,$3,0*%'].join('\n');
    const r = parseGerber(doc([am, '%ADD11RoundRect,0.150000X-0.150000X0.587500X-0.150000X-0.587500X0.150000X-0.587500X0.150000X0.587500X0*%',
        'D11*', `${xy(1, 2)}D03*`].join('\n')));
    clean(r);
    const W = 0.6, H = 1.475, R = 0.15;
    near(G.area(r.image), W * H - (4 - Math.PI) * R * R, arcLoss(2 * Math.PI * R), 'rounded rectangle');
    const b = G.bounds(r.image);
    near(b.xmin, 1 - W / 2, 1e-6); near(b.xmax, 1 + W / 2, 1e-6);
    near(b.ymin, 2 - H / 2, 1e-6); near(b.ymax, 2 + H / 2, 1e-6);
});

test('macro primitives: variables, exposure off, rotation about the origin, thermal', () => {
    const r = parseGerber(doc([
        '%AMDONUT*$3=$1x2*1,1,$3,0,0*1,0,$2,0,0*%', '%ADD10DONUT,1X0.5*%',
        // polygon centred at (1,0), rotated 90° about the macro origin → centre (0,1)
        '%AMPOLY*5,1,4,1,0,1.414214,90*%', '%ADD11POLY*%',
        '%AMTRI*4,1,3,0,0,2,0,0,2,0,0,0*%', '%ADD12TRI*%',
        '%AMTH*7,0,0,2,1,0.2,0*%', '%ADD13TH*%',
        '%AMCL*21,1,2,1,0,0,90*%', '%ADD14CL*%',
        'D10*', `${xy(0, 0)}D03*`, 'D11*', `${xy(10, 0)}D03*`, 'D12*', `${xy(20, 0)}D03*`, 'D13*', `${xy(30, 0)}D03*`, 'D14*', `${xy(40, 0)}D03*`,
    ].join('\n')));
    clean(r);
    const [donut, poly, tri, th, cl] = r.objects;
    near(G.area(donut.shape), Math.PI * (1 - 0.0625), arcLoss(2.5 * Math.PI), 'disc d=2 minus disc d=0.5');
    near(G.area(poly.shape), 1, 5e-4, 'polygon area (square of diagonal √2; vertices rounded to 0.1 µm)');
    const pb = G.bounds(poly.shape);
    near((pb.xmin + pb.xmax) / 2, 10, 1e-6, 'polygon centre x after rotation');
    near((pb.ymin + pb.ymax) / 2, 1, 1e-6, 'polygon centre y after rotation');
    near(G.area(tri.shape), 2, 1e-9, 'outline triangle');
    assert.equal(G.islands(th.shape).length, 4, 'thermal has four spokes');
    assert.ok(G.area(th.shape) < Math.PI * 0.75 && G.area(th.shape) > Math.PI * 0.75 - 0.5);
    assert.deepEqual(G.bounds(cl.shape), { xmin: 39.5, ymin: -1, xmax: 40.5, ymax: 1 }, 'centre line 2×1 rotated 90°');
});

test('inch units and trailing-zero format', () => {
    const r = parseGerber(doc(['%ADD10C,0.1*%', 'D10*', 'X10000Y0D03*'].join('\n'), { units: 'IN', fs: 'LAX24Y24' }));
    clean(r);
    assert.equal(r.units, 'in');
    assert.deepEqual(r.objects[0].at, [25.4, 0]);
    near(G.area(r.image), Math.PI * 1.27 ** 2, arcLoss(Math.PI * 2.54));
    const t = parseGerber(doc(['%ADD10C,1*%', 'D10*', 'X12Y-015D03*'].join('\n'), { fs: 'TAX23Y23' }));
    assert.deepEqual(errors(t), []);
    assert.ok(codes(t).includes('trailing-zeros'));
    assert.deepEqual(t.objects[0].at, [12, -1.5]);
});

test('X2 attributes: file, aperture and object dictionaries', () => {
    const r = parseGerber(doc([
        '%TF.FileFunction,Copper,L1,Top*%',
        '%TA.AperFunction,SMDPad,CuDef*%', '%ADD10R,1X1*%', '%TD*%',
        '%TA.AperFunction,Conductor*%', '%ADD11C,0.25*%', '%TD*%',
        'D10*', '%TO.P,U3,1,VCC*%', '%TO.N,+3V3*%', `${xy(0, 0)}D03*`,
        '%TO.P,U3,2*%', '%TO.N,GND net*%', `${xy(1, 0)}D03*`, '%TD*%',
        'D11*', 'G04 #@! TO.N,SIG\\u0041*', `${xy(0, 0)}D02*`, `${xy(1, 0)}D01*`, '%TD.N*%',
        '%TA.AperFunction,Conductor*%', 'G36*', `${xy(5, 5)}D02*`, `${xy(6, 5)}D01*`, `${xy(6, 6)}D01*`, `${xy(5, 5)}D01*`, 'G37*',
    ].join('\n')));
    clean(r);
    assert.deepEqual(r.fileAttributes['.FileFunction'], ['Copper', 'L1', 'Top']);
    const [p1, p2, trace, region] = r.objects;
    assert.deepEqual(p1.apertureAttrs['.AperFunction'], ['SMDPad', 'CuDef']);
    assert.deepEqual(p1.attrs, { '.P': ['U3', '1', 'VCC'], '.N': ['+3V3'] });
    assert.deepEqual(p2.attrs['.N'], ['GND net'], 'spaces are kept');
    assert.deepEqual(trace.attrs, { '.N': ['SIGA'] }, 'TD cleared .P, comment-style X2 and \\u escapes work');
    assert.deepEqual(trace.apertureAttrs['.AperFunction'], ['Conductor']);
    assert.deepEqual(region.attrs, {}, 'TD.N removed the net');
    assert.deepEqual(region.apertureAttrs['.AperFunction'], ['Conductor'], 'regions take the current TA dictionary');
});

test('step & repeat replicates objects with their attributes', () => {
    const r = parseGerber(doc(['%ADD10C,1*%', 'D10*', '%SRX2Y3I5J4*%', '%TO.N,X*%', `${xy(0, 0)}D03*`, '%SR*%', `${xy(100, 0)}D03*`].join('\n')));
    clean(r);
    assert.equal(r.objects.length, 7);
    const ats = r.objects.slice(0, 6).map((o) => o.at);
    assert.deepEqual(ats, [[0, 0], [5, 0], [0, 4], [5, 4], [0, 8], [5, 8]]);
    assert.deepEqual(r.objects[5].attrs['.N'], ['X']);
    near(G.area(r.image), 7 * (Math.PI / 4), arcLoss(7 * Math.PI));
});

test('aperture blocks flash their contents', () => {
    const r = parseGerber(doc(['%ADD10C,1*%', '%ABD20*%', 'D10*', `${xy(0, 0)}D03*`, `${xy(2, 0)}D03*`, '%AB*%', 'D20*', `${xy(10, 10)}D03*`, `${xy(20, 10)}D03*`].join('\n')));
    clean(r);
    assert.deepEqual(r.objects.map((o) => o.at), [[10, 10], [12, 10], [20, 10], [22, 10]]);
});

test('aperture rotation and scaling (LR / LS)', () => {
    const r = parseGerber(doc(['%ADD10R,2X1*%', 'D10*', '%LR90*%', `${xy(0, 0)}D03*`, '%LR0*%', '%LS2*%', `${xy(10, 0)}D03*`].join('\n')));
    clean(r);
    assert.deepEqual(G.bounds(r.objects[0].shape), { xmin: -0.5, ymin: -1, xmax: 0.5, ymax: 1 });
    assert.deepEqual(G.bounds(r.objects[1].shape), { xmin: 8, ymin: -1, xmax: 12, ymax: 1 });
});

test('fails loudly on unsupported or broken input', () => {
    const noUnits = parseGerber('%FSLAX46Y46*%\n%ADD10C,1*%\nD10*\nX0Y0D03*\nM02*');
    assert.ok(codes(noUnits).includes('units-missing'));
    assert.ok(codes(parseGerber(doc('%LMX*%'))).includes('unsupported-mirror'));
    assert.ok(codes(parseGerber(doc('%IPNEG*%'))).includes('unsupported-image-polarity'));
    assert.ok(codes(parseGerber(doc('%XYZ*%'))).includes('unsupported-command'));
    assert.ok(codes(parseGerber('%FSLAX46Y46*%\n%MOMM*%\n')).includes('no-end'));
    assert.ok(codes(parseGerber(doc('D11*\nX0Y0D03*'))).includes('unknown-aperture'));
    const macroStroke = parseGerber(doc(['%AMBOX*21,1,1,1,0,0,0*%', '%ADD10BOX*%', 'D10*', 'X0Y0D02*', `${xy(1, 0)}D01*`].join('\n')));
    assert.ok(codes(macroStroke).includes('stroke-aperture'));
    const holeStroke = parseGerber(doc(['%ADD10C,1X0.5*%', 'D10*', 'X0Y0D02*', `${xy(1, 0)}D01*`].join('\n')));
    assert.ok(codes(holeStroke).includes('stroke-aperture'));
    assert.ok(codes(parseGerber(doc('%ADD10P,1X20*%'))).includes('bad-aperture'));
    assert.ok(codes(parseGerber(doc('%ADD10C,1*%\nG36*\nD10*\nX0Y0D03*\nG37*'))).includes('flash-in-region'));
    assert.ok(codes(parseGerber(doc('%ADD10C,1*%\nD10*\nX0Y0D02*\nG36*\nX1Y1D01*'))).includes('region-unterminated'));
    const modal = parseGerber(doc(['%ADD10C,1*%', 'D10*', 'X0Y0D02*', `${xy(1, 0)}D01*`, `${xy(2, 0)}*`].join('\n')));
    assert.ok(codes(modal).includes('modal-operation'));
    assert.deepEqual(modal.objects[0].path, [[0, 0], [1, 0], [2, 0]]);
});
