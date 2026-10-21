// One HTTP call over a container runtime's unix socket (issue #708): the Podman and the Docker adapter both speak
// JSON over node:http to a socket. Written here, not taken from a library: each needs a dozen calls, and the Docker
// clients (dockerode) speak only the Docker API, which has no rootless answer for Podman's volumes. A Podman host (issue
// #2272) is reached the same way, over a stream ssh opens in place of the socket (podman-host.ts).
import { createReadStream, statSync } from 'node:fs';
import { request, type RequestOptions } from 'node:http';
import type { Duplex } from 'node:stream';

/** `bytes`: the body as it came, when the call carries them (a container's logs, issue #716). */
export interface Answer { status: number; text: string; bytes?: Buffer }

/** How long one call may take; a pull may take longer, so it passes its own. */
export const CALL_MS = 30_000;

/**
 * Where a runtime's API answers: a unix socket here, or a stream opened for each call (issue #2272: ssh to a Podman host,
 * `podman system dial-stdio`), its `name` for what a refusal says.
 */
export type RuntimeSocket = string | { name: string; connect(): Duplex };

/** How a call reaches `socket`. */
export const dialOf = (socket: RuntimeSocket): Pick<RequestOptions, 'socketPath' | 'createConnection'> =>
  (typeof socket === 'string' ? { socketPath: socket } : { createConnection: () => socket.connect() });
/** The socket as a refusal names it. */
export const socketName = (socket: RuntimeSocket): string => (typeof socket === 'string' ? socket : socket.name);

/** How an adapter sends one call: over the socket here, or carried to a machine's client (remote.ts). */
export type SocketCall = (socket: RuntimeSocket, method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<Answer>;

export async function socketCall(socket: RuntimeSocket, method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<Answer> {
  const a = await socketBytes(socket, method, path, body, timeoutMs);
  return { status: a.status, text: a.bytes.toString('utf8'), bytes: a.bytes };
}

/** One call, its answer as the bytes it came as: a container's logs (issue #716) carry binary frame headers. */
export function socketBytes(socket: RuntimeSocket, method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<{ status: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    // A Buffer is sent as it is, a tar (a build's context); anything else as JSON.
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const type = Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json';
    const req = request({
      ...dialOf(socket), method, path, timeout: timeoutMs,
      headers: { host: 'localhost', ...(payload === undefined ? {} : { 'content-type': type, 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => { chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer to ${method} ${path} within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * One call whose answer streams (issue #1004): a command's output in a box, as it comes. A 2xx answer's bytes go to
 * `onData` and resolve `{ status, text: '' }` when it ends; any other answer is read whole into `text`. The body is
 * JSON, or `file`, a tar on this machine sent as it is read. No idle limit unless `timeoutMs`: a command may be quiet a
 * long time. `signal` drops the call; the promise then rejects.
 */
export function socketStream(socket: RuntimeSocket, method: string, path: string, o: { json?: unknown; file?: string; timeoutMs?: number; signal?: AbortSignal; onData?(chunk: Buffer): void }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) { reject(new Error('stopped')); return; }
    const payload = o.json === undefined ? undefined : JSON.stringify(o.json);
    const headers: Record<string, string | number> = { host: 'localhost' };
    if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    else if (o.file !== undefined) Object.assign(headers, { 'content-type': 'application/x-tar', 'content-length': statSync(o.file).size });
    const req = request({ ...dialOf(socket), method, path, headers, ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}) }, (res) => {
      const status = res.statusCode ?? 0;
      const fine = status >= 200 && status < 300;
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => { if (fine) o.onData?.(d); else chunks.push(d); });
      res.on('end', () => resolve({ status, text: fine ? '' : Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    const stop = () => req.destroy(new Error('stopped'));
    o.signal?.addEventListener('abort', stop, { once: true });
    req.on('close', () => o.signal?.removeEventListener('abort', stop));
    req.on('timeout', () => req.destroy(new Error(`no answer to ${method} ${path} within ${Math.round((o.timeoutMs ?? 0) / 1000)} s`)));
    req.on('error', reject);
    if (o.file !== undefined) createReadStream(o.file).on('error', (e) => req.destroy(e)).pipe(req);
    else req.end(payload);
  });
}

export const ok = (a: Answer): boolean => a.status >= 200 && a.status < 300;

/** A runtime that answered no (issue #2272): not a call that never reached it, which a Podman host's wait tries again. */
export class RuntimeRefusal extends Error {}

/** The runtime's own words for a refusal: its `message`, else the body. */
export function refusal(runtime: string, what: string, a: Answer): Error {
  let message = a.text.trim();
  try { message = (JSON.parse(a.text) as { message?: string }).message ?? message; } catch { /* the body as it is */ }
  return new RuntimeRefusal(`${runtime} refused to ${what} (${a.status}): ${message}`);
}

/** A pull answers 200 and then streams its progress: an error is a line of the stream. */
export function streamError(text: string): string | undefined {
  for (const line of text.split('\n')) {
    try {
      const e = (JSON.parse(line) as { error?: string }).error;
      if (e) return e;
    } catch { /* not a line of JSON */ }
  }
  return undefined;
}

/** The `label` filter both APIs take, as a query parameter. */
export const labelFilter = (labels: Record<string, string> | undefined): string =>
  labels && Object.keys(labels).length
    ? `&filters=${encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }))}`
    : '';

/**
 * A tar of a few small files, each a plain name with its mode: a build's context (issue #716), a box step's own files
 * (issue #1004), a need box's files (issue #1007). Written here, not taken from a library: one ustar header per file and
 * the file, padded to 512-byte blocks, is all these need. A name that ends in `/` with no data is a directory.
 */
export function filesTar(files: readonly { name: string; data?: string | Buffer; mode: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const dir = f.name.endsWith('/') && f.data === undefined;
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    const field = (at: number, len: number, value: string): void => { header.write(value, at, len, 'ascii'); };
    const octal = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`;
    field(0, 100, f.name);
    field(100, 8, octal(f.mode, 8));
    field(108, 8, octal(0, 8));
    field(116, 8, octal(0, 8));
    field(124, 12, octal(data.length, 12));
    field(136, 12, octal(0, 12));
    field(156, 1, dir ? '5' : '0');
    field(257, 6, 'ustar\0');
    field(263, 2, '00');
    // The checksum is of the header with its own field as spaces.
    field(148, 8, '        ');
    let sum = 0;
    for (const b of header) sum += b;
    field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

/** A build's context (issue #716): a tar of one file, the Containerfile. */
export const containerfileTar = (containerfile: string): Buffer => filesTar([{ name: 'Containerfile', data: containerfile, mode: 0o644 }]);

/**
 * A container's logs as text (issue #716). Both APIs may send them as frames — a byte for the stream (0, 1 or 2), three
 * zero bytes, a four-byte length, then that many bytes —, libpod even for a container on a terminal; Docker sends a
 * terminal's as they are. Frames are joined in order; anything else is the text itself.
 */
export function logText(bytes: Buffer): string {
  const framed = (at: number): boolean => at + 8 <= bytes.length && bytes[at]! <= 2 && bytes[at + 1] === 0 && bytes[at + 2] === 0 && bytes[at + 3] === 0;
  if (!framed(0)) return bytes.toString('utf8');
  const parts: Buffer[] = [];
  let at = 0;
  while (framed(at)) {
    const len = bytes.readUInt32BE(at + 4);
    parts.push(bytes.subarray(at + 8, at + 8 + len));
    at += 8 + len;
  }
  return Buffer.concat(parts).toString('utf8');
}
