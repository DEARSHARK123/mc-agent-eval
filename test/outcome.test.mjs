import test from 'node:test';
import assert from 'node:assert/strict';
import { errorPayload, abortStatus, firstError } from '../src/outcome.js';

test('errorPayload: copies name and message, defaults for non-errors', () => {
  assert.deepEqual(errorPayload(new TypeError('bad')), { name: 'TypeError', message: 'bad' });
  assert.deepEqual(errorPayload('oops'), { name: 'Error', message: 'oops' });
  assert.deepEqual(errorPayload(undefined), { name: 'Error', message: 'undefined' });
});

test('errorPayload: carries code and hits only when present', () => {
  const error = new Error('nope');
  error.code = 'missing_ingredients';
  error.hits = 3;
  assert.deepEqual(errorPayload(error),
    { name: 'Error', message: 'nope', code: 'missing_ingredients', hits: 3 });
  assert.deepEqual(errorPayload(Object.assign(new Error('x'), { code: 'no_table' })),
    { name: 'Error', message: 'x', code: 'no_table' });
  assert.ok(!('code' in errorPayload(new Error('plain'))));
  assert.ok(!('hits' in errorPayload(new Error('plain'))));
});

test('abortStatus: preempted only for reason preempted', () => {
  const controller = new AbortController();
  controller.abort('preempted');
  assert.equal(abortStatus(controller.signal), 'preempted');
  const other = new AbortController();
  other.abort(new Error('stop'));
  assert.equal(abortStatus(other.signal), 'cancelled');
  assert.equal(abortStatus(other.signal), 'cancelled');
  assert.equal(abortStatus(undefined), 'cancelled');
  assert.equal(abortStatus(null), 'cancelled');
});

test('firstError: prefers outcome.error then first failed result', () => {
  const top = new Error('top');
  const inner = new Error('inner');
  assert.equal(firstError({ error: top }), top);
  assert.equal(firstError({ results: [{ ok: true }, { ok: false, error: inner }] }), inner);
  assert.equal(firstError({ error: top, results: [{ ok: false, error: inner }] }), top);
  assert.equal(firstError({ results: [{ ok: true }] }), undefined);
  assert.equal(firstError(undefined), undefined);
});
