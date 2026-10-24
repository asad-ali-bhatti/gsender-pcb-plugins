import { test } from 'node:test';
import assert from 'node:assert/strict';
const R = (p) => import(new URL(`../../plugins/project-runner/ui/assets/${p}`, import.meta.url));
const L = await R('level.js');
const S = await R('runstate.js');
const { planSteps } = await R('plan.js');
const { inspectJobs } = await R('jobs.js');
const { heightAt } = await import(new URL('../../plugins/project-runner/ui/vendor/autoleveler/leveling.js', import.meta.url));
const { demoDoc, withHashes } = await import(new URL('../fixtures/demo-project.mjs', import.meta.url));

const jobsOf = async () => inspectJobs(await withHashes(demoDoc()));

/**
 * A small Grbl over a tilted board: the copper is at machine Z surface(x, y).
 * Work = machine - wco. Records any move that would put the tip under the copper.
 */
function sim(surface, { wco = { x: -100, y: -80, z: surface(0, 0) }, z = 5 } = {}) {
    const m = { x: wco.x, y: wco.y, z: wco.z + z, wco: { ...wco }, sent: [], crashes: [] };
    const num = (cmd, a) => { const r = new RegExp(`${a}(-?[\\d.]+)`).exec(cmd); return r ? Number(r[1]) : undefined; };
    const io = {
        async send(cmd) {
            m.sent.push(cmd);
            const rel = /\bG91\b/.test(cmd);
            if (/G38\.2/.test(cmd)) {
                const target = m.z + num(cmd, 'Z');
                const s = surface(m.x - m.wco.x, m.y - m.wco.y);
                if (s <= m.z && s >= target) { m.z = s; return [`[PRB:${m.x},${m.y},${s}:1]`, 'ok']; }
                m.z = target;
                return [`[PRB:${m.x},${m.y},${target}:0]`, 'ALARM:5'];
            }
            if (/\bG0\b/.test(cmd)) {
                for (const a of ['X', 'Y', 'Z']) {
                    const v = num(cmd, a);
                    const k = a.toLowerCase();
                    if (v === undefined) continue;
                    m[k] = /\bG53\b/.test(cmd) ? v : rel ? m[k] + v : v + m.wco[k];
                }
                if (m.z < surface(m.x - m.wco.x, m.y - m.wco.y) - 1e-9) m.crashes.push(cmd);
            }
            return ['ok'];
        },
        probePin: async () => false,
        readWcoZ: async () => m.wco.z,
        readWorkZ: async () => m.z - m.wco.z,
        aborted: () => false,
        sleep: async () => {},
        log: () => {},
        status: () => {},
        onPoint: () => {},
    };
    return { m, io };
}

test('probeArea covers the levelled jobs, reaches X0 Y0 and never goes past the board corner', async () => {
    const jobs = await jobsOf();
    const iso = jobs.find((j) => j.id === 'iso');
    const b = iso.files[0].bounds;
    const area = L.probeArea(jobs, ['iso', 'drill', 'cutout']);
    assert.deepEqual(area, { xmin: 0, ymin: 0, xmax: Math.round((b.xmax + 1) * 1000) / 1000, ymax: Math.round((b.ymax + 1) * 1000) / 1000 });
    // Drilling and cutout aren't levelled, so they don't set the area.
    assert.equal(L.probeArea(jobs, ['drill', 'cutout']), null);
    assert.ok(L.needsLevel(iso) && !L.needsLevel(jobs.find((j) => j.id === 'cutout')));

    // Cuts below X0 Y0 (copper to the edge) are covered, but not past them.
    const fake = [{ id: 'a', status: 'ready', files: [{ opTypes: ['isolation'], bounds: { xmin: -0.2, ymin: 3, xmax: 0.5, ymax: 3.4 } }] }];
    assert.deepEqual(L.probeArea(fake, ['a']), { xmin: -0.2, ymin: 0, xmax: 1.8, ymax: 4.4 });
});

test('autoGrid: about 10 mm apart, 3 to 12 points per axis', () => {
    assert.deepEqual(L.autoGrid({ xmin: 0, xmax: 31, ymin: 0, ymax: 21 }), { xmin: 0, xmax: 31, ymin: 0, ymax: 21, nx: 5, ny: 4 });
    assert.equal(L.autoGrid({ xmin: 0, xmax: 4, ymin: 0, ymax: 4 }).nx, 3);
    assert.equal(L.autoGrid({ xmin: 0, xmax: 300, ymin: 0, ymax: 20 }).nx, 12);
    assert.ok(L.probeMinutes({ nx: 5, ny: 4 }) > 2 && L.probeMinutes({ nx: 5, ny: 4 }) < 4);
});

test('planSteps: one probe step, after the bit change of the first levelled job', async () => {
    const jobs = await jobsOf();
    const steps = planSteps(jobs, ['drill', 'iso', 'cutout']);
    assert.deepEqual(steps.map((s) => s.id), ['bit@drill#1', 'drill#1', 'bit@iso#1', 'probe', 'iso#1', 'bit@cutout#1', 'cutout#1']);
    assert.deepEqual(steps.filter((s) => s.kind === 'run').map((s) => s.level), [false, true, false]);
    assert.ok(!planSteps(jobs, ['drill', 'cutout']).some((s) => s.kind === 'probe'));
});

test('probeMap measures the board and the levelled job follows the copper from X0 Y0', async () => {
    const tilt = (x, y) => -40 + 0.004 * x - 0.003 * y;
    const jobs = await jobsOf();
    const step = planSteps(jobs, ['iso']).find((s) => s.kind === 'probe');
    const { m, io } = sim(tilt);
    let started = null;
    const map = await L.probeMap({ ...io, onMap: (x) => { started = x; } }, step.grid, null, { touchTest: false });
    assert.equal(started, map);
    assert.deepEqual(m.crashes, []);
    assert.ok(!m.sent.some((c) => /G10/.test(c)), 'Z0 from Zero Z is kept');
    assert.ok(Math.abs(L.mapRange(map) - (0.004 * step.grid.xmax + 0.003 * step.grid.ymax)) < 1e-6);

    const iso = jobs.find((j) => j.id === 'iso').files[0];
    const r = L.levelFile(iso.gcode, map);
    assert.ok(r.ok);
    assert.equal(r.beyond, 0);
    assert.match(r.gcode, /^\(Autoleveled by/);
    // Every levelled cut sits as deep under the copper there as the plain cut does under X0 Y0's.
    const depth = Math.min(...iso.gcode.split('\n').map((l) => /^G1\b.*Z(-?[\d.]+)/.exec(l)?.[1]).filter(Boolean).map(Number));
    assert.ok(depth < 0);
    let checked = 0;
    for (const line of r.gcode.split('\n')) {
        const w = /^G1 X(\S+) Y(\S+) Z(\S+)/.exec(line);
        if (!w) continue;
        const [x, y, z] = w.slice(1).map(Number);
        if (z > depth + 0.2) continue; // plunges and lifts
        assert.ok(Math.abs(z - (depth + tilt(x, y) - tilt(0, 0))) < 2e-4, line);
        checked++;
    }
    assert.ok(checked > 10);
    // Never twice.
    assert.equal(L.levelFile(r.gcode, map).ok, false);
});

test('probeMap continues a stopped map, and refuses a job outside it', async () => {
    const flat = () => -40;
    const grid = { xmin: 0, xmax: 20, ymin: 0, ymax: 10, nx: 3, ny: 3 };
    const { io } = sim(flat);
    let n = 0;
    let map = null;
    await assert.rejects(L.probeMap({ ...io, onMap: (x) => { map = x; }, aborted: () => n >= 4, onPoint: () => { n++; } }, grid, null, { touchTest: false }), /stopped/i);
    assert.ok(L.canResume(map, grid));
    const sent = [];
    const done = await L.probeMap({ ...io, send: (c) => { sent.push(c); return io.send(c); } }, grid, map, { touchTest: false });
    assert.equal(done, map);
    assert.equal(L.mapRange(done), 0);

    const far = 'G21\nG90\nG0 Z5\nG0 X40 Y5\nG1 Z-0.05 F100\nG1 X45 Y5 F300\nG0 Z5\n';
    const r = L.levelFile(far, done);
    assert.equal(r.ok, false);
    assert.match(r.message, /past the height map/);
});

test('originMoved: X0 Y0 must stay where it was when probed', () => {
    const map = { origin: { x: -100, y: -80 } };
    assert.ok(!L.originMoved(map, { x: -100.01, y: -80 }));
    assert.ok(L.originMoved(map, { x: -101, y: -80 }));
    assert.ok(!L.originMoved(map, null));
    assert.ok(!L.originMoved({}, { x: 1, y: 1 }));
    assert.equal(L.leveledName('iso.nc'), 'iso_leveled.nc');
});

test('run state: probe, level, probe again; Restart keeps the map', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso', 'drill'], now: 1 });
    assert.equal(run.map, null);
    S.finishOriginStep(run, 'origin');
    S.finishBitStep(run, 'bit@iso#1', null);
    const probe = S.currentStep(run);
    assert.equal(probe.kind, 'probe');
    const iso = S.stepOf(run, 'iso#1');
    assert.ok(!S.levelsWith(run, iso));

    const map = await L.probeMap(sim(() => -40).io, probe.grid, null, { touchTest: false });
    assert.equal(S.finishProbe(run, 'probe', { x: -100, y: -80 }), null); // map not in the run yet
    S.startProbe(run, 'probe', map);
    S.finishProbe(run, 'probe', { x: -100, y: -80 }, 2);
    assert.equal(run.history.at(-1).job, 'Height map');
    assert.ok(S.levelsWith(run, iso));
    assert.ok(!S.levelsWith(run, S.stepOf(run, 'drill#1')));
    assert.deepEqual(run.map.origin, { x: -100, y: -80 });

    const back = S.parseRun(S.serializeRun(run));
    assert.ok(back.ok);
    assert.deepEqual(back.run.map, run.map);

    // Restart keeps the map, and setup stays open until something runs.
    S.restartRun(run, jobs, 3);
    assert.equal(S.probeStepOf(run).status, 'done');
    assert.ok(S.probeStepOf(run).kept);
    assert.ok(!S.runStarted(run));
    assert.ok(S.levelsWith(run, S.stepOf(run, 'iso#1')));

    // Probe again: the map is dropped and probing comes up next.
    S.finishOriginStep(run, 'origin');
    S.finishBitStep(run, 'bit@iso#1', null);
    S.reprobe(run);
    assert.equal(run.map, null);
    assert.equal(S.currentStep(run).id, 'probe');
    // Skipped: the job runs as generated.
    S.skipStep(run, 'probe');
    assert.ok(!S.levelsWith(run, S.stepOf(run, 'iso#1')));
    S.restartRun(run, jobs);
    assert.equal(S.probeStepOf(run).status, 'pending');
});

test('run files from before levelling open and run without it', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso'], now: 1 });
    run.version = 4;
    delete run.map;
    run.steps = run.steps.filter((s) => s.kind !== 'probe');
    for (const s of run.steps) delete s.level;
    const r = S.parseRun(S.serializeRun(run));
    assert.ok(r.ok);
    assert.equal(r.run.version, S.RUN_VERSION);
    assert.equal(r.run.map, null);
    assert.ok(!S.levelsWith(r.run, S.stepOf(r.run, 'iso#1')));
});
