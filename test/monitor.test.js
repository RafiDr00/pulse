import test from 'node:test';
import assert from 'node:assert/strict';
import { PulseMonitor } from '../src/monitor.js';

test('extractToolCalls parses legacy and content block tool_use entries', () => {
  const monitor = new PulseMonitor();
  const entries = [
    { type: 'tool_use', tool_name: 'read_file', is_error: false },
    {
      message: {
        content: [
          { type: 'tool_use', name: 'edit_file' },
          { type: 'text', text: 'ignored' },
        ],
      },
    },
  ];

  const calls = monitor._extractToolCalls(entries);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { name: 'read_file', isError: false });
  assert.deepEqual(calls[1], { name: 'edit_file', isError: false });
});

test('extractVersionFromEntries finds semver in nested payloads', () => {
  const monitor = new PulseMonitor();
  const entries = [
    { foo: { bar: { version: '2.3.4' } } },
    { client_version: '9.9.9' },
  ];

  const version = monitor._extractVersionFromEntries(entries);
  assert.equal(version, '2.3.4');
});
