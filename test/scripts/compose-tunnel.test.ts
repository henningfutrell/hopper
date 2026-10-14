// The tunnel (issues #795, #880): the compose service `tunnel` runs an ngrok agent that forwards the remote access URL to the
// hopper over a network only the two share, lets only the API through at the edge, and limits each caller there. It holds
// nothing: it asks the hopper for its URL and authtoken (set in the UI) with a key made in memory at each start of the
// stack, in a volume no other internet-facing part mounts. Asserted on the rendered form compose runs (`docker compose
// config`), from an empty directory, as test/scripts/compose.test.ts does.
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
  volumes?: { source?: string; target: string; read_only?: boolean }[];
}
interface Rendered { services: Record<string, Service>; networks?: Record<string, { name?: string }>; volumes?: Record<string, unknown> }

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

describe('the tunnel (issues #795, #880): an ngrok agent that forwards the remote access URL to the hopper', () => {
  const r = render();
  const tunnel = svc(r, 'tunnel');
  const script = tunnel.command!.join('\n');

  it('runs in a plain `compose up`, with no line in .env: remote access is turned on in the UI', () => {
    expect(Object.keys(r.services)).toContain('tunnel');
    expect(svc(r, 'hopper').environment).toMatchObject({ HOPPER_TUNNEL_API: 'http://tunnel:4040', HOPPER_CLOUDFLARED_API: 'http://cloudflared:2000', HOPPER_TUNNEL_KEY_FILE: '/run/hopper-tunnel/key' });
  });

  it('holds no token and no URL: nothing from .env reaches it but the port', () => {
    const on = svc(render('NGROK_AUTHTOKEN=t0ken\nHOPPER_PUBLIC_URL=https://h.example.ngrok.app\n'), 'tunnel');
    expect(Object.keys(on.environment ?? {})).toEqual(['HOPPER_PORT']);
    expect(JSON.stringify(on)).not.toContain('t0ken');
  });

  it('runs a pinned ngrok image, restarted unless stopped, on no host port, and nothing waits on it', () => {
    expect(tunnel.image).toMatch(/^docker\.io\/ngrok\/ngrok:\d+\.\d+\.\d+/);
    expect(tunnel.restart).toBe('unless-stopped');
    expect(tunnel.ports ?? []).toEqual([]);
    for (const name of ['hopper', 'postgres', 'openfga']) expect(Object.keys(svc(r, name).depends_on ?? {})).not.toContain('tunnel');
  });

  it('is on its own network with the hopper alone, never the hopper\'s loopback: an internet request is never a local one', () => {
    expect(Object.keys(tunnel.networks ?? {})).toEqual(['tunnel']);
    expect(tunnel.network_mode).toBeUndefined();
    expect(r.networks?.tunnel).toMatchObject({ name: 'hopper_tunnel' });
    expect(script).toMatch(/ngrok [^\n]*http "?http:\/\/hopper:\$\$?\{?HOPPER_PORT/);
    expect(script).not.toMatch(/127\.0\.0\.1|localhost|host-header/);
  });

  it('asks the hopper for its settings with the key in memory, which it shares with the hopper alone', () => {
    expect(r.volumes?.['tunnel-key']).toMatchObject({ driver_opts: { type: 'tmpfs', device: 'tmpfs' } });
    expect(tunnel.volumes).toEqual([expect.objectContaining({ source: 'tunnel-key', target: '/run/hopper-tunnel', read_only: true })]);
    for (const [name, s] of Object.entries(r.services)) {
      const mounts = (s.volumes ?? []).filter((v) => v.source === 'tunnel-key').length;
      expect(mounts, name).toBe(['hopper', 'postgres', 'tunnel', 'cloudflared'].includes(name) ? 1 : 0);
    }
    expect(svc(r, 'postgres').command!.join('\n')).toMatch(/\/run\/hopper-tunnel\/key/);
    expect(script).toMatch(/wget [^\n]*authorization: Bearer \$\$?key[^\n]*\/tunnel\/agent|wget [^\n]*authorization: Bearer \$\$?key[^\n]*\$\$?a/);
    expect(script).toMatch(/a="http:\/\/hopper:\$\$?\{HOPPER_PORT\}\/tunnel\/agent"/);
  });

  it('gives ngrok the token in its environment only, never on its command line or in a file, and masks it in the log', () => {
    expect(script).toMatch(/NGROK_AUTHTOKEN=\$\$?tok ngrok /);
    expect(script).not.toMatch(/--authtoken|config add-authtoken/);
    expect(script).toMatch(/gsub\(ENVIRON\["T"\], "\[authtoken\]"\)/);
    expect(script).toMatch(/--url "?\$\$?url/);
  });

  it('lets only the API through at the edge, never the UI, the sign-in pages or the event stream, and limits each caller', () => {
    expect(script).toMatch(/--traffic-policy-file/);
    for (const path of ["'/api/'", "'/ui/api/'", "'/ui/auth/api-token'", "'/ui/auth/token/refresh'", "'/api/events/stream'"]) expect(script).toContain(path);
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

describe('cloudflared (issue #968): Cloudflare\'s agent, run only while remote access is on with Cloudflare Tunnel', () => {
  const r = render();
  const cf = svc(r, 'cloudflared');
  const script = cf.command!.join('\n');

  it('runs in a plain `compose up` from the hopper\'s image, on no host port, and nothing waits on it', () => {
    expect(cf.image).toBe(svc(r, 'hopper').image);
    expect(cf.restart).toBe('unless-stopped');
    expect(cf.ports ?? []).toEqual([]);
    for (const name of ['hopper', 'postgres', 'openfga', 'tunnel']) expect(Object.keys(svc(r, name).depends_on ?? {})).not.toContain('cloudflared');
  });

  it('holds nothing but the port: it asks the hopper for the token with the key in memory', () => {
    const on = svc(render('CLOUDFLARE_API_TOKEN=t0ken\nTUNNEL_TOKEN=t0ken\n'), 'cloudflared');
    expect(Object.keys(on.environment ?? {})).toEqual(['HOPPER_PORT']);
    expect(JSON.stringify(on)).not.toContain('t0ken');
    expect(cf.volumes).toEqual([expect.objectContaining({ source: 'tunnel-key', target: '/run/hopper-tunnel', read_only: true })]);
    expect(script).toMatch(/curl [^\n]*authorization: Bearer \$\$?key[^\n]*\$\$?a\?cloudflared=/);
  });

  it('gives cloudflared the token in its environment only, never on its command line, and starts no agent while told nothing', () => {
    expect(script).toMatch(/TUNNEL_TOKEN=\$\$?tok cloudflared tunnel --no-autoupdate --metrics 0\.0\.0\.0:2000 run/);
    expect(script).not.toMatch(/--token[ =]/);
    expect(script).toMatch(/if \[ -n "\$\$?tok" \]/);
  });

  it('is on the tunnel\'s network alone, and forwards nothing to the hopper\'s loopback', () => {
    expect(Object.keys(cf.networks ?? {})).toEqual(['tunnel']);
    expect(cf.network_mode).toBeUndefined();
    expect(script).not.toMatch(/127\.0\.0\.1|localhost/);
  });
});
