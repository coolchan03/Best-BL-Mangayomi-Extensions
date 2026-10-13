import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStatus, safeUrl, INDEXES } from '../scripts/check-sources.mjs';

const at = '2026-10-13T09:00:00.000Z';
test('only two identical definite failures can mark a source broken', () => {
  const proof = { kind: 'definitive', reason: 'javascript_syntax_error', hash: 'a'.repeat(64) };
  const first = decideStatus({}, proof, at);
  assert.equal(first.status, 'unverified');
  assert.equal(first.failureStreak, 1);
  const second = decideStatus(first, proof, at);
  assert.equal(second.status, 'broken');
  assert.equal(second.failureStreak, 2);
  assert.equal(decideStatus(second, { ...proof, hash: 'b'.repeat(64) }, at).status, 'unverified');
});
test('temporary network and CAPTCHAs never create broken status', () => {
  const temporary = { kind: 'unknown', reason: 'download_HTTP_403', hash: 'source-v1' };
  assert.equal(decideStatus({}, temporary, at).status, 'unverified');
  assert.equal(decideStatus(decideStatus({}, temporary, at), temporary, at).status, 'unverified');
});
test('a successful search and detail clears the failure streak', () => {
  const broken = { status: 'broken', probeHash: 'same',
    probeReason: 'javascript_syntax_error', failureStreak: 4 };
  const recovered = decideStatus(broken, { kind: 'ok', reason: 'search_and_detail_verified', hash: 'same' }, at);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.failureStreak, 0);
  assert.equal(decideStatus(broken, { kind: 'unknown', reason: 'Cloudflare', hash: 'same' }, at).status, 'broken');
});
test('network probe only accepts public-looking HTTPS addresses', () => {
  assert.equal(safeUrl('https://example.com/test').hostname, 'example.com');
  for (const url of ['http://example.com/', 'https://127.0.0.1', 'https://localhost/',
    'https://[::1]/', 'file:///etc/passwd', 'https://10.0.0.1',
    'https://private.local']) {
    assert.throws(() => safeUrl(url), url);
  }
});
test('all three repository indexes are in nightly scope', () => {
  assert.deepEqual(INDEXES, ['index.json', 'novel_index.json', 'anime_index.json']);
});
