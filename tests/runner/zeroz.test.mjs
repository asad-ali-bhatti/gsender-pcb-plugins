import { test } from 'node:test';
import assert from 'node:assert/strict';
const { zeroZ, raiseForBitChange, ZERO_DEFAULTS, validateZeroSettings } = await import(new URL('../../plugins/project-runner/ui/assets/zeroz.js', import.meta.url));

/**
 * A small Grbl: work Z = machine Z - wco; the copper is at machine Z `surface`.
 * The probe pin follows `pin` (a function of time for the touch test).
 */
function sim({ z = 10, surface = -40.15, wco = -40, pin = () => false, rejects = null } = {}) {
    const m = { x: 12, y: 7, z: z + wco, wco: { x: 0, y: 0, z: wco }, rel: false, t: 0, sent: [] };
    const num = (cmd, a) => { const r = new RegExp(`${a}(-?[\\d.]+)`).exec(cmd); return r ? Number(r[1]) : undefined; };
    return {
        m,
        io: {
            async send(cmd) {
                m.sent.push(cmd);
                if (rejects && rejects.test(cmd)) return ['error:9'];
                const rel = /\bG91\b/.test(cmd);
                if (/G38\.2/.test(cmd)) {
                    const target = m.z + num(cmd, 'Z');
                    if (surface <= m.z && surface >= target) { m.z = surface; return [`[PRB:${m.x},${m.y},${surface}:1]`, 'ok']; }
                    m.z = target;
                    return [`[PRB:${m.x},${m.y},${target}:0]`, 'ALARM:5'];
                }
                if (/^G10 L20 P0 Z0/.test(cmd)) { m.wco.z = m.z; return ['ok']; }
                if (/\bG0\b/.test(cmd)) {
                    for (const a of ['X', 'Y', 'Z']) {
                        const v = num(cmd, a);
                        const k = a.toLowerCase();
                        if (v !== undefined) m[k] = rel ? m[k] + v : v + m.wco[k];
                    }
                }
                return ['ok'];
            },
            probePin: async () => pin(m.t),
            readWorkZ: async () => m.z - m.wco.z,
            aborted: () => false,
            sleep: async (ms) => { m.t += ms; },
            log: () => {},
            status: () => {},
        },
    };
}

test('zeroZ moves to X0 Y0, probes twice, sets Z0 on the copper and retracts', async () => {
    const touch = (t) => t >= 300 && t < 900;    // the user bridges the bit and copper briefly
    const { m, io } = sim({ pin: touch });
    const r = await zeroZ(io, ZERO_DEFAULTS);
    assert.equal(r.machineZ, -40.15);
    assert.equal(m.wco.z, -40.15);                  // work Z0 is the copper
    assert.equal(m.z - m.wco.z, ZERO_DEFAULTS.retract);
    assert.equal(m.x, 0);
    assert.equal(m.y, 0);
    const probes = m.sent.filter((c) => /G38\.2/.test(c));
    assert.deepEqual(probes, ['G91 G38.2 Z-25 F60', 'G91 G38.2 Z-1 F15']);
    assert.ok(m.sent.every((c) => !/G10 L2\b|G10 L20 P\d [^Z]/.test(c)), 'XY zero never touched');
    // Every G91 is followed by G90.
    m.sent.forEach((c, i) => { if (/G91/.test(c)) assert.equal(m.sent[i + 1], 'G90'); });
});

test('zeroZ refuses when the probe is already on or never triggers', async () => {
    let { io } = sim({ pin: () => true });
    await assert.rejects(zeroZ(io), /on before anything touches/);
    ({ io } = sim());
    await assert.rejects(zeroZ(io), /never switched on/);
    const { m, io: io2 } = sim({ z: 30 });          // bit too high: misses within 25 mm
    await assert.rejects(zeroZ(io2, ZERO_DEFAULTS, { touchTest: false }), /without touching/);
    assert.equal(m.wco.z, -40, 'Z0 unchanged after a miss');
});

test('zeroZ stops when the machine refuses a command, and checks Z0 took', async () => {
    const { m, io } = sim({ rejects: /^G0 X0 Y0/ });
    await assert.rejects(zeroZ(io, ZERO_DEFAULTS, { touchTest: false }), /refused G0 X0 Y0/);
    assert.ok(!m.sent.some((c) => /G38/.test(c)));

    const s2 = sim();
    s2.io.readWorkZ = async () => 0.3;              // a stale status never reads 0
    await assert.rejects(zeroZ(s2.io, ZERO_DEFAULTS, { touchTest: false }), /didn't confirm/);
});

test('raiseForBitChange: spindle off, then up to the set height, never down', async () => {
    const { m, io } = sim({ z: 3 });
    assert.deepEqual(await raiseForBitChange(io, { ...ZERO_DEFAULTS, raise: 35 }), { moved: true, z: 35 });
    assert.equal(m.sent[0], 'M5');
    assert.equal(m.z - m.wco.z, 35);
    const sent = m.sent.length;
    assert.deepEqual(await raiseForBitChange(io, { ...ZERO_DEFAULTS, raise: 20 }), { moved: false, z: 35 });
    assert.equal(m.z - m.wco.z, 35);
    assert.ok(!m.sent.slice(sent).some((c) => /G0/.test(c)));
    await assert.rejects(raiseForBitChange({ ...io, readWorkZ: async () => null }), /read Z/);
    assert.deepEqual(validateZeroSettings({ ...ZERO_DEFAULTS, maxTravel: 40 }), ['maxTravel must be between 1 and 25']);
});

test('clampRaise keeps the raise height in range', async () => {
    const { clampRaise } = await import(new URL('../../plugins/project-runner/ui/assets/zeroz.js', import.meta.url));
    assert.equal(clampRaise(25), 25);
    assert.equal(clampRaise('30'), 30);
    assert.equal(clampRaise(80), 50);
    assert.equal(clampRaise(0), 1);
    assert.equal(clampRaise(12.6), 13);
    assert.equal(clampRaise(''), ZERO_DEFAULTS.raise);
    assert.equal(clampRaise('abc'), ZERO_DEFAULTS.raise);
    assert.equal(clampRaise(null), ZERO_DEFAULTS.raise);
});
