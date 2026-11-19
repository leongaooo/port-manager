import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitForOutput(child, pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output: ${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Child exited with ${code}. Output: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child process did not exit in time.')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('server lists processes, protects itself, terminates single and batch targets, and shuts down', { timeout: 60_000 }, async (t) => {
  const port = 45_000 + (process.pid % 10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (server.exitCode === null) server.kill();
  });
  await waitForOutput(server, /端口管家已启动/);

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).app, 'local-port-manager');

  const pageResponse = await fetch(baseUrl);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-security-policy'), /default-src 'self'/);

  const session = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
  const snapshot = await fetch(`${baseUrl}/api/processes?force=1`).then((response) => response.json());
  const manager = snapshot.processes.find((item) => item.pid === session.serverPid);
  assert.ok(manager);
  assert.equal(manager.isManager, true);
  assert.equal(manager.canTerminate, false);

  const unauthorizedResponse = await fetch(`${baseUrl}/api/processes/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: manager.pid, startedAt: manager.startedAt, tree: false }),
  });
  assert.equal(unauthorizedResponse.status, 403);

  const disposable = spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1', () => console.log('READY'))"], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (disposable.exitCode === null) disposable.kill();
  });
  await waitForOutput(disposable, /READY/);

  const disposableSnapshot = await fetch(`${baseUrl}/api/processes?force=1`).then((response) => response.json());
  const disposableRecord = disposableSnapshot.processes.find((item) => item.pid === disposable.pid);
  assert.ok(disposableRecord);
  assert.equal(disposableRecord.canTerminate, true);

  const terminateResponse = await fetch(`${baseUrl}/api/processes/terminate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Session': session.token,
    },
    body: JSON.stringify({
      pid: disposable.pid,
      startedAt: disposableRecord.startedAt,
      tree: false,
    }),
  });
  assert.equal(terminateResponse.status, 200);
  await waitForExit(disposable);

  const batchProcesses = [0, 1].map(() => spawn(
    process.execPath,
    ['-e', "require('net').createServer().listen(0, '127.0.0.1', () => console.log('READY'))"],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  ));
  t.after(() => {
    batchProcesses.forEach((child) => {
      if (child.exitCode === null) child.kill();
    });
  });
  await Promise.all(batchProcesses.map((child) => waitForOutput(child, /READY/)));

  const batchSnapshot = await fetch(`${baseUrl}/api/processes?force=1`).then((response) => response.json());
  const batchRecords = batchProcesses.map((child) => batchSnapshot.processes.find((item) => item.pid === child.pid));
  batchRecords.forEach((record) => {
    assert.ok(record);
    assert.equal(record.canTerminate, true);
  });

  const rejectedBatchResponse = await fetch(`${baseUrl}/api/processes/terminate-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Session': session.token,
    },
    body: JSON.stringify({
      targets: [
        { pid: manager.pid, startedAt: manager.startedAt },
        { pid: batchRecords[0].pid, startedAt: batchRecords[0].startedAt },
      ],
      tree: false,
    }),
  });
  assert.equal(rejectedBatchResponse.status, 409);
  assert.equal(batchProcesses[0].exitCode, null);

  const batchResponse = await fetch(`${baseUrl}/api/processes/terminate-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Session': session.token,
    },
    body: JSON.stringify({
      targets: batchRecords.map((record) => ({ pid: record.pid, startedAt: record.startedAt })),
      tree: false,
    }),
  });
  assert.equal(batchResponse.status, 200);
  const batchResult = await batchResponse.json();
  assert.equal(batchResult.ok, true);
  assert.equal(batchResult.succeeded.length, 2);
  assert.equal(batchResult.failed.length, 0);
  await Promise.all(batchProcesses.map((child) => waitForExit(child)));

  const shutdownResponse = await fetch(`${baseUrl}/api/shutdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Session': session.token,
    },
    body: JSON.stringify({ confirm: 'SHUTDOWN' }),
  });
  assert.equal(shutdownResponse.status, 200);
  await waitForExit(server);
});
