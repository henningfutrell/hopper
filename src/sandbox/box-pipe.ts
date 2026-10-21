// A byte pipe to a command in a running box (issue #2146, the bastion path, part 2: the relay): the exec call the Podman
// (libpod) and the Docker API share, each under its own prefix, over the runtime's socket beside the hopper. The exec's
// start is an HTTP/1.1 upgrade the runtime hijacks: what the hopper writes is the command's stdin, and what comes back is
// its stdout and stderr in frames — a byte for the stream, three zero bytes, a four-byte length, then the bytes —, as
// the box runs on no terminal. Only into a need box (NEED_LABEL): a bastion is one, and no other box is piped into. A
// runtime reached through a machine's client has none: a bastion runs beside the hopper only. Written here, not taken
// from a library, for the same reason as socket-http.ts: two calls, and the clients speak the Docker API only.
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { BoxPipe, ContainerRuntime } from '../domain/sandboxes.ts';
import { NEED_LABEL } from './owned.ts';
import { dialOf, ok, refusal, socketCall, type RuntimeSocket } from './socket-http.ts';

/** The most of a command's stderr a pipe keeps: its tail. */
const STDERR_TAIL = 2048;
/** How long the exec's start may take to be upgraded. */
const START_MS = 30_000;

const enc = encodeURIComponent;

/** The hijacked connection, as a stream: writes go to the command's stdin, its stdout frames are read back. */
class FramedPipe extends Duplex implements BoxPipe {
  private readonly sock: Socket;
  private pending: Buffer = Buffer.alloc(0);
  private err = '';

  constructor(sock: Socket, head: Buffer) {
    super();
    this.sock = sock;
    sock.on('data', (d: Buffer) => this.frames(d));
    sock.on('end', () => this.push(null));
    sock.on('error', (e) => this.destroy(e));
    sock.on('close', () => { if (!this.readableEnded) this.push(null); });
    if (head.length) this.frames(head);
  }

  stderr(): string { return this.err; }

  /** Reads each whole frame: stdout is pushed, stderr kept. */
  private frames(d: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
    while (this.pending.length >= 8) {
      const len = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + len) break;
      const stream = this.pending[0];
      const data = this.pending.subarray(8, 8 + len);
      this.pending = this.pending.subarray(8 + len);
      if (stream === 2) this.err = (this.err + data.toString('utf8')).slice(-STDERR_TAIL);
      else if (!this.push(Buffer.from(data))) this.sock.pause();
    }
  }

  override _read(): void { this.sock.resume(); }
  override _write(chunk: Buffer, _enc: BufferEncoding, done: (e?: Error | null) => void): void { this.sock.write(chunk, done); }
  // The writes ended: the command's stdin ends, and its stdout is still read until it ends too.
  override _final(done: (e?: Error | null) => void): void { this.sock.end(); done(); }
  override _destroy(e: Error | null, done: (e?: Error | null) => void): void { this.sock.destroy(); done(e); }
}

export function pipeCall(socket: RuntimeSocket, api: string, runtime: 'podman' | 'docker'): Required<Pick<ContainerRuntime, 'pipe'>> {
  return {
    async pipe(id, cmd) {
      const what = `start a command in the box ${id}`;
      const box = await socketCall(socket, 'GET', `${api}/containers/${enc(id)}/json`);
      if (box.status === 404) throw new Error(`${runtime} refused to ${what} (404): no such container`);
      if (!ok(box)) throw refusal(runtime, what, box);
      if (typeof (JSON.parse(box.text) as { Config?: { Labels?: Record<string, string> | null } }).Config?.Labels?.[NEED_LABEL] !== 'string') {
        throw new Error(`the hopper starts a command only in a need box: ${id} carries no ${NEED_LABEL} label`);
      }
      const made = await socketCall(socket, 'POST', `${api}/containers/${enc(id)}/exec`, { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: [...cmd] });
      if (!ok(made)) throw refusal(runtime, what, made);
      const exec = String((JSON.parse(made.text) as { Id: string }).Id);
      const body = JSON.stringify({ Detach: false, Tty: false });
      return new Promise<BoxPipe>((resolve, reject) => {
        const req = request({
          ...dialOf(socket), method: 'POST', path: `${api}/exec/${enc(exec)}/start`, timeout: START_MS,
          headers: { host: 'localhost', connection: 'Upgrade', upgrade: 'tcp', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        });
        req.on('upgrade', (_res, sock: Socket, head: Buffer) => { sock.setTimeout(0); resolve(new FramedPipe(sock, head)); });
        req.on('response', (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => reject(refusal(runtime, what, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })));
        });
        req.on('timeout', () => req.destroy(new Error(`no answer to the start of a command in the box ${id} within ${START_MS / 1000} s`)));
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}
