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

test('extractToolCalls maps tool_result error to matching tool_use', () => {
  const monitor = new PulseMonitor();
  const entries = [
    {
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
          { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true },
        ],
      },
    },
  ];

  const calls = monitor._extractToolCalls(entries);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: 'read_file', isError: true });
});

test('analyzeSession preserves quota values from stats polling', () => {
  const monitor = new PulseMonitor();
  monitor.metrics.quota.remaining = 37;
  monitor.metrics.quota.used = 63;
  monitor.metrics.quota.burnRate = 12;
  monitor.metrics.quota.estimatedHoursLeft = 3.1;

  const entries = [
    { role: 'user', content: 'check' },
    {
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'read_file' },
          { type: 'tool_result', tool_use_id: 'toolu_2', is_error: false },
        ],
      },
    },
  ];

  monitor._analyzeSession(entries, 'session.jsonl');

  assert.equal(monitor.metrics.quota.remaining, 37);
  assert.equal(monitor.metrics.quota.used, 63);
  assert.equal(monitor.metrics.quota.burnRate, 12);
  assert.equal(monitor.metrics.quota.estimatedHoursLeft, 3.1);
});
