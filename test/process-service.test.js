import assert from 'node:assert/strict';
import test from 'node:test';

import { getProtectionReason } from '../src/process-service.js';

test('getProtectionReason protects the manager and Windows critical processes', () => {
  assert.match(
    getProtectionReason({ pid: 43127, name: 'node.exe', startedAt: '2026-07-13T00:00:00.000Z' }, 43127),
    /管理服务/,
  );
  assert.match(
    getProtectionReason({ pid: 4, name: 'System', startedAt: '2026-07-13T00:00:00.000Z' }, 99),
    /系统核心/,
  );
  assert.match(
    getProtectionReason({ pid: 1000, name: 'lsass.exe', startedAt: '2026-07-13T00:00:00.000Z' }, 99),
    /系统关键/,
  );
  assert.match(
    getProtectionReason({ pid: 2000, name: 'svchost.exe', startedAt: '2026-07-13T00:00:00.000Z' }, 99),
    /系统关键/,
  );
});

test('getProtectionReason requires a creation time to prevent PID reuse', () => {
  assert.match(getProtectionReason({ pid: 1234, name: 'node.exe', startedAt: null }, 99), /启动时间/);
  assert.equal(
    getProtectionReason({ pid: 1234, name: 'node.exe', startedAt: '2026-07-13T00:00:00.000Z' }, 99),
    null,
  );
});
