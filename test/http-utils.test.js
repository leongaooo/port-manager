import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { HttpError, isValidPid, readJsonBody } from '../src/http-utils.js';

test('isValidPid accepts only positive signed 32-bit integers', () => {
  assert.equal(isValidPid(1), true);
  assert.equal(isValidPid(2147483647), true);
  assert.equal(isValidPid(0), false);
  assert.equal(isValidPid(-1), false);
  assert.equal(isValidPid(1.5), false);
  assert.equal(isValidPid('123'), false);
  assert.equal(isValidPid(2147483648), false);
});

test('readJsonBody parses a bounded JSON request', async () => {
  const request = Readable.from([Buffer.from('{"pid":123}')]);
  request.headers = { 'content-type': 'application/json; charset=utf-8' };
  assert.deepEqual(await readJsonBody(request), { pid: 123 });
});

test('readJsonBody rejects unsupported content and malformed JSON', async () => {
  const textRequest = Readable.from([Buffer.from('pid=123')]);
  textRequest.headers = { 'content-type': 'text/plain' };
  await assert.rejects(() => readJsonBody(textRequest), (error) => {
    assert.equal(error instanceof HttpError, true);
    assert.equal(error.statusCode, 415);
    return true;
  });

  const invalidRequest = Readable.from([Buffer.from('{')]);
  invalidRequest.headers = { 'content-type': 'application/json' };
  await assert.rejects(() => readJsonBody(invalidRequest), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});
