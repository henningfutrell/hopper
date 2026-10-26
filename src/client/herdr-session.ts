// A Windows client's own herdr session (issue #2802): herdr opens a pane in the machine's default shell, PowerShell on
// Windows, and every pane command of the hopper is POSIX shell (issue #367). So a client on Windows starts the herdr server
// of its session itself, when none runs, with a herdr config of the client's own whose default shell is Git Bash, as a
// login shell that stays in the pane's cwd (CHERE_INVOKING). That config was a person's own work outside the hopper
// before, and a reinstall lost it. Imports nothing of hopper: a client target runs it as a plain file.
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

/** The herdr config file the client writes into its client dir at each start. */
export const HERDR_CONFIG_FILE = 'herdr-config.toml';

/** What herdr says when no server of the session runs. */
export const SERVER_NOT_RUNNING = /server_not_running|no herdr server is running/;

/** How long a server the client started has to answer. */
const SERVER_START_MS = 10_000;
const SERVER_POLL_MS = 250;

type Env = Readonly<Record<string, string | undefined>>;

/** A variable of a Windows environment, whose names are not case sensitive (`Path`). */
const varOf = (env: Env, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

/**
 * Git Bash's bash.exe on this Windows machine, else undefined: the bash of the Git for Windows whose sh.exe is on the
 * PATH (the client's fixed scripts run that sh), else of Git for Windows in its usual install dirs. Never a bash.exe under
 * the Windows dir: that one is WSL's.
 */
export function gitBashOf(env: Env, exists: (path: string) => boolean = existsSync): string | undefined {
  const windows = (varOf(env, 'SYSTEMROOT') ?? 'C:\\Windows').toLowerCase();
  const roots: string[] = [];
  for (const dir of (varOf(env, 'PATH') ?? '').split(';').filter(Boolean)) {
    if (dir.toLowerCase().startsWith(windows) || !exists(win32.join(dir, 'sh.exe'))) continue;
    const m = /^(.*?)\\(?:usr\\)?bin\\?$/i.exec(dir);
    if (m) roots.push(m[1]!);
  }
  for (const base of [varOf(env, 'PROGRAMFILES'), varOf(env, 'PROGRAMW6432'), varOf(env, 'LOCALAPPDATA') && win32.join(varOf(env, 'LOCALAPPDATA')!, 'Programs')]) {
    if (base) roots.push(win32.join(base, 'Git'));
  }
  return roots.flatMap((r) => [win32.join(r, 'bin', 'bash.exe'), win32.join(r, 'usr', 'bin', 'bash.exe')]).find(exists);
}

/** The client's herdr config: Git Bash as the default shell, a login shell, so /etc/profile sets its PATH. */
export function herdrConfigText(bash: string): string {
  return [
    '# Written by the hopper client at each start (issue #2802): the herdr session the hopper\'s jobs run in opens its',
    '# panes in a POSIX shell. Do not edit: the next start writes it again.',
    '[terminal]',
    `default_shell = ${JSON.stringify(bash)}`,
    'shell_mode = "login"',
    '',
  ].join('\n');
}

/** The client's own herdr session: the environment its herdr calls and its server run with, and the start of its server. */
export interface OwnHerdr {
  env: Record<string, string | undefined>;
  /** Starts the session's herdr server, and resolves when it answers (or after SERVER_START_MS). */
  start(): Promise<void>;
}

export interface OwnHerdrOptions {
  platform: string;
  env: Env;
  /** The client dir: the config goes there. */
  dir: string;
  herdrBin: string;
  session: string;
  exists?: (path: string) => boolean;
  write?: (file: string, text: string) => void;
}

/**
 * On Windows, the client's own herdr session; elsewhere, or when the machine names its own herdr config
 * (HERDR_CONFIG_PATH) or has no Git Bash, none. `said`: the line the client says at start, if any.
 */
export function ownHerdrOf(o: OwnHerdrOptions): { own?: OwnHerdr; said?: string } {
  if (o.platform !== 'win32') return {};
  const mine = varOf(o.env, 'HERDR_CONFIG_PATH');
  if (mine) return { said: `hopper-client: herdr session ${o.session} uses the herdr config ${mine}: its default shell must be a POSIX shell` };
  const bash = gitBashOf(o.env, o.exists);
  if (!bash) {
    return { said: `hopper-client: no Git Bash (bash.exe of Git for Windows) found: herdr session ${o.session} opens its panes in PowerShell, and every job on this machine fails. Install Git for Windows, then start the client again` };
  }
  const config = join(o.dir, HERDR_CONFIG_FILE);
  (o.write ?? ((f, t) => writeFileSync(f, t)))(config, herdrConfigText(bash));
  const env = { ...o.env, HERDR_CONFIG_PATH: config, CHERE_INVOKING: '1' };
  let starting: Promise<void> | undefined;
  const start = (): Promise<void> => (starting ??= startServer(o.herdrBin, o.session, env).finally(() => { starting = undefined; }));
  return { own: { env, start }, said: `hopper-client: herdr session ${o.session} opens its panes in Git Bash (${bash}); the client starts its server when none runs` };
}

const answers = (bin: string, session: string, env: OwnHerdr['env']): Promise<boolean> => new Promise((resolve) => {
  execFile(bin, ['--session', session, 'workspace', 'list'], { env, timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve(!SERVER_NOT_RUNNING.test(`${stdout}${stderr}`) && !(err && (err as NodeJS.ErrnoException).code === 'ENOENT'));
  });
});

/** `herdr --session <session> server`, detached, so it outlives the client's restarts; its jobs' panes run in it. */
async function startServer(bin: string, session: string, env: OwnHerdr['env']): Promise<void> {
  if (await answers(bin, session, env)) return;
  const child = spawn(bin, ['--session', session, 'server'], { env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  for (let waited = 0; waited < SERVER_START_MS; waited += SERVER_POLL_MS) {
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
    if (await answers(bin, session, env)) return;
  }
}
