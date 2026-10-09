// The container install (issue #119): one compose.yaml brings up everything — its Postgres and
// the hopper, which runs jobs in its own herdr session inside its container — with no host install
// and no settings to start. The install page serves it as compose.yaml. Issue #125: the hopper is the
// public image pulled from GitHub's registry, nothing is built, and Podman is the recommended runtime.
// Asserted on the rendered form compose runs (`docker compose config`, the provider `podman compose`
// uses too), from an empty directory: the file as downloaded.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'ghcr.io/henningfutrell/hopper:latest';

interface Service {
  image?: string;
  build?: { context: string };
  environment?: Record<string, string | null>;
  ports?: { host_ip?: string; published?: string; target: number }[];
  volumes?: { source?: string; target: string; read_only?: boolean }[];
  depends_on?: Record<string, { condition: string }>;
  command?: string[];
}
interface Rendered { name: string; services: Record<string, Service>; volumes: Record<string, unknown> }

/** `docker compose config` of compose.yaml copied alone into a fresh directory, with `.env` when given. */
function render(dotenv?: string, env: Record<string, string> = {}): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-'));
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), dotenv);
  const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, ...env },
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
    expect(postgres.volumes).toContainEqual(expect.objectContaining({ source: 'secrets', target: '/run/hopper-secrets' }));
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: 'secrets', target: '/run/hopper-secrets', read_only: true }));
    expect(hopper.depends_on?.postgres?.condition).toBe('service_healthy');
  });

  it('gives the hopper a token key made on first start, kept with the database password (issue #441)', () => {
    expect(hopper.environment?.HOPPER_TOKEN_KEY).toBeUndefined();
    expect(hopper.environment?.HOPPER_TOKEN_KEY_FILE).toBe('/run/hopper-secrets/token_key');
    const script = postgres.command!.join('\n');
    expect(script).toMatch(/\[ -s \$\$?s\/token_key \] \|\| head -c 32 \/dev\/urandom/);
    expect(script).toMatch(/chown 1000:1000 \$\$?s\/database_url \$\$?s\/token_key/);
  });

  it('has no one-shot service anything depends on: podman-compose cannot start a container whose dependency has exited (issue #125)', () => {
    expect(Object.keys(r.services).sort()).toEqual(['hopper', 'openfga', 'openfga-migrate', 'postgres']);
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
      expect(s.volumes).toContainEqual(expect.objectContaining({ source: 'secrets', target: '/run/hopper-secrets', read_only: true }));
      expect(s.depends_on?.postgres?.condition).toBe('service_healthy');
    }
  });

  it('keeps Postgres off every host port', () => {
    expect(postgres.ports ?? []).toEqual([]);
  });

  it('keeps the hopper\'s home in a volume: herdr and claude sign-ins and job checkouts survive a rebuild', () => {
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: 'home', target: '/home/node' }));
    expect(Object.keys(r.volumes).sort()).toEqual(['home', 'postgres', 'secrets']);
  });
});

describe('compose.yaml with a .env beside it', () => {
  it('passes its settings and secrets to the hopper', () => {
    const hopper = svc(render('HOPPER_PUBLIC_URL=https://hopper.example.com\nCLAUDE_CODE_OAUTH_TOKEN=t0\n'), 'hopper');
    expect(hopper.environment?.HOPPER_PUBLIC_URL).toBe('https://hopper.example.com');
    expect(hopper.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBe('t0');
  });

  it('moves the UI port on both sides, so the Host the browser sends names the daemon\'s port; runs another image', () => {
    const hopper = svc(render('HOPPER_PORT=4800\nHOPPER_IMAGE=localhost/hopper:dev\n'), 'hopper');
    expect(hopper.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '4800', target: 4800 })]);
    expect(hopper.environment?.HOPPER_PORT).toBe('4800');
    expect(hopper.image).toBe('localhost/hopper:dev');
  });
});

describe('the image is not a machine (issue #141)', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('carries WHATS-NEW.md, so the Updates panel says what the running version brought (issue #165)', () => {
    expect(dockerfile).toMatch(/^COPY WHATS-NEW\.md \.\/$/m);
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
    expect(page).toContain('data-copy="podman compose up -d"');
    expect(page).not.toContain('login-code');
    expect(page).toContain('The first person to sign in with GitHub is the admin');
    // Updated by its user, recreating the hopper's container alone (issue #494).
    expect(page).toContain('data-copy="podman compose pull hopper &amp;&amp; podman compose up -d --force-recreate --no-deps hopper"');
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
    expect(first('podman compose up -d')).toBeGreaterThan(0);
    expect(first('podman compose up -d')).toBeLessThan(first('curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash'));
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

  it('is built on every change to dev, beta and stable, the update channels, for Intel/AMD and ARM machines (issue #423)', () => {
    expect(workflow).toMatch(/branches: \[dev, beta, stable\]/);
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
  const on = render('COMPOSE_PROFILES=vault,kms\nHOPPER_VAULT_URL=http://vault:4791\nHOPPER_KMS_URL=http://kms:8080\n');

  it('a plain `compose up` starts only the required services, and the vault runs in the hopper', () => {
    expect(Object.keys(plain.services)).not.toContain('vault');
    expect(Object.keys(plain.services)).not.toContain('kms');
    expect(svc(plain, 'hopper').environment?.HOPPER_VAULT_URL ?? '').toBe('');
    expect(svc(plain, 'hopper').environment?.HOPPER_KMS_URL ?? '').toBe('');
  });

  it('the profiles `vault` and `kms` add the vault, from the hopper\'s image, and a local KMS; neither on a host port', () => {
    const vault = svc(on, 'vault');
    const kms = svc(on, 'kms');
    expect(vault.image).toBe(IMAGE);
    expect(vault.command).toEqual(['node', 'src/vault/main.ts']);
    expect(kms.image).toMatch(/^docker\.io\/nsmithuk\/local-kms:\d+\.\d+\.\d+$/);
    expect(kms.volumes).toContainEqual(expect.objectContaining({ source: 'kms', target: '/data' }));
    for (const s of [vault, kms]) expect(s.ports ?? []).toEqual([]);
    // Nothing required waits on an optional service.
    for (const name of ['hopper', 'postgres', 'openfga', 'openfga-migrate']) {
      expect(Object.keys(svc(on, name).depends_on ?? {})).not.toContain('vault');
      expect(Object.keys(svc(on, name).depends_on ?? {})).not.toContain('kms');
    }
  });

  it('the vault holds the keys and the KMS\'s URL; the hopper asks it with a preshared key made on first start', () => {
    const vault = svc(on, 'vault');
    const hopper = svc(on, 'hopper');
    expect(vault.environment).toMatchObject({
      HOPPER_DATABASE_URL_FILE: '/run/hopper-secrets/database_url', HOPPER_TOKEN_KEY_FILE: '/run/hopper-secrets/token_key',
      HOPPER_VAULT_KEY_FILE: '/run/hopper-secrets/vault_key', HOPPER_KMS_URL: 'http://kms:8080',
    });
    expect(vault.volumes).toContainEqual(expect.objectContaining({ source: 'secrets', target: '/run/hopper-secrets', read_only: true }));
    expect(vault.depends_on?.postgres?.condition).toBe('service_healthy');
    expect(hopper.environment).toMatchObject({ HOPPER_VAULT_URL: 'http://vault:4791', HOPPER_VAULT_KEY_FILE: '/run/hopper-secrets/vault_key' });
    const script = svc(on, 'postgres').command!.join('\n');
    expect(script).toMatch(/\[ -s \$\$?s\/vault_key \] \|\| head -c 32 \/dev\/urandom/);
    expect(script).toMatch(/chown 1000:1000 [^\n]*\$\$?s\/vault_key/);
  });
});
