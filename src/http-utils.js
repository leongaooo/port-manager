export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function sendJson(response, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

export async function readJsonBody(request, maxBytes = 16 * 1024) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, '请求必须使用 application/json。');
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, '请求内容过大。');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求 JSON 格式无效。');
  }
}

export function isValidPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}
