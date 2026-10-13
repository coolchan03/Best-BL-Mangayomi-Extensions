import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeResults } from '../scripts/apply-health-results.mjs';

const initial = [{ id: 42, name: 'Reader', sourceCodeUrl: 'https://source.example/extension.js',
  version: '1.0', baseUrl: 'https://source.example', notes: 'Keep existing data' }];
test('only changes health metadata', () => {
  const check = [{ ...initial[0], name: 'Unexpected rename',
    status: 'broken', checkedAt: '2026-10-13T01:00:00Z',
    probeHash: 'a'.repeat(64), probeReason: 'javascript_syntax_error', failureStreak: 2 }];
  const result = mergeResults(initial, check);
  assert.equal(result[0].name, 'Reader');
  assert.equal(result[0].notes, 'Keep existing data');
  assert.equal(result[0].status, 'broken');
});
test('refuses to apply results if the source changed', () => {
  assert.throws(() => mergeResults(initial, [{ ...initial[0],
    sourceCodeUrl: 'https://evil.example/code.js', status: 'ok',
    checkedAt: '2026-10-13T01:00:00Z' }]));
  assert.throws(() => mergeResults(initial, []));
});
test('does not accept invalid status strings', () => {
  assert.throws(() => mergeResults(initial, [{ ...initial[0],
    status: 'delete_everything', checkedAt: '2026-10-13T01:00:00Z' }]));
});
