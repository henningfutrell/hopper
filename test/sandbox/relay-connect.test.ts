// Issue #2146 (the bastion path, part 2): the command the relay starts in a bastion's box for one connection, run here
// under `sh` with a PATH that holds only what an image might: socat, bash or nc. It joins its stdin and stdout to a
// server on 127.0.0.1 — what a bastion's forward is in the box —, ends when the server ends the connection, and when
// its stdin ends first it still reads the rest of the answer.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { relayCommand } from '../../src/sandbox/bastion.ts';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** Whether this machine has the command: a machine with no socat or nc skips its case. */
const has = (c: string): boolean => existsSync(`/usr/bin/${c}`);

/** A PATH of only these commands, from this machine; none given: nothing but sh. */
function pathOf(commands: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-path-'));
  for (const c of ['sh', 'cat', 'sleep', ...commands]) symlinkSync(`/usr/bin/${c}`, join(dir, c));
  return dir;
}

/** A server that answers each line with `got <line>`, then, after `bye`, the last answer and its end of the connection. */
async function lineServer(o: { slow?: boolean } = {}): Promise<number> {
  const s = createServer({ allowHalfOpen: true }, (c) => {
    let text = '';
    c.on('data', (d: Buffer) => {
      text += d.toString();
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n')) {
        const line = text.slice(0, i);
        text = text.slice(i + 1);
        if (line === 'bye') c.end('bye\n');
        else if (o.slow) setTimeout(() => c.end(`got ${line}\n`), 300);
        else c.write(`got ${line}\n`);
      }
    });
    c.on('error', () => undefined);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}

function run(port: number, path: string, input: string, o: { keepOpen?: boolean } = {}): Promise<{ code: number | null; out: string; err: string }> {
  const [cmd, ...args] = relayCommand(port);
  const child = spawn(cmd!, args, { env: { PATH: path } });
  let out = '', err = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  child.stdin.write(input);
  if (!o.keepOpen) child.stdin.end();
  return new Promise((resolve) => child.on('close', (code) => { child.stdin.destroy(); resolve({ code, out, err }); }));
}

describe.each([
  { tool: 'socat', commands: ['socat'] },
  { tool: 'bash', commands: ['bash'] },
])('the relay\'s connect command in a box with $tool (issue #2146)', ({ tool, commands }) => {
  if (!has(tool)) { it.skip(`this machine has no ${tool}`); return; }
  it('ends when the target ends the connection, its stdin still open', async () => {
    const port = await lineServer();
    const r = await run(port, pathOf(commands), 'one\nbye\n', { keepOpen: true });
    expect(r).toMatchObject({ code: 0, out: 'got one\nbye\n' });
  });

  it('reads the rest of the answer when its stdin ends first', async () => {
    const port = await lineServer({ slow: true });
    const r = await run(port, pathOf(commands), 'one\n');
    expect(r.out).toBe('got one\n');
  });
});

describe('the relay\'s connect command in a box with nc only (issue #2146)', () => {
  it.skipIf(!has('nc'))('joins the connection', async () => {
    const port = await lineServer();
    const r = await run(port, pathOf(['nc']), 'one\nbye\n');
    expect(r.out).toBe('got one\nbye\n');
  });
});

describe('the relay\'s connect command in a box with none of them (issue #2146)', () => {
  it('says what the image lacks, and ends with 127', async () => {
    const r = await run(1, pathOf([]), '');
    expect(r).toEqual({ code: 127, out: '', err: 'hopper-relay: the box\'s image has no socat, bash or nc to reach 127.0.0.1:1\n' });
  });
});
