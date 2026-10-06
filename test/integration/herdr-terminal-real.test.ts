// Issue #189 end to end, nothing doubled: the real composition root, the real WebSocket, a real
// pseudo-terminal running the real herdr as the root herdr, and a real machine — an alpine container
// running OpenSSH and a herdr session (this machine's herdr binary, mounted: it is static), with the
// hopper's key installed `restrict` as attach-machine.sh installs it. The root herdr saves the machine
// through the ssh wrapper and reaches its herdr; the browser's terminal draws its sidebar.
// Skipped where herdr is not installed. Needs docker, like the other real-container tests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const herdrBin = (() => { try { return execFileSync('sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const CONTAINER = `jh-it-herdr-terminal-${process.pid}`;
const ALIAS = `jh-herdr-box-${process.pid}`;
let dir: string;
let hostKey: string;
let keyFile: string;
let configDir: string;

const keygen = (file: string): string => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', file]);
  return readFileSync(`${file}.pub`, 'utf8').trim();
};

describe.skipIf(!herdrBin)('the herdr terminal, for real', () => {
  let t: TestApp | undefined;
  let cleanup: (() => void) | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-herdr-terminal-'));
    keyFile = join(dir, 'hopper');
    configDir = mkdtempSync(join(tmpdir(), 'c'));
    const hopperKey = keygen(keyFile);
    const script = [
      'apk add --no-cache openssh >/dev/null',
      'ssh-keygen -A >/dev/null',
      // No password, and not locked (adduser -D locks it, and sshd refuses a locked account).
      "adduser -D -s /bin/sh hopper && sed -i 's/^hopper:!/hopper:*/' /etc/shadow",
      'mkdir -p /home/hopper/.ssh && printf "%s\\n" "$AUTH" > /home/hopper/.ssh/authorized_keys',
      'chown -R hopper /home/hopper/.ssh && chmod 700 /home/hopper/.ssh && chmod 600 /home/hopper/.ssh/authorized_keys',
      'exec /usr/sbin/sshd -D -e',
    ].join(' && ');
    execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-e', `AUTH=restrict ${hopperKey} hopper`, '-v', `${herdrBin}:/usr/local/bin/herdr:ro`, '-p', '127.0.0.1::22', 'alpine:latest', 'sh', '-c', script]);
    // The machine's herdr session, started as its user with its own environment (as hopper-herdr.service does).
    await waitFor(() => { try { return execFileSync('docker', ['exec', CONTAINER, 'test', '-f', '/home/hopper/.ssh/authorized_keys']) !== undefined; } catch { return false; } }, { timeoutMs: 90000, what: 'the container\'s user' });
    execFileSync('docker', ['exec', '-d', '-u', 'hopper', '-w', '/home/hopper', CONTAINER, 'setsid', 'herdr', '--session', 'hopper', 'server']);
    const port = execFileSync('docker', ['port', CONTAINER, '22/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
    hostKey = await waitFor(() => {
      try {
        const key = execFileSync('docker', ['exec', CONTAINER, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ').slice(0, 2).join(' ');
        const running = execFileSync('docker', ['exec', '-u', 'hopper', CONTAINER, 'herdr', '--session', 'hopper', 'status', 'server'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const logs = execFileSync('sh', ['-c', `docker logs ${CONTAINER} 2>&1`], { encoding: 'utf8' });
        return /status: running/.test(running) && /Server listening/.test(logs) ? key : undefined;
      } catch { return undefined; }
    }, { timeoutMs: 90000, what: 'sshd and herdr in the container' });
    mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
    writeFileSync(join(homedir(), '.ssh', 'config'), `Host ${ALIAS}\n  HostName 127.0.0.1\n  Port ${port}\n  User hopper\n`, { mode: 0o600 });
  }, 120000);

  afterAll(async () => {
    await t?.stop();
    if (t) {
      const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: join(t.dataDir, 'herdr-terminal', 'state') };
      try { execFileSync(herdrBin, ['--session', 'hopper-root', 'server', 'stop'], { env, stdio: 'ignore', timeout: 10000 }); } catch { /* not running */ }
    }
    cleanup?.();
    try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('the root herdr lists the machine\'s herdr and reaches it through the hopper\'s key; the page\'s terminal draws it', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({
      dbPath: db.dbPath,
      // herdr's sockets must fit a unix socket path (108 bytes): a short config dir, not the deep test HOME.
      secrets: { HOPPER_SSH_KEY_FILE: keyFile, HOME: homedir(), XDG_CONFIG_HOME: configDir },
      plugins: { machines: [{ name: 'local', plugin: 'local' }, { name: 'box', plugin: 'ssh', options: { ssh: ALIAS, hostKey, herdrBin: '/usr/local/bin/herdr' } }] },
      seams: { machineProbe: async () => ({ online: true }) },
    });
    const a = t;
    const token = await a.login();
    const { body } = await a.ui<{ ticket: string }>('/ui/api/herdr-terminal/ticket', {}, { token });
    // The browser's side, headless: the frames drawn on an xterm.js terminal of the size asked for.
    const term = new xtermHeadless.Terminal({ cols: 160, rows: 40, allowProposedApi: true });
    let frames = 0;
    const rows = (): string[] => Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '');
    const ws = new WebSocket(`${a.url.replace(/^http/, 'ws')}/ui/api/herdr-terminal/socket?ticket=${body.ticket}&cols=160&rows=40`, { headers: { origin: new URL(a.url).origin } } as unknown as string[]);
    ws.onmessage = (e) => { frames++; term.write(String(e.data)); };
    await waitFor(() => ws.readyState === WebSocket.OPEN, { timeoutMs: 10000, what: 'the socket' });
    // herdr saved the machine in the terminal's own state, and reaches its herdr over the wrapper.
    const status = await waitFor(async () => {
      const r = await a.api<{ machines: { name: string; sync?: string; error?: string }[] }>('GET', '/api/herdr-terminal');
      return r.body.machines.find((m) => m.name === 'box' && m.sync) ;
    }, { timeoutMs: 90000, what: 'the saved machine' });
    expect(status).toEqual({ name: 'box', label: 'box', listed: true, sync: 'saved' });
    const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: join(a.dataDir, 'herdr-terminal', 'state'), PATH: `${join(a.dataDir, 'herdr-terminal', 'bin')}:${process.env.PATH ?? ''}` };
    const panes = execFileSync(herdrBin, ['--machine', 'box', 'pane', 'list'], { env, encoding: 'utf8', timeout: 30000 });
    expect(panes).toContain('pane');
    // The page's terminal is the root herdr's screen: its sidebar names the machine.
    try {
      await waitFor(() => rows().some((r) => /\bbox\b/.test(r)) && rows().some((r) => /Local/.test(r)), { timeoutMs: 30000, what: 'Local and the machine in the sidebar' });
    } catch (e) {
      console.error(rows().join("\n"));
      throw e;
    }
    // Resized with the page: the root herdr redraws at the new size.
    const before = frames;
    term.resize(120, 30);
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
    await waitFor(() => frames > before, { timeoutMs: 10000, what: 'a redraw after resize' });
    term.dispose();
    ws.close();
  }, 180000);
});
