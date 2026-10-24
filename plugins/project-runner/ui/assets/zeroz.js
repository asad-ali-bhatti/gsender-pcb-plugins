// Guided bit change: raise the spindle, then zero Z on the copper at X0 Y0.
// Pure module: all machine access goes through `io`, so the sequence runs
// against a simulated controller in tests. Probe parsing comes from the
// Autoleveler (a synced copy), and the safety rules are the same as its scan:
//   * The probe input must be open before anything moves, and a touch test
//     proves the clip is on the new bit before the bit goes down.
//   * The only downward moves are G38.2 probes (they stop on contact) with a
//     capped distance, in G91 within the same block so G91 never stays on.
//   * XY is only ever moved to X0 Y0; the XY origin itself is never changed.

import { parsePRB, fmt } from '../vendor/autoleveler/leveling.js';

export const ZERO_DEFAULTS = {
    raise: 20,        // work Z (mm above the copper) the bit goes up to for a bit change
    maxTravel: 25,    // mm the probe may go down from where the bit starts
    feed: 60,         // first probe, mm/min (Autoleveler's default)
    slowFeed: 15,     // second, slower probe, mm/min
    backoff: 0.5,     // mm up between the two probes
    retract: 5,       // mm above the copper when done (PCB CAM's default safe Z)
};

export const ZERO_LIMITS = {
    raise: [1, 50], maxTravel: [1, 25], feed: [1, 300], slowFeed: [1, 100], backoff: [0.1, 2], retract: [1, 20],
};

/** A raise height the user typed, kept within ZERO_LIMITS.raise (whole mm); the default when it isn't a number. */
export function clampRaise(mm) {
    const [lo, hi] = ZERO_LIMITS.raise;
    const v = Math.round(Number(mm));
    return Number.isFinite(v) && mm !== '' && mm !== null ? Math.min(hi, Math.max(lo, v)) : ZERO_DEFAULTS.raise;
}

export function validateZeroSettings(s) {
    const errs = [];
    for (const [k, [lo, hi]] of Object.entries(ZERO_LIMITS)) {
        if (!Number.isFinite(s[k]) || s[k] < lo || s[k] > hi) errs.push(`${k} must be between ${lo} and ${hi}`);
    }
    return errs;
}

const FAIL_RE = /^(error:|ALARM:)/;

function sender(io) {
    const check = () => { if (io.aborted()) throw new Error('Stopped.'); };
    const send = async (cmd, opts = {}) => {
        check();
        io.log(`> ${cmd}`);
        const lines = await io.send(cmd, opts);
        const bad = lines.find((l) => FAIL_RE.test(String(l).trim()));
        if (bad && !opts.probe) throw new Error(`The machine refused ${cmd} (${bad}).`);
        return lines;
    };
    const rel = async (cmd, opts) => {
        try { return await send(`G91 ${cmd}`, opts); } finally { await io.send('G90', {}).catch(() => {}); }
    };
    return { check, send, rel };
}

/**
 * Makes the spot under the bit X0 Y0 of the active work coordinates (Z is
 * left alone), then waits until the status reports it.
 * @param io also needs readWorkXY(): Promise<{x, y} | null>
 */
export async function setXYOrigin(io) {
    const { send } = sender(io);
    await send('G10 L20 P0 X0 Y0');
    for (let i = 0; i < 30; i++) {
        const p = await io.readWorkXY();
        if (p && Math.abs(p.x) < 0.005 && Math.abs(p.y) < 0.005) return p;
        await io.sleep(100);
    }
    throw new Error('The machine did not confirm X0 Y0. Check gSender, then try again.');
}

/**
 * Spindle off, then up to work Z `s.raise` so the bit can be swapped. It only
 * ever goes up: when Z is already that high or higher, it stays put.
 * @returns {Promise<{ moved: boolean, z: number }>} work Z afterwards
 */
export async function raiseForBitChange(io, s = ZERO_DEFAULTS) {
    const { send } = sender(io);
    await send('M5');
    await send('G21');
    const z = await io.readWorkZ();
    if (z === null) throw new Error('Could not read Z. Is the machine idle?');
    if (z >= s.raise - 0.01) return { moved: false, z };
    await send(`G90 G0 Z${fmt(s.raise)}`);
    return { moved: true, z: s.raise };
}

/**
 * Zeroes Z on the copper at X0 Y0 with the probe clip on the bit and the board
 * copper as the plate (thickness 0).
 * @param io {
 *   send(cmd, { probe, timeout }) -> Promise<string[]>  reply lines
 *   probePin() -> Promise<boolean>                    probe input triggered now
 *   readWorkZ() -> Promise<number|null>               work Z from a fresh Idle status
 *   aborted() -> boolean, sleep(ms), log(text), status(text)
 * }
 * @returns {Promise<{ machineZ: number }>} machine Z of the copper at X0 Y0
 */
export async function zeroZ(io, s = ZERO_DEFAULTS, { touchTest = true } = {}) {
    const errs = validateZeroSettings(s);
    if (errs.length) throw new Error(errs.join('\n'));
    const { check, send, rel } = sender(io);
    const waitPin = async (want, ms, err) => {
        for (let waited = 0; waited < ms; waited += 150) {
            check();
            if ((await io.probePin()) === want) return;
            await io.sleep(150);
        }
        throw new Error(err);
    };
    const probeDown = async (dist, feed, missed) => {
        const timeout = 15000 + (dist / feed) * 60000;
        const lines = await rel(`G38.2 Z-${fmt(dist)} F${fmt(feed, 1)}`, { probe: true, timeout });
        const prb = parsePRB(lines);
        const bad = lines.find((l) => FAIL_RE.test(String(l).trim()));
        if (!prb) throw new Error(bad ? `The probe failed (${bad}). Clear the alarm in gSender (Unlock), check the clip, then try again.` : 'The probe gave no result. Check the probe wiring, then try again.');
        if (!prb.ok) throw new Error(missed);
        return prb;
    };

    // 1. The probe circuit: open now, closed when the bit touches the copper.
    if (await io.probePin()) {
        throw new Error('The probe input is on before anything touches. Make sure the bit isn\'t touching the copper and the clip isn\'t touching the board, then try again.');
    }
    if (touchTest) {
        io.status('Probe test: touch the bit and the board copper together with a screwdriver blade for a second…');
        await waitPin(true, 30000, 'The probe never switched on during the test. Check that the lead is clipped to the board copper and the clip is on the bit, then try again.');
        io.status('The probe works. Let go…');
        await waitPin(false, 30000, 'The probe stayed on. Let go of the screwdriver, then try again.');
        await io.sleep(800);
    }

    // 2. Over X0 Y0 at the current height, then down until the bit touches.
    await send('G21');
    await send('G90');
    io.status('Moving to X0 Y0…');
    await send('G0 X0 Y0');
    io.status('Lowering the bit onto the copper…');
    let prb = await probeDown(s.maxTravel, s.feed,
        `The bit went down ${fmt(s.maxTravel, 0)} mm without touching the copper. Clear the alarm in gSender (Unlock), jog the bit down to about 5 mm above the board, then try again.`);
    await rel(`G0 Z${fmt(s.backoff)}`);
    prb = await probeDown(s.backoff + 0.5, s.slowFeed,
        'The second, slower probe didn\'t touch the copper. Check the clip, then try again.');
    io.log(`< PRB Z${fmt(prb.z)} (machine)`);

    // 3. Z0 here (the bit stands still where it touched), then check that it took.
    await send('G10 L20 P0 Z0');
    let wz = null;
    for (let waited = 0; waited < 5000 && !(wz !== null && Math.abs(wz) < 0.005); waited += 250) {
        check();
        wz = await io.readWorkZ();
        if (wz === null || Math.abs(wz) >= 0.005) await io.sleep(250);
    }
    if (wz === null || Math.abs(wz) >= 0.005) {
        throw new Error('The controller didn\'t confirm the new Z zero. Check gSender\'s position display, then zero Z again.');
    }
    await rel(`G0 Z${fmt(s.retract)}`);
    return { machineZ: prb.z };
}
