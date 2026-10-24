import { test } from 'node:test';
import assert from 'node:assert/strict';
const R = (p) => import(new URL(`../../plugins/project-runner/ui/assets/${p}`, import.meta.url));
const { checkGcode, commandProblem, makeCommand, runGcode } = await R('commands.js');
const { planSteps, planWarnings, reorderJob, toggleJob } = await R('plan.js');
const { inspectJobs } = await R('jobs.js');
const S = await R('runstate.js');
const { demoDoc, withHashes } = await import(new URL('../fixtures/demo-project.mjs', import.meta.url));

test('checkGcode allows small commands and refuses ones that upset the run', () => {
    const ok = checkGcode('M8 ; coolant\n(dust shoe)\nG53 G0 Z-1\n');
    assert.ok(ok.ok);
    assert.deepEqual(ok.lines, ['M8', 'G53 G0 Z-1']);
    assert.equal(ok.moves, true);
    assert.equal(ok.spindle, false);
    assert.equal(checkGcode('M3 S10000').spindle, true);
    assert.equal(checkGcode('M30').ok, false);
    assert.equal(checkGcode('M3').ok, true);       // not M30
    assert.equal(checkGcode('G1X10F100').moves, true);
    assert.equal(checkGcode('G10 L20 P1 Z0').ok, false);
    assert.equal(checkGcode('G101').ok, true);     // not G10
    assert.equal(checkGcode('M06 T2').ok, false);
    assert.equal(checkGcode('G38.2 Z-5 F50').ok, false);
    assert.equal(checkGcode('G91 G0 Z5').ok, false);
    assert.equal(checkGcode('$22=1').ok, false);
    assert.equal(checkGcode('$H').ok, true);
    assert.equal(checkGcode('$H').moves, true);
    assert.equal(checkGcode('!').ok, false);
    assert.match(checkGcode('  ; only a comment').message, /at least one/);
    assert.match(checkGcode(Array(21).fill('M8').join('\n')).message, /20 lines/);
});

test('commandProblem explains what is missing', () => {
    assert.equal(commandProblem(makeCommand('bit', 'ignored', 'c1')), null);
    assert.match(commandProblem(makeCommand('note', '  ', 'c1')), /message/);
    assert.equal(commandProblem(makeCommand('note', 'Switch the router on', 'c1')), null);
    assert.match(commandProblem(makeCommand('gcode', 'M2', 'c1')), /Pause/);
    assert.match(commandProblem({ type: 'x' }), /Pick/);
});

test('runGcode sends each line, waits for the motion and stops at a refusal', async () => {
    const sent = [];
    const io = { send: async (l) => { sent.push(l); return l === 'M9' ? ['error:20'] : ['ok']; }, aborted: () => false };
    await runGcode(io, 'M8\nG53 G0 Z-1');
    assert.deepEqual(sent, ['M8', 'G53 G0 Z-1', 'G4 P0']);
    sent.length = 0;
    await assert.rejects(runGcode(io, 'M9\nM8'), /refused "M9" \(error:20\)/);
    assert.deepEqual(sent, ['M9']);
    await assert.rejects(runGcode({ ...io, aborted: () => true }, 'M8'), /Stopped/);
});

test('reorderJob and toggleJob', () => {
    assert.deepEqual(reorderJob(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
    assert.deepEqual(reorderJob(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
    assert.deepEqual(reorderJob(['a', 'b', 'c'], 'a', 'a'), ['a', 'b', 'c']);
    const jobs = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    assert.deepEqual(toggleJob(jobs, ['a', 'd'], 'c'), ['a', 'c', 'd']);
    assert.deepEqual(toggleJob(jobs, ['d', 'a'], 'b'), ['b', 'd', 'a']);
    assert.deepEqual(toggleJob(jobs, ['a', 'b'], 'a'), ['b']);
    assert.deepEqual(toggleJob(jobs, ['a'], 'd'), ['a', 'd']);
});

test('planSteps puts commands around their job and lets a bit change replace the automatic one', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const c = (type, id, text = 'x') => makeCommand(type, text, id);
    const commands = {
        iso: { before: [c('note', 'c1', 'Switch the router on')], after: [c('gcode', 'c2', 'M5')] },
        drill: { before: [c('bit', 'c3')] },
        cutout: { after: [c('bit', 'c4')] },
    };
    const steps = planSteps(jobs, ['iso', 'drill', 'cutout'], commands);
    // The probe comes straight after the bit change, before "switch the router on".
    assert.deepEqual(steps.map((s) => s.id), ['bit@iso#1', 'probe', 'cmd:c1', 'iso#1', 'cmd:c2', 'bit:c3', 'drill#1', 'bit@cutout#1', 'cutout#1', 'bit:c4']);
    assert.equal(steps[2].text, 'Switch the router on');
    assert.equal(steps[5].bit.id, steps[6].bit.id);   // set up for the drill
    assert.equal(steps[5].auto, false);
    assert.equal(steps.at(-1).bit, null);
    assert.deepEqual(planWarnings(steps).map((w) => w.code), ['bit-change-at-end']);

    // A bit change after a job sets up the next one, so no automatic one is added there.
    const s2 = planSteps(jobs, ['iso', 'drill'], { iso: { after: [c('bit', 'c5')] } });
    assert.deepEqual(s2.map((s) => s.id), ['bit@iso#1', 'probe', 'iso#1', 'bit:c5', 'drill#1']);
    assert.equal(s2[3].bit.id, s2[4].bit.id);
    assert.deepEqual(planWarnings(s2), []);
});

test('run state: pause and G-code steps, and a bit change clears doubt past them', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const commands = { iso: { before: [makeCommand('note', 'Vacuum', 'c1')], after: [makeCommand('gcode', 'M8\nM9', 'c2')] } };
    const run = S.createRun({ doc, jobs, ids: ['iso', 'drill'], commands, now: 1 });
    S.finishOriginStep(run, 'origin');
    assert.deepEqual(run.commands, commands);
    const r = S.parseRun(S.serializeRun(run));
    assert.ok(r.ok);
    assert.equal(r.run.version, S.RUN_VERSION);
    S.finishBitStep(run, 'bit@iso#1', null, 2);
    S.skipStep(run, 'probe');
    assert.equal(S.currentStep(run).id, 'cmd:c1');
    assert.equal(S.finishCommandStep(run, 'iso#1'), null);
    S.finishCommandStep(run, 'cmd:c1', 3);
    assert.equal(run.history.at(-1).job, 'Pause');
    assert.equal(S.needsBitConfirm(run, 'iso#1'), false);
    S.startStep(run, 'iso#1', 4);
    S.endStep(run, 'iso#1', { result: 'failed' }, 5);
    S.retryStep(run, 'iso#1', 6);
    assert.equal(S.needsBitConfirm(run, 'iso#1'), true);
    S.skipStep(run, 'cmd:c2', 7);
    assert.equal(run.history.at(-1).job, 'G-code');
    const bad = { ...run, steps: [{ ...run.steps[0], kind: 'weird' }] };
    assert.equal(S.parseRun(JSON.stringify(bad)).ok, false);
});

test('runStarted: false until something happens on the machine', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const fresh = () => S.createRun({ doc, jobs, ids: ['iso', 'drill'], commands: { iso: { before: [makeCommand('note', 'Hi', 'c1')] } } });
    assert.equal(S.runStarted(fresh()), false);
    const a = fresh(); S.setBitStage(a, 'bit@iso#1', 'zero'); assert.equal(S.runStarted(a), true);
    const b = fresh(); S.skipStep(b, 'bit@iso#1'); assert.equal(S.runStarted(b), true);
    const c = fresh(); S.insertBitChange(c, 'drill#1'); assert.equal(S.runStarted(c), false);
});

test('restartRun: fresh steps, history kept, and the run counts as not started', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const commands = { iso: { before: [makeCommand('note', 'Hi', 'c1')] } };
    const run = S.createRun({ doc, jobs, ids: ['iso', 'drill'], commands });
    const plan = run.steps.map((s) => s.id);
    S.finishBitStep(run, 'bit@iso#1', null);
    S.finishCommandStep(run, 'cmd:c1');
    S.startStep(run, 'iso#1');
    S.endStep(run, 'iso#1', { result: 'done' });
    S.insertBitChange(run, 'drill#1');
    assert.equal(S.runStarted(run), true);
    const n = run.history.length;
    assert.ok(S.restartRun(run, jobs, 9));
    assert.deepEqual(run.steps.map((s) => s.id), plan);
    assert.ok(run.steps.every((s) => s.status === 'pending'));
    assert.equal(run.history.length, n + 1);
    assert.equal(run.history.at(-1).result, 'restarted');
    assert.equal(S.runStarted(run), false);
    assert.equal(S.currentStep(run).id, 'origin');

    const changed = await withHashes(demoDoc());
    const other = await inspectJobs(changed);
    other[0].files[0].hash = 'x';
    assert.equal(S.restartRun(run, other), null);
});

test('every run starts with Set X0 Y0, and setXYOrigin waits for the status to read 0,0', async () => {
    const doc = await withHashes(demoDoc());
    const jobs = await inspectJobs(doc);
    const run = S.createRun({ doc, jobs, ids: ['iso'] });
    assert.deepEqual(run.steps.slice(0, 2).map((s) => s.id), ['origin', 'bit@iso#1']);
    assert.equal(S.currentStep(run).kind, 'origin');
    assert.equal(S.runStarted(run), false);
    S.finishOriginStep(run, 'origin', { x: -100, y: -80 }, 5);
    assert.equal(run.history.at(-1).job, 'Set X0 Y0');
    assert.equal(S.runStarted(run), true);
    assert.equal(S.currentStep(run).id, 'bit@iso#1');

    const { setXYOrigin } = await import(new URL('../../plugins/project-runner/ui/assets/zeroz.js', import.meta.url));
    const m = { x: 12, y: 7, sent: [] };
    const io = {
        send: async (c) => { m.sent.push(c); if (/^G10 L20 P0 X0 Y0$/.test(c)) { m.x = 0; m.y = 0; } return ['ok']; },
        readWorkXY: async () => ({ x: m.x, y: m.y }), aborted: () => false, sleep: async () => {}, log: () => {},
    };
    assert.deepEqual(await setXYOrigin(io), { x: 0, y: 0 });
    assert.deepEqual(m.sent, ['G10 L20 P0 X0 Y0']);
    await assert.rejects(setXYOrigin({ ...io, readWorkXY: async () => ({ x: 3, y: 0 }) }), /did not confirm/);
});
