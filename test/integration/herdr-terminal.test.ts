// Issue #189: the herdr terminal — an actual terminal in the browser onto the root herdr, which runs
// on the hopper's machine and lists the herdr of every attached machine it reaches over ssh. Real
// HTTP server and WebSocket; the pseudo-terminal and herdr's saved-machine CLI are doubles at their
// seams (test/herdr-terminal/ drives the real adapters). An admin's UI session mints a one-time
// ticket (a WebSocket sends no session header); the socket opens with it, from a UI origin, once.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HerdrMachineProfile, HerdrMachineSync, Terminal, TerminalSpawn } from '../../src/domain/ports.ts';
import type { HerdrTerminalStatus } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { TEST_HOST_KEY, testSshAuth } from '../support/ssh.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

interface FakeTerminal extends Terminal { spawn: TerminalSpawn; input: string[]; sizes: [number, number][]; killed: boolean; emit(d: string): void; exit(code: number): void }

async function start() {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const auth = testSshAuth(join(db.dbPath, '..', 'key'))();
  const terminals: FakeTerminal[] = [];
  const synced: HerdrMachineProfile[][] = [];
  t = await startTestApp({
    dbPath: db.dbPath,
    secrets: { HOPPER_SSH_KEY_FILE: auth.identityFile, HOPPER_DATABASE_PASSWORD: 'not for the terminal' },
    plugins: {
      machines: [
        { name: 'local', plugin: 'local' },
        { name: 'laptop', plugin: 'ssh', options: { ssh: 'me@192.0.2.10', label: 'Laptop', hostKey: TEST_HOST_KEY, herdrBin: '/usr/bin/herdr' } },
        { name: 'box', plugin: 'docker', options: { docker: 'hopper-target' } },
      ],
    },
    seams: {
      machineProbe: async () => ({ online: true }),
      terminal: (spawn) => {
        const data: ((d: string) => void)[] = [];
        const exits: ((c: number) => void)[] = [];
        const term: FakeTerminal = {
          spawn, input: [], sizes: [], killed: false,
          write: (d) => { term.input.push(d); }, resize: (c, r) => { term.sizes.push([c, r]); }, kill: () => { term.killed = true; },
          onData: (l) => { data.push(l); }, onExit: (l) => { exits.push(l); },
          emit: (d) => { for (const l of data) l(d); }, exit: (c) => { for (const l of exits) l(c); },
        };
        terminals.push(term);
        return term;
      },
      herdrMachines: async ({ profiles }): Promise<HerdrMachineSync[]> => {
        synced.push(profiles);
        return profiles.map((p) => ({ machine: p.machine, state: 'saved' }));
      },
    },
  });
  return { a: t, terminals, synced };
}

const origin = (a: TestApp) => new URL(a.url).origin;
const socketUrl = (a: TestApp, q: string) => `${a.url.replace(/^http/, 'ws')}/ui/api/herdr-terminal/socket?${q}`;

/** Open the socket; resolves with it open, or with the reason it did not. */
function connect(url: string, headers: Record<string, string>): Promise<{ ws?: WebSocket; refused?: true; got: string[] }> {
  const got: string[] = [];
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => { got.push(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString('utf8')); };
    ws.onopen = () => resolve({ ws, got });
    ws.onerror = () => resolve({ refused: true, got });
  });
}

async function ticket(a: TestApp, token: string): Promise<string> {
  const r = await a.ui<{ ticket: string }>('/ui/api/herdr-terminal/ticket', {}, { token });
  expect(r.status).toBe(200);
  return r.body.ticket;
}

describe('the herdr terminal', () => {
  it('shows the root herdr session and which machines its herdr lists, and why the others are not', async () => {
    const { a } = await start();
    const r = await a.api<HerdrTerminalStatus>('GET', '/api/herdr-terminal');
    expect(r.status).toBe(200);
    expect(r.body.session).toBe('hopper-root');
    expect(r.body.machines).toEqual([
      { name: 'laptop', label: 'Laptop', listed: true },
      { name: 'box', label: 'box', listed: false, reason: 'a container target runs no herdr' },
    ]);
  });

  it('opens an actual terminal on the root herdr: the browser\'s size, its keys in, the screen out, resized with it', async () => {
    const { a, terminals, synced } = await start();
    const token = await a.login();
    const { ws, got } = await connect(socketUrl(a, `ticket=${await ticket(a, token)}&cols=132&rows=41`), { origin: origin(a) });
    expect(ws).toBeDefined();
    await waitFor(() => terminals.length === 1, { timeoutMs: 3000 });
    const term = terminals[0]!;
    expect([term.spawn.file, term.spawn.args, term.spawn.cols, term.spawn.rows]).toEqual(['herdr', ['--session', 'hopper-root'], 132, 41]);
    // Its own herdr state (the root herdr's saved machines are the hopper's), the ssh wrapper first on PATH.
    const dir = join(a.dataDir, 'herdr-terminal');
    expect(term.spawn.env.XDG_STATE_HOME).toBe(join(dir, 'state'));
    expect(term.spawn.env.PATH!.split(':')[0]).toBe(join(dir, 'bin'));
    expect(term.spawn.env.TERM).toBe('xterm-256color');
    // No secret of the daemon's reaches the terminal, and no herdr nesting marker.
    expect(Object.keys(term.spawn.env).filter((k) => k.startsWith('HOPPER_') || k.startsWith('HERDR_'))).toEqual([]);
    // The root herdr's saved machines follow the plan; the pins and the wrapper are written.
    await waitFor(() => synced.length === 1, { timeoutMs: 3000 });
    expect(synced[0]).toEqual([{ machine: 'laptop', label: 'Laptop (laptop)', target: 'ssh://me@192.0.2.10:22', session: 'hopper', hostKey: TEST_HOST_KEY }]);
    expect(readFileSync(join(dir, 'known_hosts'), 'utf8')).toBe(`192.0.2.10 ${TEST_HOST_KEY}\n`);
    expect(statSync(join(dir, 'bin', 'ssh')).mode & 0o777).toBe(0o700);
    const status = await a.api<HerdrTerminalStatus>('GET', '/api/herdr-terminal');
    expect(status.body.machines[0]).toEqual({ name: 'laptop', label: 'Laptop', listed: true, sync: 'saved' });

    ws!.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    ws!.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await waitFor(() => term.input.length === 1 && term.sizes.length === 1, { timeoutMs: 3000 });
    expect(term.input).toEqual(['ls\r']);
    expect(term.sizes).toEqual([[100, 30]]);
    term.emit('\x1b[2Jherdr');
    await waitFor(() => got.join('') === '\x1b[2Jherdr', { timeoutMs: 3000 });

    // Closing the page ends the terminal's client; the root herdr server keeps running.
    ws!.close();
    await waitFor(() => term.killed, { timeoutMs: 3000 });
  });

  it('closes the socket when the terminal\'s program ends', async () => {
    const { a, terminals } = await start();
    const { ws } = await connect(socketUrl(a, `ticket=${await ticket(a, await a.login())}&cols=80&rows=24`), { origin: origin(a) });
    await waitFor(() => terminals.length === 1, { timeoutMs: 3000 });
    let closed = false;
    ws!.onclose = () => { closed = true; };
    terminals[0]!.exit(0);
    await waitFor(() => closed, { timeoutMs: 3000 });
  });

  it('a ticket needs an admin\'s UI session, opens one socket, from a UI origin only', async () => {
    const { a, terminals } = await start();
    expect((await a.ui('/ui/api/herdr-terminal/ticket', {})).status).toBe(403);
    const token = await a.login();
    expect((await connect(socketUrl(a, 'cols=80&rows=24'), { origin: origin(a) })).refused).toBe(true);
    expect((await connect(socketUrl(a, 'ticket=0000&cols=80&rows=24'), { origin: origin(a) })).refused).toBe(true);
    const foreign = await ticket(a, token);
    expect((await connect(socketUrl(a, `ticket=${foreign}&cols=80&rows=24`), { origin: 'http://evil.example' })).refused).toBe(true);
    const once = await ticket(a, token);
    const first = await connect(socketUrl(a, `ticket=${once}&cols=80&rows=24`), { origin: origin(a) });
    expect(first.ws).toBeDefined();
    expect((await connect(socketUrl(a, `ticket=${once}&cols=80&rows=24`), { origin: origin(a) })).refused).toBe(true);
    // The ticket refused for its origin was used up by that refusal.
    expect((await connect(socketUrl(a, `ticket=${foreign}&cols=80&rows=24`), { origin: origin(a) })).refused).toBe(true);
    expect(terminals).toHaveLength(1);
    first.ws!.close();
  });
});
