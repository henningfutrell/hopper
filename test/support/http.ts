// A raw HTTP client over node:http: every header is the test's to set (Host, Origin,
// Sec-Fetch-Site), which fetch may rewrite or refuse.
import { request } from 'node:http';

export interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; text: string }

export function rawRequest(base: string, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  const u = new URL(o.path, base);
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method ?? 'GET',
      headers: { ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}), ...o.headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** An HTTP/1.1 upgrade request: the status it was answered with (101 when switched); the socket is closed at once. */
export function rawUpgrade(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { connection: 'Upgrade', ...headers } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, text: '' }); });
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });
}
