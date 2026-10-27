// Issue #2849 part 1, through the real daemon and its HTTP server: a job's egress allowlist, kept in the database and set
// through the UI session, and `GET /job/egress`, the upgrade a running job connects out through with its proxy token.
//
// Feature: a job reaches only the hosts on its egress allowlist
//   Scenario: a host off the allowlist is refused, and the denial is on the job's timeline once
//   Scenario: a host an admin listed for the job's repository is reached, as a byte pipe
//   Scenario: a listed name that resolves to a loopback address is refused
//   Scenario: the allowlist is read and set through the UI session; a bad entry is refused
//
// Feature: the job's side, `hopper-egress` (part 2)
//   Scenario: with the setting on, a job starts with hopper-egress and the route variable; off, with no route variable
//   Scenario: a command behind hopper-egress reaches a listed host by CONNECT and by plain HTTP, and gets the hopper's no
//             for a host off the list
//
// Feature: the hosts the jobs ask for (part 3)
//   Scenario: a refused host is an ask; approved for the repository, the job's next try goes through and the ask is gone
//   Scenario: a dismissed host asks no more until a job is refused again
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/users.ts';
import { running, start, stopGitProxies, type Started } from '../support/git-proxy.ts';

const servers: (Server | HttpServer)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((ok) => { s.close(ok); if ('closeAllConnections' in s) s.closeAllConnections(); });
  await stopGitProxies();
});

/** A TCP server on loopback that answers each line with `echo <line>`. */
async function echoServer(): Promise<number> {
  const s = createServer((c) => c.on('data', (d) => c.write(`echo ${d.toString()}`)));
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return (s.address() as { port: number }).port;
}

type Opened = { status: number; text: string } | { socket: Socket };

/** `GET /job/egress?to=<to>` as an upgrade with the token: the no, or the upgraded socket. */
function egress(url: string, to: string, token: string): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(`/job/egress?to=${encodeURIComponent(to)}`, url), {
      headers: { connection: 'Upgrade', upgrade: 'hopper-egress/1', authorization: `Bearer ${token}` },
    });
    req.on('upgrade', (_res, socket) => resolve({ socket: socket as Socket }));
    req.on('response', (res) => {
      let text = '';
      res.on('data', (d: Buffer) => { text += d.toString(); }).on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function atWork(): Promise<{ t: Started; jobId: string; url: string; token: string }> {
  const t = await start();
  const r = await running(t);
  const token = readFileSync(join(t.root, r.env.HOPPER_TOKEN_FILE!), 'utf8').trim();
  return { t, jobId: r.job.id, url: r.env.HOPPER_URL!, token };
}

const denials = (t: Started, jobId: string) => t.app.user(ADMIN_ID).store.events.recent(1000, undefined, jobId).filter((e) => e.type === 'job.egress_denied');

describe('a job\'s egress allowlist (issue #2849 part 1)', () => {
  it('a host off the allowlist is refused, and the denial is on the job\'s timeline once', async () => {
    const { t, jobId, url, token } = await atWork();
    for (let i = 0; i < 2; i++) {
      const no = await egress(url, 'example.com:443', token) as { status: number; text: string };
      expect(no.status).toBe(403);
      expect(no.text).toContain('no: example.com:443 is not on the egress allowlist of job');
    }
    expect(denials(t, jobId).map((e) => e.data)).toEqual([{ host: 'example.com', port: 443, repo: 'octo/tools', reason: 'not_listed' }]);
  });

  it('a host an admin listed for the job\'s repository is reached, as a byte pipe', async () => {
    const { t, url, token } = await atWork();
    const port = await echoServer();
    const session = await t.app.login();
    const set = await t.app.ui('/ui/api/job-egress', { defaults: true, hosts: [], repos: { 'octo/tools': [`127.0.0.1:${port}`] } }, { token: session });
    expect(set.status).toBe(200);
    const opened = await egress(url, `127.0.0.1:${port}`, token);
    if (!('socket' in opened)) throw new Error(`refused: ${opened.status} ${opened.text}`);
    const back = new Promise<string>((ok) => opened.socket.once('data', (d) => ok(d.toString())));
    opened.socket.write('hello\n');
    expect(await back).toBe('echo hello\n');
    opened.socket.destroy();
    expect((await egress(url, `127.0.0.1:${port + 1}`, token) as { status: number }).status).toBe(403);
  });

  it('a listed name that resolves to a loopback address is refused', async () => {
    const { t, jobId, url, token } = await atWork();
    const port = await echoServer();
    t.app.user(ADMIN_ID).store.settings.setJobEgress({ defaults: true, hosts: [`localhost:${port}`], repos: {}, route: false });
    const no = await egress(url, `localhost:${port}`, token) as { status: number; text: string };
    expect(no.status).toBe(403);
    expect(no.text).toContain(`no: localhost:${port} resolves to a loopback or link-local address`);
    expect(denials(t, jobId).map((e) => e.data)).toEqual([{ host: 'localhost', port, repo: 'octo/tools', reason: 'local_address' }]);
  });

  it('a token that is no job\'s, or no host, is refused', async () => {
    const { url, token } = await atWork();
    expect(await egress(url, 'github.com:443', 'not-a-token')).toMatchObject({ status: 401 });
    expect(await egress(url, 'github.com', token)).toMatchObject({ status: 400 });
  });

  it('the allowlist is read and set through the UI session; a bad entry is refused; the change is an event', async () => {
    const { t } = await atWork();
    const session = await t.app.login();
    const read = await t.app.api<{ egress: unknown; defaultHosts: string[] }>('GET', '/api/job-egress', undefined, { 'x-hopper-session': session });
    expect(read.body.egress).toEqual({ defaults: true, hosts: [], repos: {}, route: false });
    expect(read.body.defaultHosts).toContain('github.com:443');
    const bad = await t.app.ui('/ui/api/job-egress', { defaults: true, hosts: ['https://example.com'], repos: {} }, { token: session });
    expect(bad.status).toBe(400);
    const egress = { defaults: false, hosts: ['Dev.Example.com:8443'], repos: { 'Octo/Tools': ['*.example.org:443'] } };
    expect((await t.app.ui('/ui/api/job-egress', egress, { token: session })).body).toEqual({ egress: { defaults: false, hosts: ['dev.example.com:8443'], repos: { 'octo/tools': ['*.example.org:443'] }, route: false } });
    expect(t.app.user(ADMIN_ID).store.settings.getJobEgress()).toEqual({ defaults: false, hosts: ['dev.example.com:8443'], repos: { 'octo/tools': ['*.example.org:443'] }, route: false });
    const changed = t.app.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'job_egress.changed');
    expect(changed.map((e) => e.data)).toEqual([{ by: expect.any(String), defaults: false, route: false, hosts: 1, repos: 1 }]);
  });
});

/** An HTTP server on loopback that answers each request with `<method> <path>`. */
async function httpServer(): Promise<number> {
  const s = createHttpServer((req, res) => res.end(`${req.method} ${req.url}`));
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return (s.address() as { port: number }).port;
}

/** `sh "$HOPPER_EGRESS" -- node -e <code>` with the job's variables, its files where the job's start placed them. */
function behindEgress(t: Started, env: Record<string, string>, code: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('sh', [join(t.root, env.HOPPER_EGRESS!), '--', process.execPath, '-e', code], {
      env: { PATH: process.env.PATH, HOPPER_URL: env.HOPPER_URL, HOPPER_TOKEN_FILE: join(t.root, env.HOPPER_TOKEN_FILE!) },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (c) => resolve({ code: c ?? 1, stdout, stderr }));
  });
}

// The command's own client: what an agent's tools do with HTTPS_PROXY and HTTP_PROXY. One CONNECT to each `to`, then a
// plain HTTP request in absolute form to `HTTP`; each answer one line.
const CLIENT = String.raw`
const http = require('node:http');
const proxy = new URL(process.env.HTTPS_PROXY);
const line = (s) => process.stdout.write(s + '\n');
const connect = (to) => new Promise((ok) => {
  const req = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: to });
  req.on('connect', (res, socket, head) => {
    if (res.statusCode !== 200) { let b = head.toString(); socket.on('data', (d) => { b += d; }).on('end', () => { line(res.statusCode + ' ' + b.trim()); ok(); }); return; }
    socket.once('data', (d) => { line(res.statusCode + ' ' + d.toString().trim()); socket.destroy(); ok(); });
    socket.write('hello\n');
  });
  req.end();
});
(async () => {
  line(['HTTP_PROXY', 'https_proxy', 'NO_PROXY', 'HOPPER_EGRESS_PORT'].map((k) => k + '=' + (process.env[k] ? 'set' : 'unset')).join(' '));
  line('no_proxy=' + process.env.NO_PROXY);
  for (const to of process.env.TO.split(' ')) await connect(to);
  await new Promise((ok) => http.get({ host: proxy.hostname, port: proxy.port, path: 'http://' + process.env.HTTP + '/a?b=1' }, (res) => { let b = ''; res.on('data', (d) => { b += d; }).on('end', () => { line(res.statusCode + ' ' + b); ok(); }); }));
})();
`;

describe('the job\'s side, hopper-egress (issue #2849 part 2)', () => {
  it('with the setting on, a job starts with hopper-egress and the route variable; off, with no route variable', async () => {
    const t = await start();
    const off = await running(t);
    expect(off.env.HOPPER_EGRESS).toMatch(/hopper\/egress$/);
    expect(readFileSync(join(t.root, off.env.HOPPER_EGRESS!), 'utf8')).toContain('exec node "$(dirname "$0")/egress.mjs" "$@"');
    expect(off.env.HOPPER_EGRESS_ROUTE).toBeUndefined();
    const session = await t.app.login();
    expect((await t.app.ui('/ui/api/job-egress', { defaults: true, hosts: [], repos: {}, route: true }, { token: session })).status).toBe(200);
    expect(t.app.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'job_egress.changed').map((e) => e.data)).toEqual([{ by: expect.any(String), defaults: true, route: true, hosts: 0, repos: 0 }]);
    const on = await running(t);
    expect(on.env.HOPPER_EGRESS_ROUTE).toBe('1');
  });

  it('a command behind it reaches a listed host by CONNECT and by plain HTTP, and gets the hopper\'s no for a host off the list', async () => {
    const t = await start();
    const echo = await echoServer();
    const web = await httpServer();
    t.app.user(ADMIN_ID).store.settings.setJobEgress({ defaults: true, hosts: [`127.0.0.1:${echo}`], repos: { 'octo/tools': [`127.0.0.1:${web}`] }, route: true });
    const { job, env } = await running(t);
    const code = `process.env.TO = '127.0.0.1:${echo} example.com:443'; process.env.HTTP = '127.0.0.1:${web}';\n${CLIENT}`;
    const r = await behindEgress(t, env, code);
    expect(r.code, r.stderr).toBe(0);
    const host = new URL(env.HOPPER_URL!).hostname;
    const lines = r.stdout.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'HTTP_PROXY=set https_proxy=set NO_PROXY=set HOPPER_EGRESS_PORT=set',
      `no_proxy=${[...new Set(['localhost', '127.0.0.1', '::1', host])].join(',')}`,
      '200 echo hello',
    ]);
    expect(lines[3]).toContain(`403 no: example.com:443 is not on the egress allowlist of job ${job.id}`);
    expect(lines.slice(4)).toEqual(['200 GET /a?b=1', '']);
    expect(denials(t, job.id).map((e) => e.data)).toEqual([{ host: 'example.com', port: 443, repo: 'octo/tools', reason: 'not_listed' }]);
  });
});

type EgressView = { egress: { hosts: string[]; repos: Record<string, string[]> }; asks: { host: string; repo?: string; jobIds: string[] }[] };

describe('the hosts the jobs ask for (issue #2849 part 3)', () => {
  it('a refused host is an ask; approved for the repository, the job\'s next try goes through and the ask is gone', async () => {
    const { t, jobId, url, token } = await atWork();
    const port = await echoServer();
    const no = await egress(url, `127.0.0.1:${port}`, token) as { status: number; text: string };
    expect(no.status).toBe(403);
    expect(no.text).toContain('A person approves it in Needs you (Settings → Job egress), for octo/tools; then try again.');
    const session = await t.app.login();
    const read = await t.app.api<EgressView>('GET', '/api/job-egress', undefined, { 'x-hopper-session': session });
    expect(read.body.asks).toEqual([{ host: `127.0.0.1:${port}`, repo: 'octo/tools', jobIds: [jobId], at: expect.any(String) }]);
    const approved = await t.app.ui<EgressView>('/ui/api/job-egress/asks', { host: `127.0.0.1:${port}`, repo: 'octo/tools', answer: 'approve' }, { token: session });
    expect(approved.status).toBe(200);
    expect(approved.body.asks).toEqual([]);
    expect(approved.body.egress.repos).toEqual({ 'octo/tools': [`127.0.0.1:${port}`] });
    const opened = await egress(url, `127.0.0.1:${port}`, token);
    if (!('socket' in opened)) throw new Error(`refused: ${opened.status} ${opened.text}`);
    opened.socket.destroy();
    const answered = t.app.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'job_egress.ask_answered');
    expect(answered.map((e) => e.data)).toEqual([{ by: expect.any(String), host: '127.0.0.1', port, repo: 'octo/tools', answer: 'approved', for: 'repo' }]);
  });

  it('a dismissed host asks no more until a job is refused again; a wildcard is no ask', async () => {
    const { t, url, token } = await atWork();
    await egress(url, 'paste.example.com:443', token);
    const session = await t.app.login();
    expect((await t.app.ui('/ui/api/job-egress/asks', { host: '*.example.com:443', answer: 'approve' }, { token: session })).status).toBe(400);
    const dismissed = await t.app.ui<EgressView>('/ui/api/job-egress/asks', { host: 'paste.example.com:443', repo: 'octo/tools', answer: 'dismiss' }, { token: session });
    expect(dismissed.body.asks).toEqual([]);
    expect(dismissed.body.egress.repos).toEqual({});
    const again = await running(t);
    const token2 = readFileSync(join(t.root, again.env.HOPPER_TOKEN_FILE!), 'utf8').trim();
    expect((await egress(again.env.HOPPER_URL!, 'paste.example.com:443', token2) as { status: number }).status).toBe(403);
    const read = await t.app.api<EgressView>('GET', '/api/job-egress', undefined, { 'x-hopper-session': session });
    expect(read.body.asks.map((a) => a.jobIds)).toEqual([[again.job.id]]);
  });
});
