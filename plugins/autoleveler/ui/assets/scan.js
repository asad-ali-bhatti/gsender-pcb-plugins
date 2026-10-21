// Probe-scan sequence. No gSender / DOM dependencies: all machine access goes
// through `io`, so the whole sequence can be run against a simulated
// controller in tests.
//
// Safety rules this module follows:
//   * Never trust the current work Z0 for motion. The bit may have been
//     changed or Z re-zeroed since the last scan, so the first point is found
//     by probing down from wherever the bit is, with a bounded distance.
//   * Every move that goes down is either a G38.2 probe (stops on contact) or
//     a short relative move. Travel heights are machine coordinates (G53)
//     taken from the probe's own [PRB:] report, never from a cached offset.
//   * Probe distances are capped (see LIMITS), whatever the settings say.

import { parsePRB, fmt } from './leveling.js';

export const LIMITS = {
    clearance: [0.5, 10],   // mm above the first surface for travel
    maxBelow: [0.1, 3],     // mm below the first surface a later probe may reach
    firstTravel: [1, 25],   // mm the first probe may travel down from the start height
    feed: [1, 300],
    slowFeed: [0, 100],
    backoff: [0.1, 2],
};

export function validateScanSettings(s) {
    const errs = [];
    const names = {
        clearance: 'Travel height', maxBelow: 'Max depth below first point', firstTravel: 'First probe max travel',
        feed: 'Probe feed', slowFeed: 'Slow re-probe feed', backoff: 'Re-probe back-off',
    };
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
        const v = s[k];
        if (!Number.isFinite(v) || v < lo || v > hi) errs.push(`${names[k]} must be between ${lo} and ${hi}`);
    }
    return errs;
}

const FAIL_RE = /^(error:|ALARM:)/;

/** Work-coordinate Z offset (machine Z of work Z0) from `$G` + `$#` replies. */
export function parseWcoZ(gLines, hashLines) {
    const gc = (gLines || []).join(' ').match(/\bG5[4-9](?:\.[1-3])?\b/);
    const wcs = gc ? gc[0] : 'G54';
    const get = (name) => {
        const line = (hashLines || []).map(String).find((l) => l.trim().startsWith(`[${name}:`));
        if (!line) return null;
        return line.trim().slice(name.length + 2).split(/[,:\]]/).map(Number);
    };
    const w = get(wcs);
    if (!w || !Number.isFinite(w[2])) return null;
    const g92 = get('G92');
    const tlo = get('TLO');
    return w[2] + (g92 && Number.isFinite(g92[2]) ? g92[2] : 0) + (tlo && Number.isFinite(tlo[0]) ? tlo[0] : 0);
}

/**
 * @param io {
 *   send(cmd, {probe, timeout}) -> Promise<string[]>   reply lines (until ok / PRB / error)
 *   probePin() -> Promise<boolean>                     probe input currently triggered
 *   aborted() -> boolean
 *   log(text), status(text)
 *   onPoint(p, zWork)                                   a point was measured
 *   sleep(ms)
 *   readWcoZ?({ atCurrent }) -> Promise<number>         optional: work Z offset from the
 *       controller's status reports (no $ commands); `atCurrent` means work Z0 was
 *       just set at the current position. Without it, $G + $# are queried.
 * }
 * @param s     scan settings (validated with validateScanSettings)
 * @param map   height map; points with a finite z are skipped (resume)
 * @param pts   points in probing order (from gridPoints)
 * @param opts  { resume: boolean, touchTest: boolean }
 */
export async function runScan(io, s, map, pts, { resume = false, touchTest = true } = {}) {
    const errs = validateScanSettings(s);
    if (errs.length) throw new Error(errs.join('\n'));

    const check = () => { if (io.aborted()) throw new Error('Scan stopped by user.'); };
    const send = async (cmd, opts = {}) => {
        check();
        io.log(`> ${cmd}`);
        const lines = await io.send(cmd, opts);
        const bad = lines.find((l) => FAIL_RE.test(String(l).trim()));
        if (bad && !opts.probe) throw new Error(`${cmd} → ${bad}`);
        return lines;
    };
    // Relative move/probe in one block, so G91 can never stay active.
    const rel = async (cmd, opts) => {
        try { return await send(`G91 ${cmd}`, opts); } finally { await io.send('G90', {}).catch(() => {}); }
    };
    const probeDown = async (dist, feed) => {
        const timeout = 15000 + (dist / feed) * 60000;
        const lines = await rel(`G38.2 Z-${fmt(dist)} F${fmt(feed, 1)}`, { probe: true, timeout });
        const prb = parsePRB(lines);
        const bad = lines.find((l) => FAIL_RE.test(String(l).trim()));
        if (!prb) throw new Error(bad ? `Probe failed: ${bad}` : 'Probe gave no result. Check the probe wiring.');
        if (!prb.ok) throw new Error(`Probe travelled ${fmt(dist, 2)} mm down without touching. Nothing was cut; check the clip/wiring, or start with the bit closer to the board.`);
        return prb;
    };
    const touch = async (dist) => {
        let prb = await probeDown(dist, s.feed);
        if (s.slowFeed > 0) {
            await rel(`G0 Z${fmt(s.backoff)}`);
            prb = await probeDown(s.backoff + 0.5, s.slowFeed);
        }
        io.log(`< PRB Z${fmt(prb.z)} (machine)`);
        return prb;
    };
    const readWcoZ = async (atCurrent = false) => {
        if (io.readWcoZ) return io.readWcoZ({ atCurrent });
        const g = await send('$G');
        const hash = await send('$#');
        const w = parseWcoZ(g, hash);
        if (!Number.isFinite(w)) throw new Error('Could not read the work offset from the controller ($#).');
        return w;
    };
    const waitPin = async (want, ms, err) => {
        for (let waited = 0; waited < ms; waited += 150) {
            check();
            if ((await io.probePin()) === want) return;
            await io.sleep(150);
        }
        throw new Error(err);
    };

    // 1. Probe input sanity: must be open now, and must close when touched.
    if (await io.probePin()) throw new Error('Probe input is already triggered before touching anything. Check the clip and wiring (or the $6 probe-invert setting).');
    if (touchTest) {
        io.status('Probe test: touch the probe lead to the bit and hold for a second…');
        await waitPin(true, 30000, 'The probe input never triggered during the touch test. Check the clip and wiring.');
        io.status('Probe works. Let go and leave the clip attached for the scan…');
        await waitPin(false, 30000, 'The probe input stayed triggered. Let go of the clip before scanning.');
        await io.sleep(1000);
    }

    await send('G21');
    await send('G90');

    const remaining = pts.filter((p) => !Number.isFinite(map.z[p.idx]));
    if (!remaining.length) return;

    // 2. Find the surface without trusting Z0: lift a little, move over the
    //    anchor point, probe down a bounded distance. On a new scan the anchor
    //    is the first point; on resume it is the already-measured point 0, which
    //    must still read the same height or the work zero has changed.
    const anchor = resume ? pts.find((p) => p.idx === 0 && Number.isFinite(map.z[0])) : remaining[0];
    if (!anchor) throw new Error('Nothing to resume from: the first point was never measured. Start a new scan.');
    io.status(`Finding the surface at X${fmt(anchor.x, 2)} Y${fmt(anchor.y, 2)}…`);
    await rel(`G0 Z${fmt(s.clearance)}`);
    await send(`G0 X${fmt(anchor.x)} Y${fmt(anchor.y)}`);
    const first = await touch(s.firstTravel + s.clearance);
    const travelMZ = first.z + s.clearance;   // machine Z for all travel
    const floorDist = s.clearance + s.maxBelow; // probe distance from travel height

    let wcoZ;
    if (resume) {
        wcoZ = await readWcoZ();
        const zw = first.z - wcoZ;
        if (Math.abs(zw - map.z[0]) > 0.02) {
            await send(`G53 G0 Z${fmt(travelMZ)}`);
            throw new Error(`The first point now reads Z${fmt(zw, 3)} but was Z${fmt(map.z[0], 3)} when scanned: work zero or the bit changed. Start a new scan.`);
        }
    } else {
        if (s.zeroFirst) {
            await send('G10 L20 P0 Z0');
            io.log('Work Z zeroed at the first point');
        }
        wcoZ = await readWcoZ(!!s.zeroFirst);
        map.wcoZ = wcoZ;
        const zw = s.zeroFirst ? 0 : first.z - wcoZ;
        map.z[anchor.idx] = zw;
        io.onPoint(anchor, zw);
    }
    await send(`G53 G0 Z${fmt(travelMZ)}`);

    // 3. Remaining points: travel at a fixed machine height above the first
    //    surface, probe down at most `maxBelow` below it.
    for (const p of remaining) {
        if (Number.isFinite(map.z[p.idx])) continue;
        check();
        io.status(`Probing X${fmt(p.x, 2)} Y${fmt(p.y, 2)}…`);
        await send(`G0 X${fmt(p.x)} Y${fmt(p.y)}`);
        const prb = await touch(floorDist);
        const zw = prb.z - wcoZ;
        map.z[p.idx] = zw;
        io.onPoint(p, zw);
        await send(`G53 G0 Z${fmt(travelMZ)}`);
    }
}
