import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HttpError, isValidPid, readJsonBody, sendJson } from './src/http-utils.js';
import {
  ProcessCommandError,
  getProcessSnapshot,
  terminateProcess,
  terminateProcesses,
} from './src/process-service.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const HOST = '127.0.0.1';
const PORT = parsePort(process.env.PORT) ?? 43127;
const BASE_URL = `http://${HOST}:${PORT}`;
const OPEN_BROWSER = process.argv.includes('--open');
const SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');
const APP_ID = 'local-port-manager';
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

let shuttingDown = false;

function parsePort(value) {
  if (value === undefined) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function requestHasValidHost(request) {
  return ALLOWED_HOSTS.has(String(request.headers.host || '').toLowerCase());
}

function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(SESSION_TOKEN);
  const received = Buffer.from(candidate);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function requireMutationAuthorization(request) {
  if (!tokenMatches(request.headers['x-local-session'])) {
    throw new HttpError(403, '本次服务会话验证失败，请刷新页面后重试。');
  }

  const origin = request.headers.origin;
  if (origin && origin !== BASE_URL && origin !== `http://localhost:${PORT}`) {
    throw new HttpError(403, '拒绝来自其他网页的操作请求。');
  }
}

async function serveStaticFile(response, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) return false;

  const [fileName, contentType] = file;
  const body = await fs.readFile(path.join(PUBLIC_DIR, fileName));
  response.writeHead(200, {
    ...securityHeaders(contentType),
    'Content-Length': body.length,
  });
  response.end(body);
  return true;
}

function errorPayload(error) {
  if (error instanceof ProcessCommandError) {
    return {
      statusCode: 409,
      body: {
        error: error.message,
        details: error.details || undefined,
      },
    };
  }
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, body: { error: error.message } };
  }
  console.error(error);
  return { statusCode: 500, body: { error: '本机服务发生未知错误。' } };
}

async function routeRequest(request, response) {
  if (!requestHasValidHost(request)) {
    throw new HttpError(400, '无效的本机服务地址。');
  }

  const url = new URL(request.url || '/', BASE_URL);

  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, securityHeaders('image/x-icon'));
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, app: APP_ID, pid: process.pid });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/session') {
    sendJson(response, 200, {
      token: SESSION_TOKEN,
      serverPid: process.pid,
      version: '1.0.0',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/processes') {
    const force = url.searchParams.get('force') === '1';
    const snapshot = await getProcessSnapshot({ serverPid: process.pid, force });
    sendJson(response, 200, snapshot);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/processes/terminate') {
    requireMutationAuthorization(request);
    const body = await readJsonBody(request);
    if (!isValidPid(body.pid)) throw new HttpError(400, 'PID 无效。');
    if (typeof body.startedAt !== 'string' || !body.startedAt) {
      throw new HttpError(400, '缺少进程启动时间，不能安全结束该进程。');
    }

    const result = await terminateProcess({
      pid: body.pid,
      expectedStartedAt: body.startedAt,
      tree: body.tree === true,
      serverPid: process.pid,
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/processes/terminate-batch') {
    requireMutationAuthorization(request);
    const body = await readJsonBody(request);
    if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.length > 50) {
      throw new HttpError(400, '请选择 1 至 50 个进程。');
    }

    const targets = body.targets.map((target) => {
      if (!target || !isValidPid(target.pid)) throw new HttpError(400, '批量请求中存在无效 PID。');
      if (typeof target.startedAt !== 'string' || !target.startedAt) {
        throw new HttpError(400, `PID ${target.pid} 缺少启动时间，不能安全结束。`);
      }
      return { pid: target.pid, expectedStartedAt: target.startedAt };
    });

    const result = await terminateProcesses({
      targets,
      tree: body.tree === true,
      serverPid: process.pid,
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/shutdown') {
    requireMutationAuthorization(request);
    const body = await readJsonBody(request);
    if (body.confirm !== 'SHUTDOWN') throw new HttpError(400, '未确认关闭服务。');

    shuttingDown = true;
    sendJson(response, 200, { ok: true, message: '本机管理服务正在关闭。' });
    setTimeout(() => shutdownServer('网页操作'), 350);
    return;
  }

  if (request.method === 'GET' && (await serveStaticFile(response, url.pathname))) {
    return;
  }

  throw new HttpError(404, '未找到请求的资源。');
}

const server = http.createServer((request, response) => {
  routeRequest(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const { statusCode, body } = errorPayload(error);
    sendJson(response, statusCode, body);
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

function openBrowser(url) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function checkExistingInstance() {
  return new Promise((resolve) => {
    const request = http.get(`${BASE_URL}/api/health`, { timeout: 1_500 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(payload.app === APP_ID);
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function shutdownServer(source) {
  if (!shuttingDown) shuttingDown = true;
  console.log(`\n正在关闭服务（${source}）...`);

  const fallback = setTimeout(() => process.exit(0), 1_500);
  fallback.unref();
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 800).unref();
}

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    const isExistingInstance = await checkExistingInstance();
    if (isExistingInstance) {
      console.log(`端口管家已经运行：${BASE_URL}`);
      if (OPEN_BROWSER) openBrowser(BASE_URL);
      process.exit(0);
    }
    console.error(`端口 ${PORT} 已被其他程序占用。可设置 PORT 环境变量后重试。`);
    process.exit(1);
  }

  console.error('服务启动失败：', error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('端口管家已启动');
  console.log(`访问地址：${BASE_URL}`);
  console.log(`服务 PID：${process.pid}`);
  console.log('请保留此窗口；也可以在网页右上角关闭服务。');
  if (OPEN_BROWSER) openBrowser(BASE_URL);
});

process.on('SIGINT', () => shutdownServer('Ctrl+C'));
process.on('SIGTERM', () => shutdownServer('系统信号'));
