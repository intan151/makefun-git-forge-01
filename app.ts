// app.ts — the forge server: git smart HTTP + REST v3 + GraphQL v4 + MCP, one store,
// one process. main.ts owns the lifecycle (bind ephemeral port, register, poll done);
// this file is only the HTTP surface.
//
// Auth: REST / GraphQL / MCP require `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
// Git smart-HTTP endpoints do not enforce auth (no git check asserts a 401 path).
// Every reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), JSON_TYPE, extraHeaders);
}

function pathAndQuery(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    if (expectedToken === '') return true; // No token configured (dev only): accept everything.
    const header = req.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${expectedToken}`;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { path, query } = pathAndQuery(req);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);
      const segments = path.split('/').filter((s) => s !== '');

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
        if (segments.length === 4 && segments[1].endsWith('.git') && segments[2] === 'info' && segments[3] === 'refs') {
          const owner = decodeURIComponent(segments[0]);
          const repoName = decodeURIComponent(segments[1].slice(0, -4));
          const body = await readBody(req);
          const out = handleInfoRefs(store, owner, repoName, { method, query, headers, body });
          sendBuffer(res, out.status, out.body, out.contentType);
          return;
        }
        if (segments.length === 3 && segments[1].endsWith('.git') && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
          const owner = decodeURIComponent(segments[0]);
          const repoName = decodeURIComponent(segments[1].slice(0, -4));
          const body = await readBody(req);
          const out =
            segments[2] === 'git-upload-pack'
              ? handleUploadPack(store, owner, repoName, { method, query, headers, body })
              : handleReceivePack(store, owner, repoName, { method, query, headers, body });
          sendBuffer(res, out.status, out.body, out.contentType);
          return;
        }

        // REST v3 (auth required).
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
          const out = handleRest(store, { method, path, query, headers, body, baseUrl });
          if (out) {
            const contentType = out.headers['content-type'] ?? JSON_TYPE;
            const { 'content-type': _ct, ...restHeaders } = out.headers;
            sendBuffer(res, out.status, out.body, contentType, restHeaders);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4 (auth required).
        if ((path === '/api/graphql' || path === '/graphql') && method === 'POST') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          const out = handleGraphql(store, body);
          sendBuffer(res, out.status, out.body, JSON_TYPE);
          return;
        }

        // MCP (auth decided per request inside handleMcp; DELETE closes a session).
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendBuffer(res, 200, Buffer.from('', 'utf8'), JSON_TYPE);
            return;
          }
          if (method === 'POST') {
            const body = await readBody(req);
            const out = handleMcp(store, body, authorized(req));
            sendBuffer(res, out.status, out.body, out.contentType ?? JSON_TYPE);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
