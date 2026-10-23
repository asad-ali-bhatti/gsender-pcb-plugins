import { test } from 'node:test';
import assert from 'node:assert/strict';
const P = await import(new URL('../../plugins/pcb-cam/ui/assets/persist.js', import.meta.url));

test('boardName takes the board name from a layer file', () => {
    assert.equal(P.boardName('blinky-F_Cu.gbr'), 'blinky');
    assert.equal(P.boardName('blinky-Edge_Cuts.gm1'), 'blinky');
    assert.equal(P.boardName('blinky-PTH.drl'), 'blinky');
    assert.equal(P.boardName('board.GTL'), 'board');
    assert.equal(P.boardName('Gerber_TopLayer.GTL'), '');
    assert.equal(P.boardName('Drill_PTH_Through.DRL'), '');
});

test('projectFileName never reuses a taken name', () => {
    assert.equal(P.projectFileName('blinky', new Set()), 'blinky.pcbcam.json');
    assert.equal(P.projectFileName('blinky', new Set(['blinky.pcbcam.json', 'blinky-2.pcbcam.json'])), 'blinky-3.pcbcam.json');
    assert.equal(P.projectFileName('a/b:c', new Set()), 'a-b-c.pcbcam.json');
    assert.equal(P.projectFileName('..', new Set()), 'board.pcbcam.json');
});
