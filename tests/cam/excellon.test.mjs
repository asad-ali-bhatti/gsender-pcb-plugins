import { test } from 'node:test';
import assert from 'node:assert/strict';
const { parseExcellon, isPlated } = await import(new URL('../../plugins/pcb-cam/ui/core/import/excellon.js', import.meta.url));

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
const errors = (r) => r.issues.filter((i) => i.severity === 'error');
const codes = (r) => r.issues.map((i) => i.code);
const clean = (r) => assert.deepEqual(errors(r), [], JSON.stringify(r.issues));

// KiCad 10 default output (decimal, metric, G85 slots), trimmed.
const KICAD = `M48
; DRILL file KiCad 10.0.5 date 2026-10-16T19:22:30
; FORMAT={-:-/ absolute / metric / decimal}
; #@! TF.CreationDate,2026-10-16T19:22:30+02:00
; #@! TF.GenerationSoftware,Kicad,Pcbnew,10.0.5
; #@! TF.FileFunction,MixedPlating,1,2
FMAT,2
METRIC
; #@! TA.AperFunction,Plated,PTH,ViaDrill
T1C0.300
; #@! TA.AperFunction,Plated,PTH,ComponentDrill
T2C1.000
; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill
T3C1.500
%
G90
G05
T1
X103.81Y-83.49
X106.35
T2
X108.89Y-98.73
T3
X148.75Y-109.25G85X151.25Y-109.25
G05
M30
`;

test('KiCad decimal drill file: tools, attributes, holes, modal Y, G85 slot', () => {
    const r = parseExcellon(KICAD);
    clean(r);
    assert.equal(r.units, 'mm');
    assert.deepEqual(r.fileAttributes['.FileFunction'], ['MixedPlating', '1', '2']);
    assert.equal(r.plated, null);
    assert.deepEqual(Object.keys(r.tools), ['1', '2', '3']);
    assert.equal(r.tools[2].diameter, 1);
    assert.deepEqual(r.tools[3].attrs['.AperFunction'], ['NonPlated', 'NPTH', 'ComponentDrill']);
    assert.deepEqual(r.holes.map((h) => [h.tool, h.x, h.y]), [[1, 103.81, -83.49], [1, 106.35, -83.49], [2, 108.89, -98.73]]);
    assert.equal(r.slots.length, 1);
    assert.deepEqual(r.slots[0].path, [[148.75, -109.25], [151.25, -109.25]]);
    assert.equal(r.slots[0].diameter, 1.5);
    assert.equal(isPlated(r.holes[0], r), true);
    assert.equal(isPlated(r.slots[0], r), false);
    assert.deepEqual(r.bounds, { xmin: 103.81 - 0.15, ymin: -109.25 - 0.75, xmax: 151.25 + 0.75, ymax: -83.49 + 0.15 });
});

test('integer formats: LZ pads right, TZ divides, keep needs full length', () => {
    const body = (units, coord) => `M48\n${units}\nT1C${units.startsWith('INCH') ? '0.0400' : '1.000'}\n%\nT1\n${coord}\nM30\n`;
    // 142.750 / -81.000 mm in 3:3
    const tz = parseExcellon(`; FORMAT={3:3/ absolute / metric / suppress leading zeros}\n` + body('METRIC,TZ', 'X142750Y-81000'));
    clean(tz);
    assert.deepEqual([tz.holes[0].x, tz.holes[0].y], [142.75, -81]);
    const lz = parseExcellon(`; FORMAT={3:3/ absolute / metric / suppress trailing zeros}\n` + body('METRIC,LZ', 'X14275Y-081'));
    clean(lz);
    assert.deepEqual([lz.holes[0].x, lz.holes[0].y], [142.75, -81]);
    const keep = parseExcellon(`; FORMAT={3:3/ absolute / metric / keep zeros}\n` + body('METRIC', 'X142750Y-081000'));
    clean(keep);
    assert.deepEqual([keep.holes[0].x, keep.holes[0].y], [142.75, -81]);
    // inch 2:4: X56201 = 5.6201 in
    const inch = parseExcellon(`; FORMAT={2:4/ absolute / inch / suppress leading zeros}\n` + body('INCH,TZ', 'X56201Y-31890'));
    clean(inch);
    near(inch.holes[0].x, 5.6201 * 25.4, 1e-9);
    near(inch.holes[0].y, -3.189 * 25.4, 1e-9);
    near(inch.tools[1].diameter, 1.016, 1e-12);
    // header format suffix overrides defaults
    const suffix = parseExcellon(body('METRIC,TZ,000.00', 'X14275Y-8100'));
    clean(suffix);
    assert.deepEqual([suffix.holes[0].x, suffix.holes[0].y], [142.75, -81]);
    // no format anywhere: assumed with a warning
    const assumed = parseExcellon(body('METRIC,TZ', 'X142750Y-81000'));
    assert.ok(codes(assumed).includes('format-assumed'));
    assert.deepEqual([assumed.holes[0].x, assumed.holes[0].y], [142.75, -81]);
    // bare METRIC with short integers is ambiguous
    assert.ok(codes(parseExcellon(body('METRIC', 'X14275Y-81'))).includes('zeros-ambiguous'));
});

test('routed slots, inline tools, repeat, incremental, T0', () => {
    const r = parseExcellon(`M48
METRIC
%
T1C0.8
G00X0.0Y0.0
M15
G01X5.0Y0.0
G01X5.0Y5.0
M16
G05
X10.0Y10.0
R2X1.0Y0.0
T0
M30
`);
    clean(r);
    assert.deepEqual(r.slots[0].path, [[0, 0], [5, 0], [5, 5]]);
    assert.deepEqual(r.holes.map((h) => [h.x, h.y]), [[10, 10], [11, 10], [12, 10]]);
    const inc = parseExcellon('M48\nMETRIC\nICI,ON\nT1C1.0\n%\nT1\nX1.0Y1.0\nX1.0Y0.5\nM30\n');
    clean(inc);
    assert.deepEqual(inc.holes.map((h) => [h.x, h.y]), [[1, 1], [2, 1.5]]);
});

test('fails loudly', () => {
    assert.ok(codes(parseExcellon('M48\nMETRIC\nT1C1\n%\nX1Y1\nM30\n')).includes('no-tool'));
    assert.ok(codes(parseExcellon('M48\nMETRIC\n%\nT5\nX1.0Y1.0\nM30\n')).includes('tool-undefined-5'));
    assert.ok(codes(parseExcellon('M48\nFMAT,1\nMETRIC\n%\nM30\n')).includes('unsupported-format'));
    assert.ok(codes(parseExcellon('M48\nMETRIC\nFOO\n%\nM30\n')).includes('unsupported-header'));
    assert.ok(codes(parseExcellon('M48\nMETRIC\nT1C1\n%\nT1\nG00X0Y0\nM15\nG02X1Y1A1\nM30\n')).includes('unsupported-route-arc'));
    assert.ok(codes(parseExcellon('M48\nMETRIC\nT1C1\n%\nT1\nG93X1Y1\nM30\n')).includes('unsupported-gcode'));
    assert.ok(codes(parseExcellon('M48\nMETRIC\nT1C1\n%\nT1\nX1.0Y1.0\n')).includes('no-end'));
    assert.ok(codes(parseExcellon('M48\nT1C1\n%\nT1\nX1.0Y1.0\nM30\n')).includes('units-missing'));
});
