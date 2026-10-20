// Issue #2146 (the bastion path, part 2): a byte pipe to a command in a running box, through the real Podman and Docker
// adapters over a unix socket. The runtime is a double of the exec API on that socket: its exec start is an HTTP/1.1
// upgrade it hijacks, it runs the command on this machine, takes the pipe's bytes as the command's stdin and sends its
// stdout and stderr back in frames, as both APIs do for a box on no terminal.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createDockerRuntime, API as DOCKER_API } from '../../src/sandbox/docker.ts';
import { createPodmanRuntime, API as PODMAN_API } from '../../src/sandbox/podman.ts';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';

const frame = (stream: number, data: Buffer): Buffer => {
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};

interface ExecApi { socket: string; server: Server; execs: { box: string; cmd: string[] }[] }

/** The exec API double: `box` names the only box there; any other is a 404. */
function execApi(api: string, box: string): Promise<ExecApi> {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  const socket = join(dir, 'api.sock');
  const execs: ExecApi['execs'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => { body += d.toString(); });
    req.on('end', () => {
      const inspected = new RegExp(`^${api}/containers/([^/]+)/json$`).exec(req.url ?? '');
      if (req.method === 'GET' && inspected) {
        const name = decodeURIComponent(inspected[1]!);
        if (name === box || name === 'stack') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Config: { Labels: name === box ? { 'io.hopper.need': 'i' } : {} } }));
        else res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no such container"}');
        return;
      }
      const m = new RegExp(`^${api}/containers/([^/]+)/exec$`).exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        if (decodeURIComponent(m[1]!) !== box) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no such container"}'); return; }
        const b = JSON.parse(body) as { Cmd: string[]; AttachStdin: boolean; AttachStdout: boolean; Tty: boolean };
        expect(b).toMatchObject({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
        execs.push({ box, cmd: b.Cmd });
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ Id: `exec${execs.length}` }));
        return;
      }
      res.writeHead(404).end('{"message":"not found"}');
    });
  });
  server.on('upgrade', (req, sock: Duplex, head: Buffer) => {
    const m = new RegExp(`^${api}/exec/exec(\\d+)/start$`).exec(req.url ?? '');
    const e = m ? execs[Number(m[1]) - 1] : undefined;
    if (!e || req.headers.upgrade !== 'tcp') { sock.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n'); return; }
    // Node's server reads the start's own JSON body before the upgrade, as the runtimes do: what follows is stdin.
    sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const child = spawn(e.cmd[0]!, e.cmd.slice(1), { stdio: 'pipe' });
    const toStdin = (d: Buffer): void => { child.stdin.write(d); };
    if (head.length) toStdin(head);
    sock.on('data', toStdin);
    sock.on('end', () => child.stdin.end());
    sock.on('error', () => child.kill());
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (d: Buffer) => sock.write(frame(1, d)));
    child.stderr.on('data', (d: Buffer) => sock.write(frame(2, d)));
    child.on('close', () => sock.end());
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, server, execs })));
}

const read = (p: BoxPipe): Promise<Buffer> => new Promise((resolve, reject) => {
  const out: Buffer[] = [];
  p.on('data', (d: Buffer) => { out.push(d); });
  p.on('end', () => resolve(Buffer.concat(out)));
  p.on('error', reject);
});

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

describe.each([
  { kind: 'podman', api: PODMAN_API, make: createPodmanRuntime },
  { kind: 'docker', api: DOCKER_API, make: createDockerRuntime },
])('a byte pipe into a $kind box (issue #2146)', ({ api, make }) => {
  it('writes the command\'s stdin, reads its stdout as it came, and keeps its stderr apart', async () => {
    const x = await execApi(api, 'hopper-bastion-a');
    servers.push(x.server);
    const runtime = make(x.socket);
    const pipe = await runtime.pipe!('hopper-bastion-a', ['sh', '-c', 'cat; echo the end >&2']);
    const out = read(pipe);
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
    pipe.write(Buffer.from('hello '));
    pipe.write(bytes);
    pipe.end();
    expect(await out).toEqual(Buffer.concat([Buffer.from('hello '), bytes]));
    expect(pipe.stderr()).toBe('the end\n');
    expect(x.execs).toEqual([{ box: 'hopper-bastion-a', cmd: ['sh', '-c', 'cat; echo the end >&2'] }]);
    rmSync(join(x.socket, '..'), { recursive: true, force: true });
  });

  it('keeps binary stdout byte for byte, across frames', async () => {
    const x = await execApi(api, 'b');
    servers.push(x.server);
    const pipe = await make(x.socket).pipe!('b', ['sh', '-c', 'head -c 300000 /dev/zero | tr "\\000" "\\377"']);
    const all = await read(pipe);
    expect(all.length).toBe(300000);
    expect(all.every((b) => b === 255)).toBe(true);
    pipe.destroy();
  });

  it('says the runtime\'s refusal when the box is not there', async () => {
    const x = await execApi(api, 'b');
    servers.push(x.server);
    await expect(make(x.socket).pipe!('gone', ['true'])).rejects.toThrow(/refused to start a command in the box gone \(404\): no such container/);
  });

  it('starts no command in a container that is no need box', async () => {
    const x = await execApi(api, 'b');
    servers.push(x.server);
    await expect(make(x.socket).pipe!('stack', ['true'])).rejects.toThrow(/only in a need box: stack carries no io.hopper.need label/);
    expect(x.execs).toEqual([]);
  });
});
