// A command run in a box, and files copied into it (issue #1004, design.md "Box steps"): the exec and archive calls the
// Podman (libpod) and the Docker API share, each under its own prefix, over the runtime's socket beside the hopper. A
// runtime reached through a machine's client has neither: its relay answers each call whole, and a step's output streams.
// The command runs as the box's own user, with the box's sandbox flags; a copy is owned by that user (copyUIDGID).
import type { ContainerRuntime, ExecRun } from '../domain/sandboxes.ts';
import { ok, refusal, socketCall, socketStream } from './socket-http.ts';

/** How long a copy of a step's inputs may take: up to 1 GiB. */
const COPY_MS = 10 * 60_000;
/** How long the exec session may take to say its exit code after its output ended. */
const EXIT_MS = 5_000;

const enc = encodeURIComponent;

/**
 * The stream of an attached exec session, as both APIs send it with no terminal: frames of a byte for the stream (1
 * stdout, 2 stderr), three zero bytes, a four-byte length, then that many bytes. A frame may arrive in pieces.
 */
export function demux(out: (chunk: Buffer, stream: 1 | 2) => void): (data: Buffer) => void {
  let held: Buffer = Buffer.alloc(0);
  return (data) => {
    held = held.length ? Buffer.concat([held, data]) : data;
    while (held.length >= 8) {
      const len = held.readUInt32BE(4);
      if (held.length < 8 + len) break;
      if (len > 0) out(held.subarray(8, 8 + len), held[0] === 2 ? 2 : 1);
      held = held.subarray(8 + len);
    }
  };
}

export function execCalls(socket: string, api: string, runtime: 'podman' | 'docker'): Required<Pick<ContainerRuntime, 'exec' | 'copyIn'>> {
  return {
    async exec(id, run: ExecRun) {
      const made = await socketCall(socket, 'POST', `${api}/containers/${enc(id)}/exec`, {
        AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: run.cmd, ...(run.env ? { Env: Object.entries(run.env).map(([k, v]) => `${k}=${v}`) } : {}),
      });
      if (!ok(made)) throw refusal(runtime, `run a command in the box ${id}`, made);
      const session = String((JSON.parse(made.text) as { Id: string }).Id);
      const started = await socketStream(socket, 'POST', `${api}/exec/${enc(session)}/start`, { json: { Detach: false, Tty: false }, onData: demux(run.out), ...(run.signal ? { signal: run.signal } : {}) });
      if (!ok(started)) throw refusal(runtime, `run a command in the box ${id}`, started);
      // The output ended; the session may take a moment more to say its exit code.
      const until = Date.now() + EXIT_MS;
      for (;;) {
        const read = await socketCall(socket, 'GET', `${api}/exec/${enc(session)}/json`);
        if (!ok(read)) throw refusal(runtime, `read how the command in the box ${id} ended`, read);
        const s = JSON.parse(read.text) as { Running?: boolean; ExitCode?: number | null };
        if (!s.Running && typeof s.ExitCode === 'number') return s.ExitCode;
        if (Date.now() >= until) throw new Error(`${runtime} did not say how the command in the box ${id} ended`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },

    async copyIn(id, dir, tar) {
      const a = await socketStream(socket, 'PUT', `${api}/containers/${enc(id)}/archive?path=${enc(dir)}&copyUIDGID=true`, { file: tar, timeoutMs: COPY_MS });
      if (!ok(a)) throw refusal(runtime, `copy files into the box ${id}`, a);
    },
  };
}
