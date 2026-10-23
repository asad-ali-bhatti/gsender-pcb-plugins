import { test } from 'node:test';
import assert from 'node:assert/strict';
const { runScan, parseWcoZ, validateScanSettings } = await import(new URL('../plugins/autoleveler/ui/assets/scan.js', import.meta.url));
const { gridPoints, createHeightMap, centerPoint, probeOrder } = await import(new URL('../plugins/autoleveler/ui/assets/leveling.js', import.meta.url));

/**
 * Minimal GRBL simulator. `surface(x, y)` is the board surface in machine Z.
 * Any non-probe move that puts the tip below the surface is recorded as a crash;
 * a probe move with a dead probe input that passes the surface is too.
 */
function makeMachine({ surface, start, wcoZ, probeWorks = true }) {
    const m = {
        pos: { ...start }, // machine coordinates of the tip
        wco: { x: 0, y: 0, z: wcoZ },
        abs: true,
        crashes: [],
        sent: [],
        pin: false,
    };
    const below = (p) => p.z < surface(p.x, p.y) - 1e-9;
    const word = (cmd, L) => { const r = new RegExp(`${L}(-?[\\d.]+)`).exec(cmd); return r ? parseFloat(r[1]) : undefined; };
    m.send = async (cmd) => {
        m.sent.push(cmd);
        const c = cmd.toUpperCase();
        let abs = m.abs;
        if (/\bG91\b/.test(c)) abs = false;
        if (/\bG90\b/.test(c)) abs = true;
        if (c === 'G90' || c === 'G91' || c === 'G21' || c.startsWith('G4')) { m.abs = abs; return ['ok']; }
        if (c === '$G') return [`[GC:G0 G54 G17 G21 ${m.abs ? 'G90' : 'G91'} G94 M5 M9 T0 F0 S0]`, 'ok'];
        if (c === '$#') return ['[G54:0.000,0.000,' + m.wco.z.toFixed(3) + ']', '[G55:0.000,0.000,0.000]', '[G92:0.000,0.000,0.000]', '[TLO:0.000]', '[PRB:0.000,0.000,0.000:0]', 'ok'];
        if (c.startsWith('G10 L20 P0')) { const z = word(c, 'Z'); m.wco.z = m.pos.z - z; return ['ok']; }
        if (/\bG38\.2\b/.test(c)) {
            const z = word(c, 'Z');
            const target = abs ? z + m.wco.z : m.pos.z + z;
            assert.ok(target < m.pos.z, `probe must move down: ${cmd}`);
            const s = surface(m.pos.x, m.pos.y);
            if (m.pos.z < s) m.crashes.push(`probe started below surface: ${cmd}`);
            if (probeWorks && target <= s) {
                m.pos.z = s;
                return [`[PRB:${m.pos.x.toFixed(3)},${m.pos.y.toFixed(3)},${s.toFixed(3)}:1]`, 'ok'];
            }
            if (target < s) m.crashes.push(`dead probe drove ${(s - target).toFixed(2)} mm into the board: ${cmd}`);
            m.pos.z = target;
            return [`[PRB:${m.pos.x.toFixed(3)},${m.pos.y.toFixed(3)},${target.toFixed(3)}:0]`, 'ALARM:4'];
        }
        if (/\bG0\b/.test(c)) {
            const machineCoords = /\bG53\b/.test(c);
            const next = { ...m.pos };
            for (const L of ['X', 'Y', 'Z']) {
                const v = word(c, L);
                if (v === undefined) continue;
                const k = L.toLowerCase();
                next[k] = machineCoords ? v : abs ? v + m.wco[k] : m.pos[k] + v;
            }
            // XY moves happen at the higher of the two Z values only if Z moves first; G0 moves
            // all axes together, so check both ends.
            if (below(next) || below({ ...next, z: m.pos.z }) && (next.x !== m.pos.x || next.y !== m.pos.y)) {
                m.crashes.push(`rapid into the board: ${cmd} (tip ${next.z.toFixed(3)} vs surface ${surface(next.x, next.y).toFixed(3)})`);
            }
            m.pos = next;
            return ['ok'];
        }
        throw new Error(`simulator does not know ${cmd}`);
    };
    return m;
}

const SETTINGS = { clearance: 2, maxBelow: 1, firstTravel: 10, feed: 60, slowFeed: 15, backoff: 0.5, zeroFirst: true };
const GRID = { xmin: 0, xmax: 20, ymin: 0, ymax: 30, nx: 3, ny: 4 };
const tilt = (x, y) => -46.2 + 0.003 * x + 0.004 * y; // ~0.18 mm across the board
// The scan probes the grid point nearest the middle first; heights are relative to it.
const A = centerPoint(gridPoints(GRID));
const ref = () => tilt(A.x, A.y);

function io(machine, { pinSeq } = {}) {
    let pinCalls = 0;
    return {
        send: (cmd) => machine.send(cmd),
        probePin: async () => (pinSeq ? pinSeq(pinCalls++) : false),
        aborted: () => false,
        sleep: async () => {},
        log: () => {},
        status: () => {},
        onPoint: () => {},
    };
}

async function scan(machine, opts = {}, map = createHeightMap(GRID)) {
    await runScan(io(machine, opts), { ...SETTINGS, ...opts.settings }, map, gridPoints(GRID), { touchTest: false, ...opts.run });
    return map;
}

test('normal scan measures the surface relative to the first (middle) point', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    const map = await scan(m);
    assert.deepEqual(m.crashes, []);
    assert.equal(map.anchor, A.idx, 'anchor recorded');
    assert.ok(/G0 X10 Y(10|20)/.test(m.sent.find((c) => /^G0 X/.test(c))), 'first move goes to the middle of the grid');
    for (const p of gridPoints(GRID)) {
        assert.ok(Math.abs(map.z[p.idx] - (tilt(p.x, p.y) - ref())) < 1e-6, `point ${p.idx}`);
    }
    assert.ok(Math.abs(m.wco.z - ref()) < 1e-9, 'work Z0 set at first point');
    assert.ok(!m.sent.some((c) => /^G0 Z/.test(c)), 'no absolute work-Z rapids');
});

test('with Z0 set at the job origin, the scan moves work Z0 to the copper at X0 Y0', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    const map = await scan(m, { settings: { zeroAt: 'origin' } });
    assert.deepEqual(m.crashes, []);
    assert.ok(Math.abs(m.wco.z - tilt(0, 0)) < 1e-4, `work Z0 ${m.wco.z} vs copper at X0 Y0 ${tilt(0, 0)}`);
    // The map stays relative to the first point; levelling shifts it to X0 Y0.
    assert.ok(Math.abs(map.z[A.idx]) < 1e-9);
});

test('the panel\'s probe order matches the order the scan probes', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    await scan(m);
    const visited = m.sent.filter((c) => /^G0 X/.test(c));
    const expected = probeOrder(gridPoints(GRID)).map((p) => `G0 X${p.x} Y${p.y}`);
    assert.deepEqual(visited, expected);
});

test('stale Z0 (new, 5 mm longer bit, not re-zeroed) does not crash', async () => {
    // Work Z0 is 5 mm below the real surface: the old code's "G0 Z2" rapid went 3 mm into the board.
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -44 }, wcoZ: -51.2 });
    const map = await scan(m);
    assert.deepEqual(m.crashes, []);
    assert.ok(Math.abs(map.z[11] - (tilt(20, 30) - ref())) < 1e-6);
});

test('Z0 far above the surface is also fine', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -40 }, wcoZ: -20 });
    await scan(m);
    assert.deepEqual(m.crashes, []);
});

test('bit starting too high fails cleanly instead of searching forever', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -20 }, wcoZ: -46.2 });
    await assert.rejects(scan(m), /travelled 12 mm down without touching/);
    assert.deepEqual(m.crashes, []);
});

test('dead probe is caught by the touch test before anything moves', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2, probeWorks: false });
    await assert.rejects(scan(m, { run: { touchTest: true } }), /never triggered during the touch test/);
    assert.deepEqual(m.sent, []);
});

test('probe input already triggered aborts before moving', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    await assert.rejects(scan(m, { pinSeq: () => true }), /already triggered/);
    assert.deepEqual(m.sent, []);
});

test('touch test passes when the pin closes and opens', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    const seq = [false, false, true, true, false];
    await scan(m, { pinSeq: (i) => seq[Math.min(i, seq.length - 1)], run: { touchTest: true } });
    assert.deepEqual(m.crashes, []);
});

test('dead probe without the touch test plunges at most the capped first travel', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2, probeWorks: false });
    await assert.rejects(scan(m), /without touching/);
    // starts (-43 - surface) above the first point's surface, lifts 2, probes 12:
    // bounded by firstTravel + clearance, never the old -30.
    const past = (12 - (-43 - ref()) - 2).toFixed(2);
    assert.equal(m.crashes.length, 1);
    assert.match(m.crashes[0], new RegExp(`drove ${past} mm`));
});

test('dead probe with Z0 on the copper stops 1 mm below Z0, not the full first travel', async () => {
    // Z0 set on the surface with gSender's touch plate; the board copper isn't wired to the probe.
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: ref(), probeWorks: false });
    const workZ = async () => m.pos.z - m.wco.z;
    await assert.rejects(
        runScan({ ...io(m), readWorkZ: workZ }, SETTINGS, createHeightMap(GRID), gridPoints(GRID), { touchTest: false }),
        /1 mm below work Z0 without touching.*board's copper/);
    assert.equal(m.crashes.length, 1);
    assert.match(m.crashes[0], /drove 1\.00 mm/);
});

test('Z0 below the bit start but far away keeps the configured first travel', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -60 });
    const map = createHeightMap(GRID);
    await runScan({ ...io(m), readWorkZ: async () => m.pos.z - m.wco.z }, SETTINGS, map, gridPoints(GRID), { touchTest: false });
    assert.deepEqual(m.crashes, []);
});

test('later probes stop at maxBelow under the first surface', async () => {
    // A hole / missing copper 3 mm deep at one point.
    const holey = (x, y) => (x === 20 && y === 0 ? tilt(x, y) - 3 : tilt(x, y));
    const m = makeMachine({ surface: holey, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2, probeWorks: true });
    await assert.rejects(scan(m, { settings: { slowFeed: 0 } }), /travelled 3 mm down without touching/);
    assert.deepEqual(m.crashes, []);
});

test('resume continues with the same zero and refuses after a re-zero', async () => {
    const pts = gridPoints(GRID);
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    const map = await scan(m);
    const partial = { ...map, z: map.z.map((v, i) => (i < 5 ? v : null)) };

    const m2 = makeMachine({ surface: tilt, start: { x: 10, y: 10, z: -44 }, wcoZ: m.wco.z });
    await runScan(io(m2), SETTINGS, partial, pts, { resume: true, touchTest: false });
    assert.deepEqual(m2.crashes, []);
    for (const p of pts) assert.ok(Math.abs(partial.z[p.idx] - map.z[p.idx]) < 1e-6);

    const partial2 = { ...map, z: map.z.map((v, i) => (i < 5 ? v : null)) };
    const m3 = makeMachine({ surface: tilt, start: { x: 10, y: 10, z: -44 }, wcoZ: m.wco.z - 0.5 });
    await assert.rejects(runScan(io(m3), SETTINGS, partial2, pts, { resume: true, touchTest: false }), /work zero or the bit changed/);
    assert.deepEqual(m3.crashes, []);
});

test('settings outside the safe range are rejected', () => {
    assert.match(validateScanSettings({ ...SETTINGS, maxBelow: 30 }).join(), /Max depth below first point/);
    assert.match(validateScanSettings({ ...SETTINGS, firstTravel: 40 }).join(), /First probe max travel/);
    assert.deepEqual(validateScanSettings(SETTINGS), []);
});

test('parseWcoZ uses the active WCS plus G92 and TLO', () => {
    const hash = ['[G54:1.000,2.000,-40.000]', '[G55:0,0,-10.000]', '[G92:0.000,0.000,0.500]', '[TLO:0.250]', '[PRB:0,0,0:0]'];
    assert.equal(parseWcoZ(['[GC:G0 G54 G17 G21 G90]'], hash), -39.25);
    assert.equal(parseWcoZ(['[GC:G0 G55 G17 G21 G90]'], hash), -9.25);
    assert.equal(parseWcoZ(['[GC:G0 G54]'], ['ok']), null);
});

test('grblHAL: work offset comes from status reports, no $ commands are sent', async () => {
    const m = makeMachine({ surface: tilt, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    const send = m.send;
    m.send = (cmd) => (cmd.startsWith('$') ? Promise.resolve(['error:3']) : send(cmd));
    const calls = [];
    const map = createHeightMap(GRID);
    await runScan({ ...io(m), readWcoZ: async (o) => { calls.push(o); return m.wco.z; } }, SETTINGS, map, gridPoints(GRID), { touchTest: false });
    assert.deepEqual(m.crashes, []);
    assert.ok(!m.sent.some((c) => c.startsWith('$')), 'no $ commands');
    assert.deepEqual(calls, [{ atCurrent: true }]);
    for (const p of gridPoints(GRID)) assert.ok(Math.abs(map.z[p.idx] - (tilt(p.x, p.y) - ref())) < 1e-6, `point ${p.idx}`);
});

test('margin off the copper: the first probe is still on the board', async () => {
    // The blank starts at X0 Y0; the 1 mm margin puts the corner points off the copper
    // (over the spoilboard, 1.6 mm lower). The old corner-first scan probed there first.
    const offBlank = (x, y) => (x < 0 || y < 0 ? tilt(0, 0) - 1.6 : tilt(x, y));
    const g = { xmin: -1, xmax: 21, ymin: -1, ymax: 26, nx: 3, ny: 3 };
    const m = makeMachine({ surface: offBlank, start: { x: 50, y: 50, z: -43 }, wcoZ: -46.2 });
    const map = createHeightMap(g);
    await assert.rejects(runScan(io(m), SETTINGS, map, gridPoints(g), { touchTest: false }), /travelled 3 mm down without touching/);
    const first = gridPoints(g).find((p) => p.idx === map.anchor);
    assert.ok(first.x > 0 && first.y > 0, 'reference point is on the copper');
    assert.deepEqual(m.crashes, [], 'off-board points stop above the spoilboard (maxBelow), no crash');
});
