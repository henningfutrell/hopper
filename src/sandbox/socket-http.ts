// One HTTP call over a container runtime's unix socket (issue #708): the Podman and the Docker adapter both speak
// JSON over node:http to a socket. Written here, not taken from a library: each needs a dozen calls, and the Docker
// clients (dockerode) speak only the Docker API, which has no rootless answer for Podman's volumes.
import { request } from 'node:http';

export interface Answer { status: number; text: string }

/** How long one call may take; a pull may take longer, so it passes its own. */
export const CALL_MS = 30_000;

export async function socketCall(socket: string, method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<Answer> {
  const a = await socketBytes(socket, method, path, body, timeoutMs);
  return { status: a.status, text: a.bytes.toString('utf8') };
}

/** One call, its answer as the bytes it came as: a container's logs (issue #716) carry binary frame headers. */
export function socketBytes(socket: string, method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<{ status: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    // A Buffer is sent as it is, a tar (a build's context); anything else as JSON.
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const type = Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json';
    const req = request({
      socketPath: socket, method, path, timeout: timeoutMs,
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

export const ok = (a: Answer): boolean => a.status >= 200 && a.status < 300;

/** The runtime's own words for a refusal: its `message`, else the body. */
export function refusal(runtime: string, what: string, a: Answer): Error {
  let message = a.text.trim();
  try { message = (JSON.parse(a.text) as { message?: string }).message ?? message; } catch { /* the body as it is */ }
  return new Error(`${runtime} refused to ${what} (${a.status}): ${message}`);
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
 * A build's context (issue #716): a tar of one file, the Containerfile. Written here, not taken from a library: one
 * ustar header and the file, padded to 512-byte blocks, is all a build of one Containerfile needs.
 */
export function containerfileTar(containerfile: string): Buffer {
  const data = Buffer.from(containerfile, 'utf8');
  const header = Buffer.alloc(512);
  const field = (at: number, len: number, value: string): void => { header.write(value, at, len, 'ascii'); };
  const octal = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`;
  field(0, 100, 'Containerfile');
  field(100, 8, octal(0o644, 8));
  field(108, 8, octal(0, 8));
  field(116, 8, octal(0, 8));
  field(124, 12, octal(data.length, 12));
  field(136, 12, octal(0, 12));
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  // The checksum is of the header with its own field as spaces.
  field(148, 8, '        ');
  let sum = 0;
  for (const b of header) sum += b;
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad, Buffer.alloc(1024)]);
}

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
