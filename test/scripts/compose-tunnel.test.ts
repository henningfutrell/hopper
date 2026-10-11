// The tunnel (issue #795): the compose profile `tunnel` runs an ngrok agent that forwards HOPPER_PUBLIC_URL to the hopper over
// a network only the two share, lets only the API through at the edge, and limits each caller there. Asserted on the
// rendered form compose runs (`docker compose config`), from an empty directory, as test/scripts/compose.test.ts does.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Service {
  image?: string;
  restart?: string;
  entrypoint?: string[];
  command?: string[];
  network_mode?: string;
  environment?: Record<string, string | null>;
  ports?: unknown[];
  networks?: Record<string, unknown>;
  depends_on?: Record<string, unknown>;
}
interface Rendered { services: Record<string, Service>; networks?: Record<string, { name?: string }> }

function render(dotenv?: string): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-tunnel-'));
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), dotenv);
  const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Rendered;
}

const svc = (r: Rendered, name: string): Service => {
  const s = r.services[name];
  if (!s) throw new Error(`no service ${name}`);
  return s;
};

describe('the tunnel (issue #795): profile `tunnel`, an ngrok agent that forwards the public URL to the hopper', () => {
  const plain = render();
  const on = render('COMPOSE_PROFILES=tunnel\nNGROK_AUTHTOKEN=t0ken\nHOPPER_PUBLIC_URL=https://h.example.ngrok.app\nHOPPER_TUNNEL_API=http://tunnel:4040\n');
  const tunnel = svc(on, 'tunnel');
  const script = tunnel.command!.join('\n');

  it('is off by default: a plain `compose up` starts no tunnel, and the hopper asks no tunnel agent', () => {
    expect(Object.keys(plain.services)).not.toContain('tunnel');
    expect(svc(plain, 'hopper').environment?.HOPPER_TUNNEL_API).toBeUndefined();
    expect(svc(on, 'hopper').environment?.HOPPER_TUNNEL_API).toBe('http://tunnel:4040');
  });

  it('runs a pinned ngrok image, restarted unless stopped, on no host port, and nothing waits on it', () => {
    expect(tunnel.image).toMatch(/^docker\.io\/ngrok\/ngrok:\d+\.\d+\.\d+/);
    expect(tunnel.restart).toBe('unless-stopped');
    expect(tunnel.ports ?? []).toEqual([]);
    for (const name of ['hopper', 'postgres', 'openfga']) expect(Object.keys(svc(on, name).depends_on ?? {})).not.toContain('tunnel');
  });

  it('is on its own network with the hopper alone, never the hopper\'s loopback: an internet request is never a local one', () => {
    expect(Object.keys(tunnel.networks ?? {})).toEqual(['tunnel']);
    expect(tunnel.network_mode).toBeUndefined();
    expect(on.networks?.tunnel).toMatchObject({ name: 'hopper_tunnel' });
    expect(script).toMatch(/ngrok [^\n]*http "?http:\/\/hopper:\$\$?\{?HOPPER_PORT/);
    expect(script).not.toMatch(/127\.0\.0\.1|localhost|host-header/);
  });

  it('forwards at HOPPER_PUBLIC_URL, with the authtoken from .env, and refuses to start without either', () => {
    expect(tunnel.environment).toMatchObject({ NGROK_AUTHTOKEN: 't0ken', HOPPER_PUBLIC_URL: 'https://h.example.ngrok.app' });
    expect(script).toMatch(/--url "?\$\$?\{?HOPPER_PUBLIC_URL/);
    expect(script).toMatch(/NGROK_AUTHTOKEN:\?/);
    expect(script).toMatch(/HOPPER_PUBLIC_URL:\?/);
  });

  it('lets only the API through at the edge, never the UI, the sign-in pages or the event stream, and limits each caller', () => {
    expect(script).toMatch(/--traffic-policy-file/);
    for (const path of ["'/api/'", "'/ui/api/'", "'/ui/auth/api-token'", "'/api/events/stream'"]) expect(script).toContain(path);
    expect(script).toMatch(/type: custom-response/);
    expect(script).toMatch(/type: rate-limit/);
    expect(script).toMatch(/conn\.client_ip/);
  });

  it('names each caller to the hopper in x-hopper-caller, first dropping one the caller sent', () => {
    const drop = script.indexOf('type: remove-headers'), set = script.indexOf('type: add-headers');
    expect(drop).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(drop);
    expect(script.slice(drop, set)).toMatch(/- x-hopper-caller/);
    expect(script.slice(set)).toMatch(/x-hopper-caller: "\$\$?\{conn\.client_ip\}"/);
  });
});
