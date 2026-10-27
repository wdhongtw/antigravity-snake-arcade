/**
 * @fileoverview Minimal zero-dependency HTTP server helper for UI sidecars
 * using Node.js standard library (`node:http`) and the raw Sidecar HTTP contract.
 *
 * Contract:
 * - Binds to `127.0.0.1` on `process.env.ANTIGRAVITY_SIDECAR_WEB_PORT`.
 * - Enforces `ANTIGRAVITY_SIDECAR_UI_TOKEN` (via `X-Sidecar-Token` header or
 *   `?token=` query param) on non-GET requests using constant-time comparison.
 * - Serves HTML/static routes and JSON API routes.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

export class HttpResponse {
  constructor(body, { contentType = 'text/plain; charset=utf-8', status = 200, headers = {} } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

export class RawSidecarServer {
  #port;
  #token;
  #pages = new Map();
  #apis = new Map();
  #server = null;

  constructor({ allowDefaultPort = false } = {}) {
    const portStr =
      process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
      process.env.PORT ||
      (allowDefaultPort ? '0' : '');
    const parsedPort = Number.parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 0) {
      throw new Error(
        'Missing or invalid ANTIGRAVITY_SIDECAR_WEB_PORT environment variable.'
      );
    }
    this.#port = parsedPort;
    this.#token = (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim();
  }

  get config() {
    return {
      projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
      conversationId:
        process.env.ANTIGRAVITY_SIDECAR_CONVERSATION_ID ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        '',
      dataDir: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '',
    };
  }

  page(routePath, handler) {
    this.#pages.set(routePath, handler);
  }

  api(routePath, handler, method = 'POST') {
    const upper = method.toUpperCase();
    if (!this.#apis.has(routePath)) {
      this.#apis.set(routePath, new Map());
    }
    this.#apis.get(routePath).set(upper, handler);
  }

  #validateToken(req, url) {
    if (!this.#token) return true;
    const rawHeader = req.headers['x-sidecar-token'];
    const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const provided = String(headerToken || url.searchParams.get('token') || '');
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(this.#token, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  #readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytes = 0;
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf-8');
        if (bytes > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  #sendResponse(res, result, defaultContentType = 'application/json; charset=utf-8') {
    if (
      result instanceof HttpResponse ||
      (result && typeof result === 'object' && result.contentType && result.body !== undefined)
    ) {
      const status = result.status || 200;
      const payload =
        typeof result.body === 'string' || Buffer.isBuffer(result.body)
          ? result.body
          : Buffer.from(result.body);
      res.writeHead(status, {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        ...result.headers,
      });
      res.end(payload);
      return;
    }

    res.writeHead(200, {
      'Content-Type': defaultContentType,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(typeof result === 'string' ? result : JSON.stringify(result));
  }

  run() {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${BIND_HOST}:${this.#port}`);

        if (req.method !== 'GET' && req.method !== 'HEAD' && !this.#validateToken(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        if (req.method === 'GET' && this.#pages.has(url.pathname)) {
          const content = await this.#pages.get(url.pathname)(url);
          if (content instanceof HttpResponse) {
            this.#sendResponse(res, content);
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          });
          res.end(content);
          return;
        }

        if (this.#apis.has(url.pathname)) {
          const methodMap = this.#apis.get(url.pathname);
          if (!methodMap.has(req.method)) {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          const data = {};
          for (const [key, value] of url.searchParams.entries()) {
            if (key.toLowerCase() !== 'token') {
              data[key] = value;
            }
          }

          const rawBody = await this.#readRequestBody(req);
          if (rawBody.trim()) {
            try {
              const parsed = JSON.parse(rawBody);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                Object.assign(data, parsed);
              }
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'Invalid JSON request body' }));
              return;
            }
          }

          const handler = methodMap.get(req.method);
          const result = await handler(data, req, url);
          this.#sendResponse(res, result);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      } catch (err) {
        const statusCode = err?.statusCode || 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
    });

    return new Promise((resolve) => {
      this.#server = server.listen(this.#port, BIND_HOST, () => {
        const addr = server.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : this.#port;
        console.log(`[snake_ui] listening on http://${BIND_HOST}:${boundPort}`);
        resolve(server);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.#server) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
  }
}
