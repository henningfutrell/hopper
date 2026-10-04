// systemd/job-hopper.service sets process settings only (phase 5 slice 4): every JOB_HOPPER_*
// variable it sets is one the daemon reads, so the installed daemon never warns about its own unit.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const UNIT = fileURLToPath(new URL('../../systemd/job-hopper.service', import.meta.url));
const INSTALL = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));

describe('systemd/job-hopper.service', () => {
  it('sets no JOB_HOPPER_* variable the daemon no longer reads', () => {
    const env = Object.fromEntries(readFileSync(UNIT, 'utf8').split('\n')
      .filter((l) => l.startsWith('Environment=JOB_HOPPER_'))
      .map((l) => { const kv = l.slice('Environment='.length); const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1).replaceAll('%h', '/home/x')]; }));
    expect(Object.keys(env).length).toBeGreaterThan(0);
    // The database comes from the EnvironmentFile (install.sh writes it), never from the unit.
    expect(env).not.toHaveProperty('JOB_HOPPER_DATABASE_URL');
    // Config documents live in the database: the unit names neither file.
    expect(env).not.toHaveProperty('JOB_HOPPER_PLUGINS_FILE');
    expect(env).not.toHaveProperty('JOB_HOPPER_WEBHOOKS_FILE');
    expect(loadConfig({ ...env, JOB_HOPPER_DATABASE_URL: 'postgres://u:p@db:5432/jh'}).leftoverEnv).toEqual({});
  });

  it('binds loopback by default; the database, secrets and LAN settings come from daemon.env (design.md "Reaching the UI across the LAN")', () => {
    const text = readFileSync(UNIT, 'utf8');
    expect(text).not.toMatch(/JOB_HOPPER_HOST/);
    // Required, not optional (no '-'): it holds JOB_HOPPER_DATABASE_URL, without which the daemon does not start.
    expect(text).toMatch(/^EnvironmentFile=%h\/\.config\/job-hopper\/daemon\.env$/m);
  });

  it('restarts the daemon when it exits 75 after a self-update (design.md "Self-update")', () => {
    const text = readFileSync(UNIT, 'utf8');
    expect(text).toMatch(/^SuccessExitStatus=75$/m);
    expect(text).toMatch(/^RestartForceExitStatus=75$/m);
  });

  it('hides the root docker socket from the daemon: docker only through a socket only it may open (issue #59)', () => {
    const text = readFileSync(UNIT, 'utf8');
    expect(text).toMatch(/^InaccessiblePaths=-\/run\/docker\.sock -\/var\/run\/docker\.sock$/m);
  });

  it('the daemon reads the hopper\'s ssh key and its docker socket without warning about them (issue #59)', () => {
    const c = loadConfig({ JOB_HOPPER_DATABASE_URL: 'postgres://u:p@db:5432/jh', JOB_HOPPER_SSH_KEY_FILE: '/run/creds/key', JOB_HOPPER_DOCKER_HOST: 'unix:///run/x.sock' });
    expect(c.leftoverEnv).toEqual({});
  });

  it('install.sh writes no part-choosing variable and no sources.yaml', () => {
    const text = readFileSync(INSTALL, 'utf8');
    expect(text).not.toMatch(/JOB_HOPPER_(EXECUTORS|HERDR_|CLAUDE_|SOURCES_FILE|GH_BIN|LOCAL_LANES|ANSWER_MODEL|JEV_)/);
    expect(text).not.toMatch(/migrate-sources-yaml/);
  });

  it('install.sh writes no secret of the hopper\'s own: no JOB_HOPPER_SECRET_KEY (issue #56)', () => {
    expect(readFileSync(INSTALL, 'utf8')).not.toMatch(/JOB_HOPPER_SECRET_KEY/);
    expect(readFileSync(fileURLToPath(new URL('../../deploy/hopper.env.example', import.meta.url)), 'utf8')).not.toMatch(/JOB_HOPPER_SECRET_KEY/);
  });

  it('install.sh offers Postgres only: no SQLite file, no migrate-local (issue #53)', () => {
    const text = readFileSync(INSTALL, 'utf8');
    expect(text).not.toMatch(/sqlite/i);
    expect(text).not.toMatch(/migrate-local/);
  });
});
