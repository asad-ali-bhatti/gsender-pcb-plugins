import { test } from 'node:test';
import assert from 'node:assert/strict';
const C = await import(new URL('../../plugins/pcb-cam/ui/core/index.js', import.meta.url));
const { demoDoc, withHashes } = await import(new URL('../fixtures/demo-project.mjs', import.meta.url));

test('generateJob regenerates each job of a project file', () => {
    const doc = demoDoc();
    for (const job of doc.jobs) {
        const r = C.generateJob(doc, job.id);
        assert.ok(r.ok, JSON.stringify(r.issues));
        assert.equal(r.files.length, 1);
        assert.match(r.files[0].name, new RegExp(job.name.replace(/_/g, '[_-]')));
    }
});

test('generateJob is deterministic and matches generating from parsed layers', async () => {
    const doc = demoDoc();
    const a = C.generateJob(doc, 'iso');
    const b = C.generateJob(doc, 'iso', { layers: C.layersFromFiles(doc.project, doc.boardFiles) });
    assert.equal(await C.gcodeHash(a.files), await C.gcodeHash(b.files));
    const hashed = await withHashes(demoDoc());
    assert.equal(hashed.jobs[0].gcodeHash, await C.gcodeHash(a.files));
    assert.equal(hashed.jobs[0].coreVersion, C.CORE_VERSION);
});

test('generateJob names missing board files and deleted geometries', () => {
    const doc = demoDoc();
    delete doc.boardFiles['demo.drl'];
    const r = C.generateJob(doc, 'drill');
    assert.equal(r.ok, false);
    assert.equal(r.issues[0].code, 'missing-file');
    assert.match(r.issues[0].message, /demo\.drl/);
    // Other jobs still generate.
    assert.ok(C.generateJob(doc, 'iso').ok);

    doc.jobs.push({ id: 'gone', name: 'gone', ops: ['nope'] });
    assert.equal(C.generateJob(doc, 'gone').issues[0].code, 'missing-operation');
    assert.equal(C.generateJob(doc, 'nothing').issues[0].code, 'no-job');
});

test('generateJob returns a frozen job as kept', () => {
    const doc = demoDoc();
    const kept = C.generateJob(doc, 'iso');
    doc.jobs.push({ id: 'old', name: 'old', ops: [], frozen: { deleted: ['x'] }, result: { ok: true, issues: [], files: kept.files, stats: kept.stats } });
    const r = C.generateJob(doc, 'old');
    assert.ok(r.ok && r.frozen);
    assert.equal(r.files[0].gcode, kept.files[0].gcode);
    doc.jobs.push({ id: 'empty', name: 'empty', ops: [], frozen: {}, result: null });
    assert.equal(C.generateJob(doc, 'empty').issues[0].code, 'frozen-no-gcode');
});

test('sha256Hex matches a known digest', async () => {
    assert.equal(await C.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the fingerprint never changes the G-code: generateJob equals plain generate, with no hash inside', async () => {
    const doc = await withHashes(demoDoc());
    const layers = C.layersFromFiles(doc.project, doc.boardFiles);
    for (const job of doc.jobs) {
        const plain = C.generate({ ...doc.project, name: job.name }, layers, { only: job.ops });
        const viaJob = C.generateJob(doc, job.id);
        assert.deepEqual(viaJob.files, plain.files, job.id);
        for (const f of viaJob.files) assert.ok(!f.gcode.includes(job.gcodeHash), `${job.id}: hash leaked into G-code`);
    }
});
