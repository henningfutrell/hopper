// The container install (issue #119): one compose.yaml brings up everything — its Postgres and
// the hopper, which runs jobs in its own herdr session inside its container — with no host install
// and no settings to start. The install page serves it as compose.yaml. Issue #125: the hopper is the
// public image pulled from GitHub's registry, nothing is built, and Podman is the recommended runtime.
// Asserted on the rendered form compose runs (`docker compose config`, the provider `podman compose`
// uses too), from an empty directory: the file as downloaded.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'ghcr.io/henningfutrell/hopper:latest';

interface Service {
  image?: string;
  group_add?: string[];
  security_opt?: string[];
  build?: { context: string };
  environment?: Record<string, string | null>;
  ports?: { host_ip?: string; published?: string; target: number }[];
  volumes?: { source?: string; target: string; read_only?: boolean }[];
  depends_on?: Record<string, { condition: string }>;
  command?: string[];
}
interface Rendered { name: string; services: Record<string, Service & { networks?: Record<string, unknown> }>; volumes: Record<string, unknown>; networks?: Record<string, { name?: string; external?: boolean }> }

/**
 * `docker compose config` of compose.yaml copied alone into a fresh directory, with `launch` (`KEY=value` lines) in the
 * environment compose is launched with — never a `.env` file (issue #894).
 */
function render(launch?: string, env: Record<string, string> = {}): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-'));
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  const given = Object.fromEntries((launch ?? '').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, ...given, ...env },
  });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Rendered;
}

const svc = (r: Rendered, name: string): Service => {
  const s = r.services[name];
  if (!s) throw new Error(`no service ${name}`);
  return s;
};

describe('compose.yaml, downloaded alone and started with no settings', () => {
  const r = render();
  const hopper = svc(r, 'hopper');
  const postgres = svc(r, 'postgres');

  it('is its own project, apart from the host install\'s bundled Postgres (deploy/compose.yaml)', () => {
    expect(r.name).toBe('hopper');
  });

  // Issue #711: one shared network, made by the release compose itself, so `http://hopper:<port>` resolves on it.
  it('makes its own network, named hopper_default whatever the project is called, and every service is on it', () => {
    expect(r.networks?.default).toMatchObject({ name: 'hopper_default' });
    expect(r.networks?.default?.external).toBeFalsy();
    // The hopper is on the tunnel's network too (issue #795); the tunnel on that one alone: no other service, and no box,
    // reaches the tunnel agent. The same for Solr (issue #945): on search's network, with the hopper alone. The read-only
    // boxes' internal network (issue #849): the hopper and the egress proxy.
    const nets: Record<string, string[]> = { hopper: ['default', 'egress', 'search', 'tunnel'], tunnel: ['tunnel'], cloudflared: ['tunnel'], solr: ['search'], egress: ['default', 'egress'] };
    for (const [name, s] of Object.entries(r.services)) expect(Object.keys(s.networks ?? { default: null }).sort(), name).toEqual(nets[name] ?? ['default']);
    expect(render(undefined, { COMPOSE_PROJECT_NAME: 'other' }).networks?.default).toMatchObject({ name: 'hopper_default' });
  });

  it('pulls the hopper\'s public image by its full name: no clone, no build, no short-name prompt in Podman', () => {
    expect(hopper.image).toBe(IMAGE);
    expect(hopper.build).toBeUndefined();
  });

  it('serves the UI on this computer\'s loopback only', () => {
    expect(hopper.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '4790', target: 4790 })]);
  });

  it('answers the forwarded port: LAN peers are the private ranges, its LAN name the service name', () => {
    expect(hopper.environment?.HOPPER_LAN_PEERS).toBe('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    expect(hopper.environment?.HOPPER_LAN_NAMES).toBe('hopper');
  });

  it('gives the database a password made on first start, never one written in a file you edit', () => {
    expect(postgres.environment?.POSTGRES_PASSWORD).toBeUndefined();
    expect(postgres.environment?.POSTGRES_PASSWORD_FILE).toMatch(/^\/run\/hopper-secrets\//);
    expect(hopper.environment?.HOPPER_DATABASE_URL).toBeUndefined();
    expect(hopper.environment?.HOPPER_DATABASE_URL_FILE).toMatch(/^\/run\/hopper-secrets\//);
    // Postgres makes it, before the database starts; the hopper waits for a healthy Postgres and only reads.
    expect(postgres.command?.join('\n')).toContain('/dev/urandom');
    expect(postgres.command?.join('\n')).toMatch(/exec docker-entrypoint\.sh postgres/);
    expect(postgres.volumes).toContainEqual(expect.objectContaining({ source: 'runtime-secrets', target: '/run/hopper-secrets' }));
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: 'runtime-secrets', target: '/run/hopper-secrets', read_only: true }));
    expect(hopper.depends_on?.postgres?.condition).toBe('service_healthy');
  });

  it('keeps no master key in a volume or a file: the hopper reads HOPPER_MASTER_KEY from the launch, and the old token_key only to move it (issues #659, #894)', () => {
    expect(hopper.environment?.HOPPER_MASTER_KEY ?? '').toBe('');
    expect(hopper.environment?.HOPPER_MASTER_KEY_FILE ?? '').toBe('');
    const key = 'ab'.repeat(32);
    expect(svc(render(`HOPPER_MASTER_KEY=${key}\n`), 'hopper').environment?.HOPPER_MASTER_KEY).toBe(key);
    expect(hopper.environment?.HOPPER_TOKEN_KEY_FILE).toBeUndefined();
    const script = postgres.command!.join('\n');
    expect(script).not.toMatch(/token_key/);
  });

  it('keeps no secret in a persistent volume: the files Postgres makes are in memory (tmpfs), made again after a full stop (issue #659)', () => {
    expect(r.volumes.secrets).toBeUndefined();
    expect(r.volumes['runtime-secrets']).toMatchObject({ driver_opts: { type: 'tmpfs', device: 'tmpfs' } });
    // Each start remakes what is missing; nothing there must outlive the stack.
    const script = postgres.command!.join('\n');
    for (const f of ['postgres_password', 'openfga_key', 'vault_key']) expect(script).toMatch(new RegExp(`\\[ -s \\$\\$?s/${f} \\] \\|\\| head -c`));
  });

  it('sets the database password again at each start: a fresh set of start files does not lock the hopper out of its database (issue #659)', () => {
    const script = postgres.command!.join('\n');
    expect(script).toMatch(/ALTER ROLE hopper PASSWORD/);
    // Healthy only once the password is set: the hopper never meets the old one.
    expect(script).toMatch(/rm -f \$\$?s\/password_set/);
    expect(script).toMatch(/ALTER ROLE hopper PASSWORD[^\n]*&& touch \$\$?s\/password_set/);
    expect((postgres as Service & { healthcheck?: { test: string[] } }).healthcheck?.test.join(' ')).toMatch(/pg_isready -U hopper -d hopper && test -f \/run\/hopper-secrets\/password_set/);
  });

  it('loads pg_stat_statements, so the Resources page shows statement latency (issue #947)', () => {
    const script = postgres.command!.join('\n');
    expect(script).toMatch(/exec docker-entrypoint\.sh postgres -c shared_preload_libraries=pg_stat_statements/);
    // Made once Postgres takes connections, apart from the password step: it never holds the stack's health back.
    expect(script).toMatch(/touch \$\$?s\/password_set; psql [^\n]*CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA public[^\n]*\|\| true/);
  });

  it('has no one-shot service anything depends on: podman-compose cannot start a container whose dependency has exited (issue #125)', () => {
    expect(Object.keys(r.services).sort()).toEqual(['cloudflared', 'egress', 'hopper', 'openfga', 'openfga-migrate', 'postgres', 'solr', 'tunnel']);
    for (const s of Object.values(r.services)) expect(Object.keys(s.depends_on ?? {})).not.toContain('openfga-migrate');
  });

  it('runs OpenFGA beside the hopper, in a schema of its Postgres, behind a preshared key made on first start (issue #559)', () => {
    const openfga = svc(r, 'openfga');
    const migrate = svc(r, 'openfga-migrate');
    expect(openfga.image).toMatch(/^docker\.io\/openfga\/openfga:v\d+\.\d+\.\d+$/);
    expect(migrate.image).toBe(openfga.image);
    expect(openfga.command).toEqual(['run']);
    expect(migrate.command).toEqual(['migrate']);
    expect(openfga.ports ?? []).toEqual([]);
    expect(hopper.environment?.HOPPER_OPENFGA_URL).toBe('http://openfga:8080');
    expect(hopper.environment?.HOPPER_OPENFGA_KEY).toBeUndefined();
    expect(hopper.environment?.HOPPER_OPENFGA_KEY_FILE).toBe('/run/hopper-secrets/openfga_key');
    const script = postgres.command!.join('\n');
    expect(script).toMatch(/\[ -s \$\$?s\/openfga_key \] \|\| head -c 32 \/dev\/urandom/);
    expect(script).toMatch(/search_path=openfga/);
    expect(script).toMatch(/chown -R 65532:65532 \$\$?s\/openfga/);
    expect(script).toContain('CREATE SCHEMA IF NOT EXISTS openfga');
    for (const s of [openfga, migrate]) {
      expect(s.volumes).toContainEqual(expect.objectContaining({ source: 'runtime-secrets', target: '/run/hopper-secrets', read_only: true }));
      expect(s.depends_on?.postgres?.condition).toBe('service_healthy');
    }
  });

  it('HashiCorp Vault is optional (issue #585): started only with the vault profile, on no host port, and the hopper does not depend on it', () => {
    expect(r.services.vault).toBeUndefined();
    expect(hopper.depends_on?.vault).toBeUndefined();
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: 'vault-token', target: '/run/hopper-vault', read_only: true }));
    expect(hopper.environment?.VAULT_TOKEN_FILE).toBe('/run/hopper-vault/token');
    const withVault = render(undefined, { COMPOSE_PROFILES: 'vault' });
    const vault = svc(withVault, 'vault');
    expect(vault.ports ?? []).toEqual([]);
    expect(vault.volumes).toContainEqual(expect.objectContaining({ source: 'vault-token', target: '/run/hopper-vault' }));
    expect(svc(withVault, 'hopper').depends_on?.vault).toBeUndefined();
  });

  it('runs Solr for search, required, standalone, with one core, on no host port and on a network with the hopper alone (issue #945)', () => {
    const solr = svc(r, 'solr');
    expect(solr.image).toMatch(/^docker\.io\/library\/solr:\d+\.\d+\.\d+(-slim)?$/);
    expect((solr as Service & { profiles?: string[] }).profiles ?? []).toEqual([]);
    expect(solr.command).toEqual(['solr-precreate', 'hopper']);
    expect(solr.ports ?? []).toEqual([]); expect(solr.volumes).toContainEqual(expect.objectContaining({ source: 'solr', target: '/var/solr' }));
    expect(r.networks?.search).toMatchObject({ name: 'hopper_search' });
    // Search down stops nothing: the hopper does not wait for Solr, and no credential is kept for it.
    expect([hopper.environment?.HOPPER_SOLR_URL, hopper.depends_on?.solr]).toEqual(['http://solr:8983/solr/hopper', undefined]);
    expect(Object.keys(hopper.environment ?? {}).filter((k) => k.startsWith('HOPPER_SOLR_'))).toEqual(['HOPPER_SOLR_URL']);
  });

  it('keeps Postgres off every host port', () => {
    expect(postgres.ports ?? []).toEqual([]);
  });

  it('keeps the hopper\'s home in a volume: herdr and claude sign-ins and job checkouts survive a rebuild', () => {
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: 'home', target: '/home/node' }));
    expect(Object.keys(r.volumes).sort()).toEqual(['egress', 'home', 'postgres', 'runtime-secrets', 'solr', 'tunnel-key', 'vault-token']);
  });
});

describe('compose.yaml with settings given at launch (issue #894: no .env)', () => {
  it('reads no env_file: the hopper gets only the settings the file names', () => {
    const raw = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
    expect(raw).not.toMatch(/^\s*env_file:/m);
    const hopper = svc(render('HOPPER_PUBLIC_URL=https://hopper.example.com\nCLAUDE_CODE_OAUTH_TOKEN=t0\nCOMPOSE_PROFILES=kms\n'), 'hopper');
    expect(hopper.environment?.HOPPER_PUBLIC_URL).toBe('https://hopper.example.com');
    expect(hopper.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // The drift check reads the profiles the stack was started with (src/update/drift.ts).
    expect(hopper.environment?.COMPOSE_PROFILES).toBe('kms');
  });

  it('moves the UI port on both sides, so the Host the browser sends names the daemon\'s port; runs another image', () => {
    const hopper = svc(render('HOPPER_PORT=4800\nHOPPER_IMAGE=localhost/hopper:dev\n'), 'hopper');
    expect(hopper.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '4800', target: 4800 })]);
    expect(hopper.environment?.HOPPER_PORT).toBe('4800');
    expect(hopper.image).toBe('localhost/hopper:dev');
  });

  it('publishes the port on the address HOPPER_BIND names, so a LAN install keeps it across updates (issue #697)', () => {
    const hopper = svc(render('HOPPER_BIND=0.0.0.0\n'), 'hopper');
    expect(hopper.ports).toEqual([expect.objectContaining({ host_ip: '0.0.0.0', published: '4790', target: 4790 })]);
  });
});

describe('the image is not a machine (issue #141)', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('carries WHATS-NEW.md and whats-new/, so the Updates panel says what the running version brought (issues #165, #824)', () => {
    expect(dockerfile).toMatch(/^COPY WHATS-NEW\.md \.\/$/m);
    expect(dockerfile).toMatch(/^COPY whats-new \.\/whats-new$/m);
  });

  it('carries its compose.yaml, so an update fetches the compose file of the image it updates to (issue #697)', () => {
    expect(dockerfile).toMatch(/^COPY compose\.yaml \.\/$/m);
  });

  it('registers no `local` machine: it sets HOPPER_LOCAL_MACHINE=false and starts no herdr session of its own', () => {
    expect(dockerfile).toMatch(/HOPPER_LOCAL_MACHINE=false/);
    // herdr stays: the herdr-claude executor detects it before it runs jobs on attached machines.
    expect(dockerfile).toContain('https://herdr.dev/install.sh');
    expect(dockerfile).not.toMatch(/ENTRYPOINT/);
    expect(existsSync(join(ROOT, 'scripts', 'container-start.sh'))).toBe(false);
  });
});

describe('the host install keeps its own Postgres file', () => {
  it('deploy/compose.yaml is Postgres only: the container deploy is compose.yaml', () => {
    const old = readFileSync(join(ROOT, 'deploy', 'compose.yaml'), 'utf8');
    expect(old).not.toMatch(/^\s+hopper:/m);
  });
});

describe('the install page', () => {
  const page = readFileSync(join(ROOT, 'site', 'install.html'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

  // The site's build serves compose.yaml beside install.sh (test/scripts/pages-site.test.ts).
  it('is republished when compose.yaml changes', () => {
    expect(workflow).toMatch(/paths:[\s\S]*- compose\.yaml/);
  });

  it('names the renamed command and settings, never the old ones (issue #112)', () => {
    expect(page).not.toMatch(/exec hopper job-hopper|JOB_HOPPER_/);
    expect(readFileSync(join(ROOT, 'compose.yaml'), 'utf8')).not.toMatch(/JOB_HOPPER_|job-hopper/);
  });

  it('gives the container install with Podman as commands to copy', () => {
    expect(page).toContain('data-copy="curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml"');
    // Started under a user service of its own, which owns the published port (issue #1320), with the Podman socket (#1157).
    for (const cmd of ['podman run --rm ghcr.io/henningfutrell/hopper:latest hopper service script &gt; hopper-service.sh', 'bash hopper-service.sh install', 'systemctl --user enable --now podman.socket']) expect(page).toContain(`data-copy="${cmd}"`);
    expect(page).not.toContain('login-code');
    expect(page).toContain('The first person to sign in with GitHub is the admin');
    // Updated by its user (issue #494): the release's compose file, the whole stack (#697), one command (#1104).
    expect(page).toContain('data-copy="podman run --rm --pull=always ghcr.io/henningfutrell/hopper:stable hopper update script | bash -s -- ghcr.io/henningfutrell/hopper:stable"');
    expect(page).not.toMatch(/hopper-update\.sh|--no-deps hopper"/);
    expect(page).toContain('data-copy="podman image prune -f --filter label=org.opencontainers.image.title=hopper"');
  });

  it('upgrades without leaving the replaced image behind: the prune takes only dangling hopper images (issue #401)', () => {
    for (const text of [page, readFileSync(join(ROOT, 'compose.yaml'), 'utf8'), readFileSync(join(ROOT, 'docs', 'deploy.md'), 'utf8'), readFileSync(join(ROOT, 'README.md'), 'utf8')]) {
      expect(text).toContain('podman image prune -f --filter label=org.opencontainers.image.title=hopper');
    }
    expect(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')).toMatch(/^LABEL org\.opencontainers\.image\.title=hopper$/m);
  });

  it('recommends the container: its first command is the Podman one, before the install on the machine itself', () => {
    const first = (cmd: string): number => page.indexOf(`data-copy="${cmd}`);
    expect(first('bash hopper-service.sh install')).toBeGreaterThan(0);
    expect(first('bash hopper-service.sh install')).toBeLessThan(first('curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash'));
    expect(page).toMatch(/[Rr]ecommended/);
  });
});

describe('the published image (issue #125)', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'image.yml'), 'utf8');

  it('is built from the Dockerfile and pushed to GitHub\'s registry as the image compose.yaml pulls', () => {
    expect(workflow).toMatch(/registry: ghcr\.io/);
    expect(workflow).toContain('images: ghcr.io/henningfutrell/hopper');
    expect(workflow).toMatch(/type=raw,value=latest/);
    expect(workflow).toMatch(/push: true/);
  });

  it('is built on every change to dev, beta, canary and stable, the update channels and the stable candidate (issue #1073), for Intel/AMD and ARM machines (issue #423)', () => {
    expect(workflow).toMatch(/branches: \[dev, beta, canary, stable\]/);
    expect(workflow).toContain('linux/amd64,linux/arm64');
  });

  it('publishes every merge stream\'s last commit: a newer push never cancels a build in progress (issue #156)', () => {
    // Cancelling in progress meant merges a few minutes apart left `latest` hours behind, without
    // the UI's GitHub login. Runs queue instead, one queue per branch; GitHub keeps only the newest pending one.
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: image-\$\{\{ github\.ref_name \}\}\s*\n\s*cancel-in-progress: false/);
  });

  it('pushes with the workflow\'s own token: no registry credential to keep', () => {
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('secrets.GITHUB_TOKEN');
  });
});

describe('optional services (issue #586): each behind a compose profile, none required', () => {
  const plain = render();
  const on = render('COMPOSE_PROFILES=hopper-vault,kms\nHOPPER_VAULT_URL=http://hopper-vault:4791\nHOPPER_KMS_URL=http://kms:8080\n');

  it('a plain `compose up` starts only the required services, and the vault runs in the hopper', () => {
    expect(Object.keys(plain.services)).not.toContain('hopper-vault');
    expect(Object.keys(plain.services)).not.toContain('kms');
    expect(svc(plain, 'hopper').environment?.HOPPER_VAULT_URL ?? '').toBe('');
    expect(svc(plain, 'hopper').environment?.HOPPER_KMS_URL ?? '').toBe('');
  });

  it('the profiles `hopper-vault` and `kms` add the vault, from the hopper\'s image, and a local KMS; neither on a host port', () => {
    const vault = svc(on, 'hopper-vault');
    const kms = svc(on, 'kms');
    expect(vault.image).toBe(IMAGE);
    expect(vault.command).toEqual(['node', 'src/vault/main.ts']);
    expect(kms.image).toMatch(/^docker\.io\/nsmithuk\/local-kms:\d+\.\d+\.\d+$/);
    expect(kms.volumes).toContainEqual(expect.objectContaining({ source: 'kms', target: '/data' }));
    for (const s of [vault, kms]) expect(s.ports ?? []).toEqual([]);
    // Nothing required waits on an optional service.
    for (const name of ['hopper', 'postgres', 'openfga', 'openfga-migrate']) {
      expect(Object.keys(svc(on, name).depends_on ?? {})).not.toContain('hopper-vault');
      expect(Object.keys(svc(on, name).depends_on ?? {})).not.toContain('kms');
    }
  });

  it('the vault holds the keys and the KMS\'s URL; the hopper asks it with a preshared key made on first start', () => {
    const vault = svc(on, 'hopper-vault');
    const hopper = svc(on, 'hopper');
    expect(vault.environment).toMatchObject({
      HOPPER_DATABASE_URL_FILE: '/run/hopper-secrets/database_url', HOPPER_MASTER_KEY: '',
      HOPPER_VAULT_KEY_FILE: '/run/hopper-secrets/vault_key', HOPPER_KMS_URL: 'http://kms:8080',
    });
    expect(vault.environment?.HOPPER_TOKEN_KEY_FILE).toBeUndefined();
    expect(vault.volumes).toContainEqual(expect.objectContaining({ source: 'runtime-secrets', target: '/run/hopper-secrets', read_only: true }));
    expect(vault.depends_on?.postgres?.condition).toBe('service_healthy');
    expect(hopper.environment).toMatchObject({ HOPPER_VAULT_URL: 'http://hopper-vault:4791', HOPPER_VAULT_KEY_FILE: '/run/hopper-secrets/vault_key' });
    const script = svc(on, 'postgres').command!.join('\n');
    expect(script).toMatch(/\[ -s \$\$?s\/vault_key \] \|\| head -c 32 \/dev\/urandom/);
    expect(script).toMatch(/chown 1000:1000 [^\n]*\$\$?s\/vault_key/);
  });
});

describe('the container runtime socket (issues #603, #1157): compose.yaml gives it, no override file', () => {
  it('with no socket named, mounts /dev/null at its path: the stack starts, and the hopper says it has no socket', () => {
    const hopper = svc(render(), 'hopper');
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: '/dev/null', target: '/run/podman/podman.sock' }));
  });

  it('gives the hopper the rootless Podman socket HOPPER_PODMAN_SOCKET_HOST names, the group that opens it, and no SELinux label', () => {
    const hopper = svc(render('HOPPER_PODMAN_SOCKET_HOST=/run/user/1000/podman/podman.sock'), 'hopper');
    expect(hopper.environment?.HOPPER_PODMAN_SOCKET).toBe('/run/podman/podman.sock');
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: '/run/user/1000/podman/podman.sock', target: '/run/podman/podman.sock' }));
    expect([hopper.group_add, hopper.security_opt]).toEqual([['0'], ['label=disable']]);
  });

  it('ships no compose.sandboxes.yaml any more: nothing to copy in by hand', () => {
    expect(existsSync(join(ROOT, 'compose.sandboxes.yaml'))).toBe(false);
    for (const f of [['site', 'vite.config.ts'], ['site', 'install.html']]) expect(readFileSync(join(ROOT, ...f), 'utf8')).not.toContain('compose.sandboxes.yaml');
  });
});
