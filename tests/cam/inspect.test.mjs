import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const C = await import(new URL('../../plugins/pcb-cam/ui/core/index.js', import.meta.url));

const c = (v) => String(Math.round(v * 1e6));
const xy = (x, y) => `X${c(x)}Y${c(y)}`;

const TOP = `%TF.FileFunction,Copper,L1,Top*%
%FSLAX46Y46*%
%MOMM*%
%LPD*%
%TA.AperFunction,SMDPad,CuDef*%
%ADD10R,1X1*%
%TD*%
%TA.AperFunction,Conductor*%
%ADD11C,0.25*%
%TD*%
D10*
%TO.P,U1,1*%
%TO.N,VCC*%
${xy(2, 2)}D03*
%TO.P,U1,2*%
%TO.N,GND*%
${xy(4, 2)}D03*
%TO.P,R10,1*%
%TO.N,unconnected-(R10-Pad1)*%
${xy(10, 5)}D03*
%TO.P,R2,1*%
%TO.N,GND*%
${xy(15, 5)}D03*
%TD*%
D11*
%TO.N,GND*%
${xy(4, 2)}D02*
${xy(15, 5)}D01*
%TD*%
M02*
`;
const EDGE = `%TF.FileFunction,Profile,NP*%
%FSLAX46Y46*%
%MOMM*%
%ADD10C,0.05*%
D10*
${xy(0, 0)}D02*
${xy(20, 0)}D01*
${xy(20, 10)}D01*
${xy(0, 10)}D01*
${xy(0, 0)}D01*
M02*
`;
const DRILL = `M48
; #@! TF.FileFunction,MixedPlating,1,2
FMAT,2
METRIC
; #@! TA.AperFunction,Plated,PTH,ComponentDrill
T1C0.800
; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill
T2C3.000
%
G90
G05
T1
X2.0Y8.0
X4.0Y8.0
X6.0Y8.0G85X7.0Y8.0
T2
X18.0Y8.0
M30
`;

test('loadFile parses and guesses roles', () => {
    const top = C.loadFile('demo-F_Cu.gtl', TOP);
    assert.equal(top.layer.format, 'gerber');
    assert.deepEqual([top.guess.role, top.guess.side, top.guess.source], ['copper', 'top', 'x2']);
    assert.deepEqual([C.loadFile('demo-Edge_Cuts.gm1', EDGE).guess.role], ['outline']);
    const d = C.loadFile('demo.drl', DRILL);
    assert.deepEqual([d.layer.format, d.guess.role], ['excellon', 'drill']);
    const junk = C.loadFile('readme.txt', 'hello');
    assert.equal(junk.layer, null);
    assert.equal(junk.guess.role, 'unknown');
});

test('inspectBoard summarises layers, board, components, nets and drills', () => {
    const layers = { top: C.parseGerber(TOP), edge: C.parseGerber(EDGE), drill: C.parseExcellon(DRILL) };
    const project = { inputs: [{ id: 'top', role: 'copper', side: 'top' }, { id: 'edge', role: 'outline', side: null }, { id: 'drill', role: 'drill', side: null }] };
    const r = C.inspectBoard(layers, project);
    assert.deepEqual(r.board, { xmin: 0, ymin: 0, xmax: 20, ymax: 10, width: 20, height: 10, from: 'outline' }, 'board from the outline centreline');
    assert.deepEqual(r.components.map((x) => [x.ref, x.pads]), [['R2', 1], ['R10', 1], ['U1', 2]], 'natural sort');
    assert.deepEqual(r.components[2].bounds, { xmin: 1.5, ymin: 1.5, xmax: 4.5, ymax: 2.5 });
    assert.deepEqual(r.nets.named, [{ name: 'GND', objects: 3 }, { name: 'VCC', objects: 1 }]);
    assert.equal(r.nets.unconnected, 1);
    assert.deepEqual(r.drills, [{ diameter: 0.8, plated: true, holes: 2, slots: 1 }, { diameter: 3, plated: false, holes: 1, slots: 0 }]);
    const top = r.layers.find((l) => l.id === 'top');
    assert.deepEqual(top.objects, { flash: 4, stroke: 1, region: 0 });
    assert.equal(top.errors, 0);
    assert.ok(top.copperArea > 4, 'four 1×1 pads plus a trace');
    // without the project, roles are unknown and the board comes from nothing
    assert.equal(C.inspectBoard(layers).board, null);
});

// Real KiCad output, when kicad-cli is installed (skipped on CI).
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find(existsSync);
const BOARD = KICAD_CLI && ['/Applications/KiCad/KiCad.app/Contents/SharedSupport/template/Arduino_Nano/Arduino_Nano.kicad_pcb', '/usr/share/kicad/template/Arduino_Nano/Arduino_Nano.kicad_pcb'].find(existsSync);

test('KiCad smoke test: export a template board and inspect it', { skip: !BOARD && 'kicad-cli or template board not found' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcbcam-'));
    try {
        execFileSync(KICAD_CLI, ['pcb', 'export', 'gerbers', '-l', 'F.Cu,B.Cu,Edge.Cuts', '-o', dir + '/', BOARD], { stdio: 'ignore' });
        execFileSync(KICAD_CLI, ['pcb', 'export', 'drill', '--excellon-separate-th', '-o', dir + '/', BOARD], { stdio: 'ignore' });
        const layers = {};
        const inputs = [];
        for (const f of readdirSync(dir)) {
            const loaded = C.loadFile(f, readFileSync(join(dir, f), 'utf8'));
            if (!loaded.layer) continue;
            assert.deepEqual(loaded.layer.issues.filter((i) => i.severity === 'error'), [], f);
            const id = f.replace(/\W+/g, '-');
            layers[id] = loaded.layer;
            inputs.push({ id, role: loaded.guess.role, side: loaded.guess.side });
        }
        assert.deepEqual(inputs.map((i) => i.role).sort(), ['copper', 'copper', 'drill', 'drill', 'outline']);
        const r = C.inspectBoard(layers, { inputs });
        assert.equal(r.board.from, 'outline');
        assert.ok(r.board.width > 10 && r.board.height > 10, JSON.stringify(r.board));
        assert.ok(r.components.length > 0 && r.drills.length > 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
