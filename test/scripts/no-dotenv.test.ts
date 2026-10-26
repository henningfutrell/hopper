// No install, update or run path reads or writes a .env (issue #1960; the rule: issues #894, #970, #1372). Each path the
// repo ships runs in a throwaway home with its tools stubbed, as its own tests run it, with a sentinel .env in each folder
// it works in (test/support/no-dotenv.ts): the run must leave the sentinel unread and unchanged, make no .env, and keep
// every secret it was given at launch (the master key, a tunnel credential, a token) out of every file it writes.
//
// Feature: no .env on any install, update or run path
//   Scenario: the curl install (get.sh)
//   Scenario: the compose install under the user service (hopper-service.sh install), and its start and stop
//   Scenario: the update script (update.sh), which runs `hopper update carry`, also when the service owns the stack
//   Scenario: the move onto a cluster (hopper-cluster.sh migrate)
//   Scenario: the Helm chart, rendered
//   Scenario: the files the hopper runs from name no .env
//   Scenario: a .env write or read put back into a path fails the check
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { host, KEY as CLUSTER_KEY, migrate, removeHosts } from '../support/hopper-cluster.ts';
import { render } from '../support/helm-chart.ts';
import { dirs as serviceDirs, folder, KEY as SERVICE_KEY } from '../support/hopper-service-script.ts';
import { breaches, plant } from '../support/no-dotenv.ts';
import { dirs as updateDirs, IMAGE, KEY as UPDATE_KEY, update } from '../support/update-script.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const TUNNEL = 'tunnel-credential-given-at-launch';
const TOKEN = 'oauth-token-given-at-launch';
const dirs: string[] = [];

afterEach(() => {
  removeHosts();
  for (const d of [...dirs.splice(0), ...serviceDirs.splice(0), ...updateDirs.splice(0)]) rmSync(d, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

describe('the curl install (scripts/get.sh)', () => {
  it('reads and writes no .env, and puts no secret given at launch in a file', () => {
    const dir = scratch('jh-dotenv-get-');
    const [bin, home, work, origin] = ['bin', 'home', 'work', 'origin.git'].map((d) => join(dir, d)) as [string, string, string, string];
    for (const d of [bin, home, work]) mkdirSync(d);
    const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    execFileSync('/usr/bin/git', ['init', '-q', '--bare', '-b', 'stable', origin]);
    git(work, 'init', '-q', '-b', 'stable');
    mkdirSync(join(work, 'scripts'));
    mkdirSync(join(work, 'deploy'));
    writeFileSync(join(work, 'deploy', 'compose.yaml'), 'name: hopper\n');
    // The source's install.sh records only that it ran: its own install is the host install, with daemon.env.
    writeFileSync(join(work, 'scripts', 'install.sh'), `echo ran > "${dir}/install-ran"\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'a');
    git(work, 'push', '-q', origin, 'HEAD:stable');
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'systemctl'), 0o755);
    const s = plant(home, dir);
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'get.sh')], {
      cwd: dir, encoding: 'utf8',
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, HOPPER_SOURCE_REPO: origin,
        HOPPER_DATABASE_URL: 'postgres://u:p@db:5432/hopper', HOPPER_MASTER_KEY: SERVICE_KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'install-ran'), 'utf8')).toBe('ran\n');
    expect(breaches(s, { roots: [dir], seen: [r.stdout, r.stderr], secrets: [SERVICE_KEY, TOKEN] })).toEqual([]);
  });
});

describe('the compose install under the user service (scripts/hopper-service.sh)', () => {
  it('install, start with the systemd credential, and stop read and write no .env, and leave the key in no file', () => {
    const f = folder();
    const creds = join(f.dir, '.creds');
    mkdirSync(creds);
    writeFileSync(join(creds, 'hopper-master-key'), `${SERVICE_KEY}\n`);
    const s = plant(f.dir, f.home);
    const launch = { HOPPER_MASTER_KEY: SERVICE_KEY, HOPPER_TUNNEL_KEY: TUNNEL, CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    const install = f.run(['install'], { HOPPER_BIND: '0.0.0.0', ...launch });
    expect(install.status, install.err).toBe(0);
    const start = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', CREDENTIALS_DIRECTORY: creds, STUB_DATA: '1' });
    expect(start.status, start.err).toBe(0);
    expect(f.calls()).toContain(`podman compose -p hopper up -d | key= | file=${SERVICE_KEY} at /run/hopper-master-key`);
    const stop = f.run(['stop'], { HOPPER_SERVICE_COMPOSE: 'podman compose' });
    expect(stop.status, stop.err).toBe(0);
    // The key's file is in memory while the stack runs (issue #1487); the stop removes it.
    expect(breaches(s, { roots: [f.dir, f.runtime], seen: [install.err, start.err, stop.err, ...f.calls()], secrets: [SERVICE_KEY, TUNNEL, TOKEN] })).toEqual([]);
  });
});

describe('the update (scripts/update.sh and hopper update carry)', () => {
  const compose = (): string => readFileSync(join(ROOT, 'compose.yaml'), 'utf8')
    .replace('${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:latest}', `\${HOPPER_IMAGE:-${IMAGE}}`);

  it('reads and writes no .env: the install\'s own settings go into compose.yaml, the key into no file', () => {
    const dir = scratch('jh-dotenv-update-');
    writeFileSync(join(dir, 'compose.yaml'), compose().replace(/^ {6}- "\$\{HOPPER_BIND[^\n]*$/m, '      - "0.0.0.0:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}"'));
    const s = plant(dir);
    const r = update({ dir, masterKey: UPDATE_KEY, stack: 'podman-compose', env: { HOPPER_TUNNEL_KEY: TUNNEL, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.some((c) => c.includes(' hopper update carry'))).toBe(true);
    // The bind address the install set is carried into the new compose.yaml itself.
    expect(r.read('compose.yaml')).toContain('HOPPER_BIND:-0.0.0.0');
    expect(breaches(s, { roots: [dir], seen: [r.out, ...r.calls], secrets: [UPDATE_KEY, TUNNEL, TOKEN] })).toEqual([]);
  });

  it('reads and writes no .env when hopper-compose.service owns the stack and the key is sealed to this host', () => {
    const dir = scratch('jh-dotenv-update-service-');
    writeFileSync(join(dir, 'compose.yaml'), compose());
    const s = plant(dir);
    const env = { HOPPER_KEY_SEAL: 'kek', XDG_CONFIG_HOME: join(dir, '.config') };
    writeFileSync(join(dir, 'master-key.sh'), readFileSync(join(ROOT, 'scripts', 'master-key.sh'), 'utf8'));
    writeFileSync(join(dir, 'hopper-service.sh'), '# an older hopper-service.sh\n');
    const sealed = spawnSync('/bin/bash', ['master-key.sh', 'seal'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, ...env, HOPPER_MASTER_KEY: UPDATE_KEY } });
    expect(sealed.status, sealed.stderr).toBe(0);
    const r = update({ dir, stack: 'podman-compose', tools: ['bash', 'openssl', 'id', 'dirname', 'mkdir'], env, service: true });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain('systemctl --user restart hopper-compose.service');
    expect(breaches(s, { roots: [dir], seen: [sealed.stdout, sealed.stderr, r.out, ...r.calls], secrets: [UPDATE_KEY] })).toEqual([]);
  });
});

describe('the move onto a cluster (scripts/hopper-cluster.sh)', () => {
  it('migrate reads and writes no .env: the key and the carried token go on pipes, into no file', () => {
    const h = host({ unit: true });
    const s = plant(h.dir, h.home);
    const r = migrate(h, { STUB_LAUNCH_KEY: CLUSTER_KEY });
    expect(r.status, r.err).toBe(0);
    // The stub's launch environment carries CLAUDE_CODE_OAUTH_TOKEN=tok-123: it goes to a Secret on a pipe.
    expect(h.calls()).toContain('carried: CLAUDE_CODE_OAUTH_TOKEN=tok-123');
    expect(breaches(s, { roots: [h.dir], seen: [r.out, r.err, ...h.calls()], secrets: [CLUSTER_KEY, 'tok-123'] })).toEqual([]);
  });
});

describe('the Helm chart', () => {
  // `helm template` runs in the test, under the suite's load (issue #2831): it took more than 15 s on CI.
  it('renders no .env: no mount, argument or value names one, and the master key comes from a Secret', () => {
    const rs = render();
    expect(JSON.stringify(rs)).not.toMatch(/(^|[\s"'/=])\.env\b/);
    for (const r of rs) {
      for (const c of [...(r.spec?.template?.spec.containers ?? []), ...(r.spec?.template?.spec.initContainers ?? [])]) {
        // A secret is a Secret's key or a file mounted from one (`…_FILE`), never a value in the manifest.
        for (const e of c.env ?? []) if (/^HOPPER_MASTER_KEY$|(KEY|TOKEN|PASSWORD|SECRET)$/.test(e.name)) expect(e.value, `${r.metadata.name}/${c.name} ${e.name}`).toBeUndefined();
      }
    }
  }, 60_000);
});

describe('the files the hopper runs from', () => {
  const lines = (file: string) => readFileSync(join(ROOT, file), 'utf8').split('\n').map((l, i) => ({ at: `${file}:${i + 1}`, l }));
  const sources = (dir: string): string[] => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|sh|ps1|cmd)$/.test(f)).map((f) => join(dir, f));

  it('name no env file for compose, node or the image: no env_file, --env-file or loadEnvFile', () => {
    const files = ['compose.yaml', 'deploy/compose.yaml', 'Dockerfile', 'package.json', ...readdirSync(join(ROOT, 'systemd')).map((f) => `systemd/${f}`), ...sources('src'), ...sources('scripts')];
    const found = files.flatMap(lines).filter(({ l }) => /^\s*env_file\s*:|--env-file|loadEnvFile\(/.test(l)).map(({ at }) => at);
    expect(found).toEqual([]);
  });

  it('no test of the update says a .env is written: a mention of .env is one that says there is none', () => {
    const found = readdirSync(join(ROOT, 'test', 'update')).flatMap((f) => lines(`test/update/${f}`))
      .filter(({ l }) => /(^|[\s`'"(])\.env\b/.test(l) && !/\b(no|never|not|none)\b/i.test(l)).map(({ at, l }) => `${at}: ${l.trim()}`);
    expect(found).toEqual([]);
  });
});

describe('the check itself', () => {
  // The same install as above, with one line put back at the top of hopper-service.sh.
  const withLine = (line: string) => {
    const f = folder();
    const script = readFileSync(join(f.dir, 'hopper-service.sh'), 'utf8').split('\n');
    writeFileSync(join(f.dir, 'hopper-service.sh'), [script[0], line, ...script.slice(1)].join('\n'));
    const s = plant(f.dir, f.home);
    const r = f.run(['install'], { HOPPER_MASTER_KEY: SERVICE_KEY });
    return { found: breaches(s, { roots: [f.dir, f.runtime], seen: [r.err, ...f.calls()], secrets: [SERVICE_KEY] }), atime: s.atime };
  };

  it('fails a path that writes a .env', () => {
    expect(withLine('printf "HOPPER_BIND=0.0.0.0\\n" >> .env').found).toEqual([expect.stringMatching(/\.env: changed$/)]);
    expect(withLine('mkdir -p .home/stack && printf "HOPPER_PORT=4790\\n" > .home/stack/.env').found).toEqual([expect.stringMatching(/stack\/\.env: a \.env made$/)]);
  });

  it('fails a path that reads a .env', () => {
    const { found, atime } = withLine('set -a; . ./.env; set +a');
    expect(found).toContain('the output or a call holds a value of a sentinel .env');
    // On a file system that keeps access times, the read itself is seen, whatever the path does with the values.
    if (atime) expect(found.filter((b) => b.endsWith('/.env: read'))).toHaveLength(1);
    if (atime) expect(withLine('cat .env >/dev/null').found).toEqual([expect.stringMatching(/\/\.env: read$/)]);
  });

  it('fails a path that writes a secret given at launch into a file', () => {
    expect(withLine('printf "%s" "$HOPPER_MASTER_KEY" > kept-key').found).toEqual([expect.stringMatching(/kept-key: holds a secret given at launch$/)]);
  });
});
