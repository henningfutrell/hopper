// The rename from job-hopper to hopper on the hopper's host (issue #112, design.md "Rename from
// job-hopper"): an install from before it is moved to the new names, its state kept, and the herdr
// session is stopped only when no job holds a pane in it.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handover, moveState, paneJobs, removeOldInstall, renameAuthorizedKeys, renameBoot, renameEnvText, renamePaths,
} from '../../src/update/rename.ts';
import type { Job } from '../../src/domain/types.ts';
import { useTempDirs } from '../plugins/support.ts';
import { spec, useTempStore } from '../store/helpers.ts';
import { installFromBefore } from '../support/database.ts';

const temp = useTempDirs();
const stores = useTempStore();

function oldInstall() {
  const home = temp();
  const paths = renamePaths({}, home);
  const at = (...p: string[]) => join(home, ...p);
  mkdirSync(at('.config', 'job-hopper', 'clients'), { recursive: true });
  writeFileSync(at('.config', 'job-hopper', 'daemon.env'), [
    '# the hopper',
    'JOB_HOPPER_DATABASE_URL=postgres://u:p@127.0.0.1:5433/hopper',
    `CLIENT_TOKEN_LAPTOP_FILE=${at('.config', 'job-hopper', 'clients', 'laptop.token')}`,
    'JOB_HOPPER_PORT=4791',
    'GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem',
    '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(at('.config', 'job-hopper', 'clients', 'laptop.token'), 'secret\n', { mode: 0o600 });
  mkdirSync(at('.cache', 'job-hopper', 'clients'), { recursive: true });
  writeFileSync(at('.cache', 'job-hopper', 'known_hosts'), 'pinned\n');
  mkdirSync(at('.config', 'systemd', 'user'), { recursive: true });
  for (const u of ['job-hopper.service', 'job-hopper-herdr.service']) writeFileSync(at('.config', 'systemd', 'user', u), `[Unit]\n${u}\n`);
  const lib = at('.local', 'lib', 'job-hopper');
  mkdirSync(join(lib, 'src'), { recursive: true });
  mkdirSync(join(lib, 'systemd'), { recursive: true });
  writeFileSync(join(lib, 'src', 'cli.ts'), '// cli\n');
  for (const u of ['hopper.service', 'hopper-herdr.service']) writeFileSync(join(lib, 'systemd', u), `[Unit]\n${u}\n`);
  mkdirSync(`${lib}.prev`);
  mkdirSync(at('.local', 'bin'), { recursive: true });
  symlinkSync(join(lib, 'src', 'cli.ts'), at('.local', 'bin', 'job-hopper'));
  mkdirSync(at('.ssh'), { recursive: true });
  writeFileSync(at('.ssh', 'authorized_keys'), [
    'ssh-ed25519 AAAAown me@desk',
    `restrict,command="/usr/bin/node ${lib}/src/client/relay.ts ${at('.cache', 'job-hopper', 'clients', 'laptop.sock')}" ssh-ed25519 AAAAclient job-hopper-client:laptop`,
    '',
  ].join('\n'), { mode: 0o600 });
  const calls: string[][] = [];
  const systemctl = async (args: string[]) => { calls.push(args); };
  const lines: string[] = [];
  return { home, paths, at, lib, calls, systemctl, lines, log: (l: string) => lines.push(l) };
}

describe('the daemon.env and authorized_keys rewrites', () => {
  const paths = renamePaths({}, '/h');
  it('renames every old key, and points values at the moved dirs; other lines kept', () => {
    const text = 'JOB_HOPPER_PORT=4790\n# JOB_HOPPER_X=1\nX_FILE=/h/.config/job-hopper/clients/a.token\nY=/h/.config/job-hopper-other\nZ=/h/.cache/job-hopper\n';
    expect(renameEnvText(text, paths)).toBe('HOPPER_PORT=4790\n# JOB_HOPPER_X=1\nX_FILE=/h/.config/hopper/clients/a.token\nY=/h/.config/job-hopper-other\nZ=/h/.cache/hopper\n');
  });

  it('points only the client targets\' relay lines at the new install and work dir', () => {
    const own = 'ssh-ed25519 AAAA /h/.local/lib/job-hopper/x';
    const client = 'restrict,command="node /h/.local/lib/job-hopper/src/client/relay.ts /h/.cache/job-hopper/clients/a.sock" ssh-ed25519 AAAA job-hopper-client:a';
    expect(renameAuthorizedKeys(`${own}\n${client}\n`, paths)).toBe(
      `${own}\nrestrict,command="node /h/.local/lib/hopper/src/client/relay.ts /h/.cache/hopper/clients/a.sock" ssh-ed25519 AAAA hopper-client:a\n`,
    );
  });
});

describe('paneJobs', () => {
  const job = (id: string, executorState?: Record<string, unknown>) => ({ id, status: 'running', executorState }) as unknown as Job;
  it('only jobs in this machine\'s old herdr session', () => {
    expect(paneJobs([
      job('a', { session: 'job-hopper', paneId: 'p' }),
      job('b', { session: 'job-hopper', ssh: 'box' }),
      job('c', { session: 'job-hopper-client', client: { machine: 'l', tokenEnv: 'T' } }),
      job('d', { session: 'hopper' }),
      job('e'),
    ])).toEqual(['job a (running)']);
  });
});

describe('moveState', () => {
  it('stops the old daemon, moves config and work dir, rewrites daemon.env and the relay lines, removes old units and the CLI link', async () => {
    const t = oldInstall();
    await moveState({ paths: t.paths, systemctl: t.systemctl, log: t.log });
    expect(t.calls[0]).toEqual(['stop', 'job-hopper.service']);
    expect(t.calls).toContainEqual(['disable', '--now', 'job-hopper.service', 'job-hopper-herdr.service']);
    expect(existsSync(t.at('.config', 'job-hopper'))).toBe(false);
    const env = readFileSync(t.at('.config', 'hopper', 'daemon.env'), 'utf8');
    expect(env).toContain('HOPPER_DATABASE_URL=postgres://u:p@127.0.0.1:5433/hopper\n');
    expect(env).toContain(`CLIENT_TOKEN_LAPTOP_FILE=${t.at('.config', 'hopper', 'clients', 'laptop.token')}\n`);
    expect(env).not.toMatch(/JOB_HOPPER/);
    expect(statSync(t.at('.config', 'hopper', 'daemon.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(t.at('.config', 'hopper', 'clients', 'laptop.token'), 'utf8')).toBe('secret\n');
    expect(readFileSync(t.at('.cache', 'hopper', 'known_hosts'), 'utf8')).toBe('pinned\n');
    expect(readFileSync(t.at('.ssh', 'authorized_keys'), 'utf8')).toContain(`${t.at('.local', 'lib', 'hopper')}/src/client/relay.ts ${t.at('.cache', 'hopper', 'clients', 'laptop.sock')}" ssh-ed25519 AAAAclient hopper-client:laptop`);
    expect(existsSync(t.at('.config', 'systemd', 'user', 'job-hopper.service'))).toBe(false);
    expect(existsSync(t.at('.local', 'bin', 'job-hopper'))).toBe(false);
  });

  it('a second run changes nothing; both dirs present are reported, not merged', async () => {
    const t = oldInstall();
    await moveState({ paths: t.paths, systemctl: t.systemctl, log: t.log });
    mkdirSync(t.at('.config', 'job-hopper'));
    await moveState({ paths: t.paths, systemctl: t.systemctl, log: t.log });
    expect(t.lines.at(-2)).toMatch(/kept beside .*both exist, nothing merged/);
    expect(existsSync(t.at('.config', 'job-hopper'))).toBe(true);
    expect(readFileSync(t.at('.config', 'hopper', 'daemon.env'), 'utf8')).toContain('HOPPER_PORT=4791');
  });
});

describe('handover (the self-update half)', () => {
  it('copies the install, installs and starts the new units, links the CLI, then removes the old install dir', async () => {
    const t = oldInstall();
    let port = 0;
    const ok = await handover({ paths: t.paths, systemctl: t.systemctl, log: t.log, appDir: t.lib, healthy: async (p) => { port = p; return true; } });
    expect(ok).toBe(true);
    expect(port).toBe(4791);
    const newLib = t.at('.local', 'lib', 'hopper');
    expect(readFileSync(join(newLib, 'src', 'cli.ts'), 'utf8')).toBe('// cli\n');
    expect(readlinkSync(t.at('.local', 'bin', 'hopper'))).toBe(join(newLib, 'src', 'cli.ts'));
    expect(readFileSync(t.at('.config', 'systemd', 'user', 'hopper-herdr.service'), 'utf8')).toBe('[Unit]\nhopper-herdr.service\n');
    expect(t.calls.slice(-3)).toEqual([['enable', 'hopper-herdr.service', 'hopper.service'], ['start', 'hopper-herdr.service'], ['restart', 'hopper.service']]);
    expect(existsSync(t.lib)).toBe(false);
    expect(existsSync(`${t.lib}.prev`)).toBe(false);
  });

  it('a new daemon that does not answer: the old install dir stays', async () => {
    const t = oldInstall();
    expect(await handover({ paths: t.paths, systemctl: t.systemctl, log: t.log, appDir: t.lib, healthy: async () => false })).toBe(false);
    expect(existsSync(t.lib)).toBe(true);
    expect(t.lines.at(-1)).toMatch(/does not answer; kept/);
    removeOldInstall({ paths: t.paths, log: t.log });
    expect(lstatSync(t.at('.local', 'lib', 'hopper')).isDirectory()).toBe(true);
    expect(existsSync(t.lib)).toBe(false);
  });
});

describe('renameBoot (the first boot of a job-hopper install\'s self-update)', () => {
  it('no old variables: nothing to do', () => {
    expect(renameBoot({ env: { HOPPER_DATABASE_URL: 'postgres://x' }, appDir: '/a/hopper', log: () => {} })).toBe('none');
  });

  it('old variables outside a job-hopper unit: an error naming them', () => {
    expect(() => renameBoot({ env: { JOB_HOPPER_DATABASE_URL: 'postgres://x', JOB_HOPPER_PORT: '1' }, appDir: '/a/app', log: () => {} }))
      .toThrow(/JOB_HOPPER_DATABASE_URL, JOB_HOPPER_PORT set, and no HOPPER_DATABASE_URL: rename every JOB_HOPPER_\* variable/);
  });

  function swapped() {
    const t = oldInstall();
    writeFileSync(join(t.lib, 'new'), '');
    writeFileSync(join(`${t.lib}.prev`, 'old'), '');
    const url = installFromBefore(stores.url());
    const work = t.at('.cache', 'job-hopper');
    mkdirSync(join(work, 'update'), { recursive: true });
    writeFileSync(join(work, 'update', 'pending.json'), JSON.stringify({ from: 'a', to: 'b'.repeat(40), ref: 'main' }));
    const env = { INVOCATION_ID: 'x', JOB_HOPPER_DATABASE_URL: url, JOB_HOPPER_WORK_DIR: work };
    return { ...t, url, work, env };
  }

  it('no job holds a pane in the old session: hands over', () => {
    const t = swapped();
    const started: string[] = [];
    expect(renameBoot({ env: t.env, appDir: t.lib, log: t.log, start: (d) => started.push(d) })).toBe('handover');
    expect(started).toEqual([t.lib]);
    expect(existsSync(join(t.lib, 'new'))).toBe(true);
  });

  it('a job holds a pane there: the previous install back, the update recorded as failed with why', () => {
    const t = swapped();
    const store = stores.open(t.url);
    const job = store.jobs.create(spec, 50);
    store.jobs.update(job.id, { status: 'waiting_answer', executorState: { session: 'job-hopper', paneId: 'w1:p1' } });
    store.close();
    const started: string[] = [];
    expect(renameBoot({ env: t.env, appDir: t.lib, log: t.log, start: (d) => started.push(d) })).toBe('rollback');
    expect(started).toEqual([]);
    expect(existsSync(join(t.lib, 'old'))).toBe(true);
    expect(existsSync(join(`${t.lib}.next`, 'new'))).toBe(true);
    expect(existsSync(join(t.work, 'update', 'pending.json'))).toBe(false);
    const after = stores.open(t.url);
    const [failed] = after.events.recent(1, ['update.failed']);
    after.close();
    expect(failed?.data).toEqual({ to: 'b'.repeat(40), error: expect.stringMatching(new RegExp(`waits for job ${job.id} \\(waiting_answer\\): it holds a pane in herdr session job-hopper`)) });
  });
});
