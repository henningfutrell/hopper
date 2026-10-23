// Issue #2146 (the bastion path, part 6): a bastion read. The ask is read as the hopper takes it (a GET of a path, a
// POST only to Grafana's data source query), and the command the hopper starts in the box runs here under `sh` with
// this machine's curl against a server on 127.0.0.1 — what a bastion's forward is in the box: the Authorization header
// comes from the secret's file, a POST's body from stdin, and the answer is the body and the HTTP status.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRead, readAnswer, readCommand, readHeader, READ_SH } from '../../src/sandbox/bastion-read.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'bastion-read-')); dirs.push(d); return d; };

describe('a bastion read as the job asks for it', () => {
  it('is a GET of a path, with the vault secret for its header', () => {
    expect(parseRead({ target: 'utility/monitoring/svc/grafana:80', path: '/api/search?query=latency&type=dash-db', secret: 'grafana-viewer' })).toEqual({
      target: 'utility/monitoring/svc/grafana:80', path: '/api/search?query=latency&type=dash-db', method: 'GET', secret: 'grafana-viewer',
    });
  });

  it('is a POST only to the data source query, with a JSON body', () => {
    const data = JSON.stringify({ queries: [{ refId: 'A', expr: 'up' }], from: 'now-1h', to: 'now' });
    expect(parseRead({ target: 't', path: '/api/ds/query', data })).toEqual({ target: 't', path: '/api/ds/query', method: 'POST', data });
    expect(parseRead({ target: 't', path: '/api/dashboards/db', data: '{}' })).toMatch(/^a read POSTs only to \/api\/ds\/query/);
    expect(parseRead({ target: 't', path: '/api/ds/query', data: 'not json' })).toBe('--data is a JSON body');
    expect(parseRead({ target: 't', path: '/api/ds/query', data: JSON.stringify({ a: 'x'.repeat(70_000) }) })).toMatch(/^--data is at most/);
  });

  it('refuses a path that is not one, a missing target or path, and a bad secret name', () => {
    expect(parseRead({ path: '/api/health' })).toMatch(/^name one target/);
    expect(parseRead({ target: 't' })).toMatch(/^name the path/);
    for (const path of ['api/health', '/api/search?q=a b', '/a\nb', '/a#b', 'http://elsewhere/']) expect(parseRead({ target: 't', path })).toMatch(/a path starts with \//);
    expect(parseRead({ target: 't', path: '/api/health', secret: '../x' })).toBe('../x: no vault secret name');
  });

  it('names the secret\'s file in the box, never its value', () => {
    const cmd = readCommand(20001, { method: 'GET', path: '/api/health', secret: 'grafana-viewer' });
    expect(cmd.slice(3)).toEqual(['hopper-bastion-read', '20001', 'GET', '/api/health', '/home/agent/.hopper-need/secrets/read-grafana-viewer']);
    expect(readCommand(20000, { method: 'GET', path: '/-/healthy' }).at(-1)).toBe('');
    expect(readHeader('glsa_abc\n')).toBe('Authorization: Bearer glsa_abc\n');
  });

  it('reads the status and the body from the command\'s output, or curl\'s words when it gave none', () => {
    expect(readAnswer(Buffer.from('{"a":1}\n200'), '')).toEqual({ status: 200, body: Buffer.from('{"a":1}') });
    expect(readAnswer(Buffer.from('\n000'), 'curl: (7) Failed to connect to 127.0.0.1 port 20001')).toEqual({ problem: 'curl: (7) Failed to connect to 127.0.0.1 port 20001' });
    expect(readAnswer(Buffer.alloc(0), '')).toEqual({ problem: 'the read in the box gave no answer' });
  });
});

/** A server that keeps each request and answers `status` with a JSON body. */
async function server(status = 200): Promise<{ port: number; seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] }> {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => { body += d.toString(); });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: status < 400 }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as AddressInfo).port, seen };
}

function run(args: string[], input: string, path = process.env.PATH ?? ''): Promise<{ code: number | null; out: Buffer; err: string }> {
  const child = spawn('sh', ['-c', READ_SH, 'hopper-bastion-read', ...args], { env: { PATH: path, HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' } });
  const out: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (d: Buffer) => out.push(d));
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out: Buffer.concat(out), err })));
}

describe.skipIf(!existsSync('/usr/bin/curl'))('the read command in the box', () => {
  it('GETs the path with the header from the secret\'s file, past any proxy, and prints the body and the status', async () => {
    const s = await server();
    const header = join(scratch(), 'read-grafana-viewer');
    writeFileSync(header, readHeader('glsa_token'), { mode: 0o600 });
    const r = await run([String(s.port), 'GET', '/api/search?query=latency', header], '');
    expect(r.code).toBe(0);
    expect(readAnswer(r.out, r.err)).toEqual({ status: 200, body: Buffer.from('{"ok":true}') });
    expect(s.seen).toMatchObject([{ method: 'GET', url: '/api/search?query=latency', body: '' }]);
    expect(s.seen[0]!.headers.authorization).toBe('Bearer glsa_token');
  });

  it('POSTs its stdin as the JSON body, and sends no header when no secret is named', async () => {
    const s = await server();
    const r = await run([String(s.port), 'POST', '/api/ds/query', ''], '{"queries":[]}');
    expect(readAnswer(r.out, r.err)).toMatchObject({ status: 200 });
    expect(s.seen).toMatchObject([{ method: 'POST', url: '/api/ds/query', body: '{"queries":[]}', headers: { 'content-type': 'application/json' } }]);
    expect(s.seen[0]!.headers.authorization).toBeUndefined();
  });

  it('answers the target\'s own status', async () => {
    const s = await server(403);
    const r = await run([String(s.port), 'GET', '/api/dashboards/uid/abc', ''], '');
    expect(readAnswer(r.out, r.err)).toEqual({ status: 403, body: Buffer.from('{"ok":false}') });
  });

  it('exits 127 and says so when the image has no curl', async () => {
    const bin = scratch();
    symlinkSync('/usr/bin/sh', join(bin, 'sh'));
    const r = await run(['20000', 'GET', '/', ''], '', bin);
    expect(r.code).toBe(127);
    expect(r.err).toContain('has no curl');
  });
});
