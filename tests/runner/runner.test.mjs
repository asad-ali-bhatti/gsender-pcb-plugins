import { test } from 'node:test';
import assert from 'node:assert/strict';
const R = (p) => import(new URL(`../../plugins/project-runner/ui/assets/${p}`, import.meta.url));
const { parseProjectFile, inspectJobs, lineCount } = await R('jobs.js');
const { defaultSelection, moveJob, selectionWarnings, planSteps, bitLabel } = await R('plan.js');
const S = await R('runstate.js');
const { createTracker, track } = await R('tracker.js');
const { demoDoc, withHashes } = await import(new URL('../fixtures/demo-project.mjs', import.meta.url));

const text = (doc) => JSON.stringify(doc);
const reviewed = async () => withHashes(demoDoc());

test('parseProjectFile accepts a project file and explains what is wrong otherwise', async () => {
    assert.ok(parseProjectFile(text(await reviewed())).ok);
    assert.match(parseProjectFile('{').message, /valid JSON/);
    assert.match(parseProjectFile('{"tools":[]}').message, /PCB CAM project file/);
    const noJobs = { ...demoDoc(), jobs: [] };
    assert.match(parseProjectFile(text(noJobs)).message, /no CNC jobs/);
});

test('inspectJobs: ready only when the G-code hashes as reviewed', async () => {
    const doc = await reviewed();
    doc.jobs[1].gcodeHash = 'f'.repeat(64);         // drill: edited since
    delete doc.jobs[2].gcodeHash;                    // cutout: never checked
    const jobs = await inspectJobs(doc);
    assert.deepEqual(jobs.map((j) => j.status), ['ready', 'out-of-date', 'not-reviewed']);
    const iso = jobs[0];
    assert.equal(iso.files.length, 1);
    assert.equal(iso.files[0].bits[0].name, 'V-bit 30° 0.2 mm');
    assert.equal(iso.files[0].lines, lineCount(iso.files[0].gcode));
    assert.match(iso.files[0].hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(iso.opTypes, ['isolation']);
    assert.match(jobs[1].message, /Regenerate/);

    doc.jobs[1].coreVersion = 999;
    assert.match((await inspectJobs(doc))[1].message, /different version/);
});

test('inspectJobs: missing board files and multi-bit files cannot run', async () => {
    const doc = await reviewed();
    delete doc.boardFiles['demo.drl'];
    doc.jobs.push({ id: 'all', name: 'all_cnc', ops: ['iso-top', 'drill-x'] });
    const jobs = await inspectJobs(doc);
    assert.equal(jobs[1].status, 'error');
    assert.match(jobs[1].message, /demo\.drl/);

    const doc2 = await reviewed();
    doc2.jobs.push({ id: 'two', name: 'two_cnc', ops: ['iso-top', 'cutout'], gcodeHash: 'x' });
    const two = (await inspectJobs(doc2)).at(-1);
    assert.equal(two.status, 'multi-bit');
    assert.match(two.message, /2 bits/);
});

test('inspectJobs: split output gives one file per bit', async () => {
    const doc = await withHashes({ ...demoDoc({ output: { toolChange: 'split' } }) });
    doc.jobs = [{ id: 'two', name: 'two_cnc', ops: ['iso-top', 'cutout'] }];
    await withHashes(doc);
    const [two] = await inspectJobs(doc);
    assert.equal(two.status, 'ready');
    assert.equal(two.files.length, 2);
    const steps = planSteps([two], ['two']);
    assert.deepEqual(steps.map((s) => s.id), ['bit@two#1', 'two#1', 'bit@two#2', 'two#2']);
});

test('inspectJobs: kept G-code runs as stored unless it was out of date when kept', async () => {
    const doc = await reviewed();
    const C = await import(new URL('../../plugins/pcb-cam/ui/core/index.js', import.meta.url));
    const kept = C.generateJob(doc, 'iso');
    doc.jobs.push({ id: 'old', name: 'old_cnc', ops: [], frozen: { deleted: ['x'] }, result: { ok: true, issues: [], files: kept.files, stats: kept.stats } });
    doc.jobs.push({ id: 'stale', name: 'stale_cnc', ops: [], frozen: { deleted: ['x'], stale: true }, result: { ok: true, issues: [], files: kept.files, stats: kept.stats } });
    const jobs = await inspectJobs(doc);
    assert.equal(jobs.at(-2).status, 'ready');
    assert.equal(jobs.at(-2).files[0].gcode, kept.files[0].gcode);
    assert.equal(jobs.at(-1).status, 'out-of-date');
});

test('selection: defaults, ordering and warnings', async () => {
    const doc = await reviewed();
    doc.jobs.push({ ...doc.jobs[0], id: 'iso2', name: 'iso-top_cnc_1' });
    await withHashes(doc);
    const jobs = await inspectJobs(doc);
    const ids = defaultSelection(jobs);
    assert.deepEqual(ids, ['iso', 'drill', 'cutout', 'iso2']);
    const w = selectionWarnings(jobs, ids);
    assert.ok(w.some((x) => x.code === 'cutout-not-last' && x.at === 'cutout'));
    assert.ok(!w.some((x) => x.code === 'same-geometry'));
    for (const x of w) assert.deepEqual(Object.keys(x).sort(), ['at', 'code', 'message', 'severity']);
    assert.deepEqual(selectionWarnings(jobs, ['iso', 'drill', 'cutout']), []);
    assert.equal(selectionWarnings(jobs, [])[0].severity, 'error');

    assert.deepEqual(moveJob(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
    assert.deepEqual(moveJob(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
    assert.deepEqual(moveJob(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
});

test('planSteps adds a bit change where the bit changes and skips jobs that are not ready', async () => {
    const doc = await reviewed();
    doc.jobs.push({ ...doc.jobs[0], id: 'iso2', name: 'iso-top_cnc_1' });
    await withHashes(doc);
    delete doc.jobs[1].gcodeHash;
    const jobs = await inspectJobs(doc);
    const steps = planSteps(jobs, ['iso', 'iso2', 'drill', 'cutout']);
    assert.deepEqual(steps.map((s) => s.id), ['bit@iso#1', 'iso#1', 'iso2#1', 'bit@cutout#1', 'cutout#1']);
    assert.deepEqual(steps.map((s) => s.kind), ['bit', 'run', 'run', 'bit', 'run']);
    assert.equal(bitLabel(steps[0].bit), 'V-bit 30° 0.2 mm (T1)');
    assert.equal(steps[3].bit.id, steps[4].bit.id);
    assert.ok(steps[0].auto && steps[0].stage === 'change');
});

test('run state: lifecycle, history and round trip', async () => {
    const doc = await reviewed();
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, fileName: 'Demo.pcbcam.json', jobs, ids: ['iso', 'drill', 'cutout'], now: 1 });
    S.finishOriginStep(run, 'origin');
    assert.equal(S.currentStep(run).id, 'bit@iso#1');
    assert.equal(S.startStep(run, 'bit@iso#1'), null);   // a bit change isn't a job
    S.finishBitStep(run, 'bit@iso#1', { machineZ: -40.15 }, 1);
    assert.equal(run.history.at(-1).job, 'Bit change');
    assert.equal(S.currentStep(run).id, 'iso#1');
    S.startStep(run, 'iso#1', 2);
    assert.equal(S.currentStep(run).status, 'active');
    assert.ok(S.progressStep(run, 'iso#1', 10));
    assert.ok(!S.progressStep(run, 'iso#1', 5));
    S.endStep(run, 'iso#1', { result: 'cancelled', line: 40, note: 'Stopped' }, 3);
    assert.equal(S.currentStep(run).id, 'iso#1');
    assert.equal(run.history.at(-1).result, 'cancelled');
    assert.equal(run.history.at(-1).line, 40);
    S.retryStep(run, 'iso#1', 4);
    S.startStep(run, 'iso#1', 5);
    assert.equal(S.stepOf(run, 'iso#1').attempts, 2);
    S.endStep(run, 'iso#1', { result: 'done' }, 6);
    assert.equal(S.stepOf(run, 'iso#1').line, S.stepOf(run, 'iso#1').lines);
    S.skipStep(run, 'bit@drill#1', 7);
    S.skipStep(run, 'drill#1', 7);
    S.skipStep(run, 'bit@cutout#1', 7);
    assert.equal(S.currentStep(run).id, 'cutout#1');
    S.markDone(run, 'cutout#1', 8);
    assert.ok(S.isComplete(run));
    assert.equal(S.currentStep(run), null);
    assert.deepEqual(S.summary(run), { total: 7, pending: 0, active: 0, done: 4, skipped: 3, failed: 0, cancelled: 0, complete: true });

    const back = S.parseRun(S.serializeRun(run));
    assert.ok(back.ok);
    assert.deepEqual(back.run, run);
    assert.deepEqual(S.changedSteps(back.run, jobs), []);
});

test('run state: history is bounded and damaged files are refused', async () => {
    const doc = await reviewed();
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso'] });
    S.finishOriginStep(run, 'origin');
    for (let i = 0; i < S.HISTORY_LIMIT + 20; i++) {
        S.startStep(run, 'iso#1', i);
        S.endStep(run, 'iso#1', { result: 'failed', line: i }, i);
    }
    assert.equal(run.history.length, S.HISTORY_LIMIT);
    assert.equal(run.history.at(-1).line, Math.min(S.HISTORY_LIMIT + 19, S.stepOf(run, 'iso#1').lines));

    assert.match(S.parseRun('nope').message, /valid JSON/);
    assert.match(S.parseRun('{"format":"x"}').message, /run file/);
    assert.match(S.parseRun(JSON.stringify({ ...run, version: 99 })).message, /newer/);
    assert.match(S.parseRun(JSON.stringify({ ...run, steps: [{ id: 'a', status: 'weird' }] })).message, /damaged/);
});

test('run state: steps whose G-code changed are found', async () => {
    const doc = await reviewed();
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso', 'drill'] });
    S.finishOriginStep(run, 'origin');
    jobs[1].files[0].hash = 'changed';
    assert.deepEqual(S.changedSteps(run, jobs), ['drill#1']);
    S.skipStep(run, 'drill#1');
    assert.deepEqual(S.changedSteps(run, jobs), []);   // bit changes have no G-code
    assert.equal(S.runFileName('Board.pcbcam.json'), 'Board.pcbrun.json');
    assert.equal(S.runFileName(null, 'My board'), 'My-board.pcbrun.json');
});

test('run state: bit changes can be added, removed and decide when to confirm by hand', async () => {
    const doc = await reviewed();
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso', 'drill'] });
    S.finishOriginStep(run, 'origin');
    assert.ok(S.needsBitConfirm(run, 'iso#1'));               // its bit change isn't done
    assert.equal(S.setBitStage(run, 'bit@iso#1', 'zero').stage, 'zero');
    S.finishBitStep(run, 'bit@iso#1', { machineZ: -40 });
    assert.ok(!S.needsBitConfirm(run, 'iso#1'));
    assert.equal(S.insertBitChange(run, 'drill#1'), null);   // one is already waiting there
    assert.ok(!S.removeBitChange(run, 'bit@drill#1'));         // planned ones stay

    // A failed job (alarm, reset) needs a new zero or a confirmation.
    S.startStep(run, 'iso#1');
    S.endStep(run, 'iso#1', { result: 'failed', line: 3 });
    S.retryStep(run, 'iso#1');
    assert.ok(S.needsBitConfirm(run, 'iso#1'));
    const added = S.insertBitChange(run, 'iso#1');
    assert.equal(added.id, 'bit+1');
    assert.equal(added.bit.id, S.stepOf(run, 'iso#1').bit.id);
    assert.equal(S.currentStep(run).id, 'bit+1');
    assert.ok(S.removeBitChange(run, 'bit+1'));
    assert.equal(S.insertBitChange(run, 'iso#1').id, 'bit+1');
    S.finishBitStep(run, 'bit+1', { machineZ: -40.1 });
    assert.ok(!S.needsBitConfirm(run, 'iso#1'));
    assert.equal(S.bitStepFor(run, 'iso#1').id, 'bit+1');

    // Skipping the guided change leaves the hand confirmation in place.
    S.skipStep(run, 'bit@drill#1');
    assert.ok(S.needsBitConfirm(run, 'drill#1'));
    assert.equal(S.parseRun(S.serializeRun(run)).run.steps.length, run.steps.length);
});

test('run state: version 1 run files get bit-change steps', async () => {
    const doc = await reviewed();
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso', 'drill'] });
    const v1 = { ...run, version: 1, steps: run.steps.filter((s) => s.kind === 'run').map((s) => ({ ...s, bitChange: true })) };
    v1.steps[0].status = 'done';
    const r = S.parseRun(JSON.stringify(v1));
    assert.ok(r.ok);
    assert.equal(r.run.version, S.RUN_VERSION);
    assert.deepEqual(r.run.steps.map((s) => `${s.id}:${s.status}`), ['bit@iso#1:done', 'iso#1:done', 'bit@drill#1:pending', 'drill#1:pending']);
    assert.ok(r.run.steps.every((s) => !('bitChange' in s)));
});

const sender = (name, received, total, finishTime = 0) => ({ type: 'sender', status: { name, received, total, finishTime } });

test('tracker: a job that runs to the end is done', () => {
    const t = createTracker('a.nc', { total: 100 });
    assert.equal(track(t, sender('a.nc', 0, 100)), null);           // not started yet
    assert.deepEqual(track(t, { type: 'workflow', state: 'running' }), { kind: 'started' });
    assert.deepEqual(track(t, sender('a.nc', 30, 100)), { kind: 'progress', line: 30 });
    assert.equal(track(t, sender('other.nc', 90, 100)), null);
    assert.deepEqual(track(t, { type: 'workflow', state: 'paused' }), { kind: 'paused' });
    assert.deepEqual(track(t, { type: 'workflow', state: 'running' }), { kind: 'resumed' });
    track(t, sender('a.nc', 100, 100, 123));
    track(t, { type: 'controller', activeState: 'Run' });
    track(t, { type: 'controller', activeState: 'Idle' });
    assert.deepEqual(track(t, { type: 'workflow', state: 'idle' }), { kind: 'end', result: 'done', line: 100, note: null });
    assert.equal(track(t, { type: 'workflow', state: 'running' }), null); // ended
});

test('tracker: Stop, alarm, lost connection and controller restart', () => {
    let t = createTracker('a.nc');
    track(t, { type: 'workflow', state: 'running' });
    track(t, sender('a.nc', 100, 100, 5));
    track(t, { type: 'controller', activeState: 'Run' });  // all lines queued, still moving
    track(t, sender('a.nc', 0, 100));                       // rewind after stop
    assert.equal(track(t, { type: 'workflow', state: 'idle' }).result, 'cancelled');

    t = createTracker('a.nc');
    track(t, { type: 'workflow', state: 'running' });
    track(t, sender('a.nc', 40, 100));
    const alarm = track(t, { type: 'controller', activeState: 'Alarm' });
    assert.equal(alarm.result, 'failed');
    assert.equal(alarm.line, 40);

    t = createTracker('a.nc');
    assert.equal(track(t, { type: 'close' }), null);       // not running: nothing to fail
    track(t, { type: 'workflow', state: 'running' });
    assert.match(track(t, { type: 'close' }).note, /connection/);

    t = createTracker('a.nc');
    track(t, { type: 'workflow', state: 'running' });
    track(t, { type: 'workflow', state: 'paused' });
    assert.match(track(t, { type: 'startup' }).note, /restarted/);
});
