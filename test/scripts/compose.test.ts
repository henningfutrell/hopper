// The Docker Compose install (issue #119): one compose.yaml brings up everything — its Postgres and
// the hopper, which runs jobs in its own herdr session inside its container — with no host install
// and no settings to start. The install page serves it as compose.yaml. Asserted on the rendered form
// docker compose runs (`docker compose config`), from an empty directory: the file as downloaded.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SOURCE = 'https://github.com/henningfutrell/hopper.git#main';

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

  it('builds the hopper from the public repository\'s main branch: no clone needed', () => {
    expect(hopper.build?.context).toBe(SOURCE);
  });

  it('serves the UI on this computer\'s loopback only', () => {
    expect(hopper.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '4790', target: 4790 })]);
  });

  it('answers the forwarded port: LAN peers are the private ranges, its LAN name the service name', () => {
    expect(hopper.environment?.JOB_HOPPER_LAN_PEERS).toBe('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    expect(hopper.environment?.JOB_HOPPER_LAN_NAMES).toBe('hopper');
  });

  it('gives the database a password made on first start, never one written in a file you edit', () => {
    expect(postgres.environment?.POSTGRES_PASSWORD).toBeUndefined();
    expect(postgres.environment?.POSTGRES_PASSWORD_FILE).toMatch(/^\/run\/hopper-secrets\//);
    expect(hopper.environment?.JOB_HOPPER_DATABASE_URL).toBeUndefined();
    expect(hopper.environment?.JOB_HOPPER_DATABASE_URL_FILE).toMatch(/^\/run\/hopper-secrets\//);
    for (const s of [hopper, postgres]) {
      expect(s.depends_on?.secrets?.condition).toBe('service_completed_successfully');
      expect(s.volumes).toContainEqual(expect.objectContaining({ source: 'secrets', target: '/run/hopper-secrets', read_only: true }));
    }
    expect(hopper.depends_on?.postgres?.condition).toBe('service_healthy');
  });

  it('keeps Postgres off every host port', () => {
    expect(postgres.ports ?? []).toEqual([]);
  });

  it('keeps the hopper\'s home in a volume: herdr, claude and gh sign-ins and job checkouts survive a rebuild', () => {
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: 'home', target: '/home/node' }));
    expect(Object.keys(r.volumes).sort()).toEqual(['home', 'postgres', 'secrets']);
  });
});

describe('compose.yaml with a .env beside it', () => {
  it('passes its settings and secrets to the hopper', () => {
    const hopper = svc(render('JOB_HOPPER_PUBLIC_URL=https://hopper.example.com\nGH_TOKEN=t0\n'), 'hopper');
    expect(hopper.environment?.JOB_HOPPER_PUBLIC_URL).toBe('https://hopper.example.com');
    expect(hopper.environment?.GH_TOKEN).toBe('t0');
  });

  it('moves the UI port on both sides, so the Host the browser sends names the daemon\'s port; builds from another source', () => {
    const hopper = svc(render('JOB_HOPPER_PORT=4800\nHOPPER_SOURCE=/src/hopper\n'), 'hopper');
    expect(hopper.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '4800', target: 4800 })]);
    expect(hopper.environment?.JOB_HOPPER_PORT).toBe('4800');
    expect(hopper.build?.context).toBe('/src/hopper');
  });
});

describe('the image runs jobs itself', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('carries herdr, and starts job-hopper\'s herdr session before the daemon', () => {
    expect(dockerfile).toContain('https://herdr.dev/install.sh');
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/app\/scripts\/container-start\.sh"\]/);
    const start = readFileSync(join(ROOT, 'scripts', 'container-start.sh'), 'utf8');
    expect(start).toContain('herdr --session job-hopper server');
    expect(start).toMatch(/exec "\$@"/);
  });
});

describe('the host install keeps its own Postgres file', () => {
  it('deploy/compose.yaml is Postgres only: the container deploy is compose.yaml', () => {
    const old = readFileSync(join(ROOT, 'deploy', 'compose.yaml'), 'utf8');
    expect(old).not.toMatch(/^\s+hopper:/m);
  });
});

describe('the install page', () => {
  const page = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

  it('publishes compose.yaml beside install.sh, and again when it changes', () => {
    expect(workflow).toMatch(/cp compose\.yaml site\/compose\.yaml/);
    expect(workflow).toMatch(/paths:.*compose\.yaml/);
  });

  it('gives the Docker Compose install as commands to copy', () => {
    expect(page).toContain('data-copy="curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml"');
    expect(page).toContain('data-copy="docker compose up -d --build"');
    expect(page).toContain('docker compose exec hopper job-hopper login-code --link http://127.0.0.1:4790');
  });
});
