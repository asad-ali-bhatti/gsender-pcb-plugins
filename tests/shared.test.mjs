import { test } from 'node:test';
import assert from 'node:assert/strict';
const { differences } = await import(new URL('../scripts/sync-shared.mjs', import.meta.url));

test('Project Runner\'s shared copies match their sources (run node scripts/sync-shared.mjs)', () => {
    assert.deepEqual(differences(), []);
});
