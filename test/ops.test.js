import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS, OPERATIONS_BY_NAME, checkUrl, validateParams } from '../src/ops.js';

test('every operation has an object input schema', () => {
  for (const op of OPERATIONS) {
    assert.equal(op.inputSchema.type, 'object', op.name);
    assert.ok(op.description.length > 10, op.name);
  }
});

test('URL policy: http, https and about:blank only', () => {
  assert.equal(checkUrl('https://example.com'), 'https://example.com/');
  assert.equal(checkUrl('http://localhost:8080/x'), 'http://localhost:8080/x');
  assert.equal(checkUrl('about:blank'), 'about:blank');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'not a url']) {
    assert.throws(() => checkUrl(bad), /refusing|invalid URL/, bad);
  }
});

test('validateParams accepts good input and drops undefined', () => {
  assert.deepEqual(validateParams('group_tabs', { tabIds: [1, 2], title: 'x', color: 'blue', groupId: undefined }), {
    tabIds: [1, 2], title: 'x', color: 'blue',
  });
  assert.deepEqual(validateParams('move_tabs', { tabIds: [3], index: -1 }), { tabIds: [3], index: -1 });
});

test('validateParams rejects bad input', () => {
  assert.throws(() => validateParams('group_tabs', {}), /missing required parameter "tabIds"/);
  assert.throws(() => validateParams('group_tabs', { tabIds: [] }), /must not be empty/);
  assert.throws(() => validateParams('group_tabs', { tabIds: ['1'] }), /integer/);
  assert.throws(() => validateParams('group_tabs', { tabIds: [1], color: 'magenta' }), /one of/);
  assert.throws(() => validateParams('focus_tab', { tabId: 1, extra: true }), /unknown parameter/);
  assert.throws(() => validateParams('open_url', { url: 'javascript:alert(1)' }), /refusing/);
  assert.throws(() => validateParams('nope', {}), /unknown operation/);
});

test('close_tabs takes exactly one of tabIds or groupId and says to get approval', () => {
  assert.deepEqual(validateParams('close_tabs', { groupId: 7, confirm: true }), { groupId: 7, confirm: true });
  assert.deepEqual(validateParams('close_tabs', { tabIds: [1] }), { tabIds: [1] });
  assert.throws(() => validateParams('close_tabs', { confirm: true }), /exactly one/);
  assert.throws(() => validateParams('close_tabs', { tabIds: [1], groupId: 7 }), /exactly one/);
  assert.match(OPERATIONS_BY_NAME.get('close_tabs').description, /explicit approval/);
});
