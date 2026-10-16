import { test } from 'node:test';
import assert from 'node:assert/strict';
const { detectLayer, sniffFormat, roleFromFileFunction } = await import(new URL('../../plugins/pcb-cam/ui/core/import/detect.js', import.meta.url));

const GERBER = '%FSLAX46Y46*%\n%MOMM*%\nM02*\n';
const DRILL = 'M48\nMETRIC\nT1C0.8\n%\nM30\n';
const pick = (g) => [g.role, g.side, g.source];

test('format sniffing', () => {
    assert.equal(sniffFormat(GERBER), 'gerber');
    assert.equal(sniffFormat(DRILL), 'excellon');
    assert.equal(sniffFormat('G04 legacy comment*\nX0Y0D02*'), 'gerber');
    assert.equal(sniffFormat('hello'), null);
});

test('X2 file function wins over the name', () => {
    const parsed = { format: 'gerber', fileAttributes: { '.FileFunction': ['Copper', 'L2', 'Bot'] } };
    assert.deepEqual(pick(detectLayer('weird-name.gtl', { parsed })), ['copper', 'bottom', 'x2']);
    assert.equal(detectLayer('x.gbr', { parsed: { format: 'gerber', fileAttributes: { '.FileFunction': ['Copper', 'L3', 'Inr'] } } }).layer, 3);
    assert.deepEqual(roleFromFileFunction(['Profile', 'NP']), { role: 'outline', side: null });
    assert.deepEqual(roleFromFileFunction(['NonPlated', '1', '2', 'NPTH']), { role: 'drill', side: null, plated: false });
    assert.equal(roleFromFileFunction(undefined), null);
    // an X2 function we do not map falls back to the name
    const other = { format: 'gerber', fileAttributes: { '.FileFunction': ['Other', 'User'] } };
    assert.deepEqual(pick(detectLayer('board-Edge_Cuts.gbr', { parsed: other })), ['outline', null, 'filename']);
    assert.deepEqual(pick(detectLayer('board-User_1.gbr', { parsed: other })), ['other', null, 'x2']);
});

test('naming conventions', () => {
    const cases = [
        ['board-F_Cu.gbr', 'copper', 'top'],
        ['board-B_Cu.gbr', 'copper', 'bottom'],
        ['board-In1_Cu.gbr', 'copper', 'inner'],
        ['board-Edge_Cuts.gbr', 'outline', null],
        ['board-F_Mask.gbr', 'soldermask', 'top'],
        ['board-B_Silkscreen.gbr', 'silkscreen', 'bottom'],
        ['board-F_Paste.gbr', 'paste', 'top'],
        ['board-PTH.drl', 'drill', null],
        ['BOARD.GTL', 'copper', 'top'],
        ['BOARD.GBL', 'copper', 'bottom'],
        ['BOARD.GKO', 'outline', null],
        ['BOARD.G2', 'copper', 'inner'],
        ['board.cmp', 'copper', 'top'],
        ['board.sol', 'copper', 'bottom'],
        ['board.dim', 'outline', null],
        ['Gerber_TopLayer.GTL', 'copper', 'top'],
        ['Gerber_BottomLayer.GBL', 'copper', 'bottom'],
        ['Gerber_BoardOutlineLayer.GKO', 'outline', null],
        ['board.drd', 'drill', null],
        ['board.XLN', 'drill', null],
    ];
    for (const [name, role, side] of cases) {
        const g = detectLayer(name, { text: name.match(/\.(drl|drd|xln)$/i) ? DRILL : GERBER });
        assert.deepEqual([g.role, g.side], [role, side], name);
    }
    assert.equal(detectLayer('board-NPTH.drl', { text: DRILL }).plated, false);
    assert.equal(detectLayer('board-PTH.drl', { text: DRILL }).plated, true);
});

test('content beats a misleading name; unknown stays unknown', () => {
    // Altium writes drills as .txt
    assert.deepEqual(pick(detectLayer('RoundHoles.TXT', { text: DRILL })), ['drill', null, 'content']);
    assert.deepEqual(pick(detectLayer('board.GTL', { text: DRILL })), ['drill', null, 'content']);
    assert.equal(detectLayer('board-PTH.gbr', { text: GERBER }).role, 'unknown');
    assert.deepEqual(pick(detectLayer('notes.gbr', { text: GERBER })), ['unknown', null, 'none']);
});
