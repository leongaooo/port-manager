import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(CURRENT_DIR, '..', 'scripts');
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CRITICAL_PROCESS_NAMES = new Set([
  'csrss.exe',
  'dashost.exe',
  'dwm.exe',
  'fontdrvhost.exe',
  'lsass.exe',
  'registry',
  'secure system',
  'services.exe',
  'sihost.exe',
  'smss.exe',
  'spoolsv.exe',
  'svchost.exe',
  'system',
  'taskhostw.exe',
  'wininit.exe',
  'winlogon.exe',
]);

let cachedSnapshot = null;
let cacheTime = 0;
let snapshotRequest = null;

export class ProcessCommandError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'ProcessCommandError';
    this.details = details;
  }
}

function runPowerShellScript(scriptName, args = [], timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputSize = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ProcessCommandError('读取进程信息超时，请稍后重试。'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= MAX_OUTPUT_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessCommandError('无法启动 Windows PowerShell。', error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (outputSize > MAX_OUTPUT_BYTES) {
        reject(new ProcessCommandError('进程列表过大，已停止读取。'));
        return;
      }
      if (code !== 0) {
        reject(new ProcessCommandError('Windows 拒绝或未能完成该操作。', stderr || stdout));
        return;
      }
      resolve(stdout);
    });
  });
}

function parsePowerShellJson(output, fallbackMessage) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new ProcessCommandError(fallbackMessage, error.message);
  }
}

export function getProtectionReason(processInfo, serverPid) {
  if (processInfo.pid === serverPid) return '管理服务自身只能通过“关闭服务”退出';
  if (processInfo.pid <= 4) return 'Windows 系统核心进程';
  if (CRITICAL_PROCESS_NAMES.has(processInfo.name.toLowerCase())) return 'Windows 系统关键进程';
  if (!processInfo.startedAt) return '无法验证进程启动时间';
  return null;
}

function normalizeSnapshot(rawSnapshot, serverPid) {
  const rawProcesses = Array.isArray(rawSnapshot.processes) ? rawSnapshot.processes : [];
  const processes = rawProcesses.map((item) => {
    const processInfo = {
      pid: Number(item.pid),
      parentPid: Number(item.parentPid) || null,
      name: String(item.name || '未知进程'),
      executablePath: item.executablePath || null,
      commandLine: item.commandLine || null,
      startedAt: item.startedAt || null,
      parentName: item.parentName || null,
      parentCommandLine: item.parentCommandLine || null,
      isNode: Boolean(item.isNode),
      endpoints: Array.isArray(item.endpoints) ? item.endpoints : [],
    };
    const protectionReason = getProtectionReason(processInfo, serverPid);
    return {
      ...processInfo,
      isManager: processInfo.pid === serverPid,
      canTerminate: protectionReason === null,
      protectionReason,
    };
  });

  return {
    generatedAt: rawSnapshot.generatedAt || new Date().toISOString(),
    serverPid,
    processes,
  };
}

export async function getProcessSnapshot({ serverPid, force = false } = {}) {
  const now = Date.now();
  if (!force && cachedSnapshot && now - cacheTime < 800) {
    return normalizeSnapshot(cachedSnapshot, serverPid);
  }

  if (!snapshotRequest) {
    snapshotRequest = runPowerShellScript('list-processes.ps1')
      .then((output) => parsePowerShellJson(output, '无法解析 Windows 进程列表。'))
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        cacheTime = Date.now();
        return snapshot;
      })
      .finally(() => {
        snapshotRequest = null;
      });
  }

  const snapshot = await snapshotRequest;
  return normalizeSnapshot(snapshot, serverPid);
}

function validateTarget(snapshot, requestedTarget) {
  const { pid, expectedStartedAt } = requestedTarget;
  const target = snapshot.processes.find((item) => item.pid === pid);

  if (!target) {
    throw new ProcessCommandError(`PID ${pid} 已退出或不再属于当前列表。`);
  }
  if (!target.canTerminate) {
    throw new ProcessCommandError(`PID ${pid}：${target.protectionReason || '该进程受保护，不能结束。'}`);
  }
  if (!target.startedAt || target.startedAt !== expectedStartedAt) {
    throw new ProcessCommandError(`PID ${pid} 的进程身份已变化。为避免误操作，请刷新列表后重试。`);
  }
  return target;
}

async function terminateValidatedTarget(target, tree) {
  const args = [
    '-TargetProcessId',
    String(target.pid),
    '-ExpectedCreationTime',
    target.startedAt,
  ];
  if (tree) args.push('-Tree');

  const output = await runPowerShellScript('terminate-process.ps1', args, 15_000);
  return parsePowerShellJson(output, '进程已处理，但无法解析执行结果。');
}

export async function terminateProcess({ pid, expectedStartedAt, tree, serverPid }) {
  const snapshot = await getProcessSnapshot({ serverPid, force: true });
  const target = validateTarget(snapshot, { pid, expectedStartedAt });
  const result = await terminateValidatedTarget(target, tree);
  cachedSnapshot = null;
  return result;
}

function selectedAncestorPid(target, processByPid, selectedPids) {
  const visited = new Set();
  let parentPid = target.parentPid;

  while (parentPid && !visited.has(parentPid)) {
    if (selectedPids.has(parentPid)) return parentPid;
    visited.add(parentPid);
    parentPid = processByPid.get(parentPid)?.parentPid ?? null;
  }
  return null;
}

export async function terminateProcesses({ targets, tree, serverPid }) {
  const snapshot = await getProcessSnapshot({ serverPid, force: true });
  const seenPids = new Set();
  const validatedTargets = targets.map((requestedTarget) => {
    if (seenPids.has(requestedTarget.pid)) {
      throw new ProcessCommandError(`PID ${requestedTarget.pid} 被重复选择，请刷新页面后重试。`);
    }
    seenPids.add(requestedTarget.pid);
    return validateTarget(snapshot, requestedTarget);
  });

  const processByPid = new Map(snapshot.processes.map((item) => [item.pid, item]));
  const coveredByTree = [];
  const executionTargets = tree
    ? validatedTargets.filter((target) => {
        const ancestorPid = selectedAncestorPid(target, processByPid, seenPids);
        if (!ancestorPid) return true;
        coveredByTree.push({ pid: target.pid, ancestorPid });
        return false;
      })
    : validatedTargets;

  const succeeded = [];
  const failed = [];
  for (const target of executionTargets) {
    try {
      await terminateValidatedTarget(target, tree);
      succeeded.push({ pid: target.pid, name: target.name });
    } catch (error) {
      failed.push({
        pid: target.pid,
        name: target.name,
        error: error.message,
        details: error.details || undefined,
      });
    }
  }

  cachedSnapshot = null;
  return {
    ok: failed.length === 0,
    requested: validatedTargets.length,
    succeeded,
    coveredByTree,
    failed,
  };
}
