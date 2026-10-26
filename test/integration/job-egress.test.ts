// Issue #2849 part 1, through the real daemon and its HTTP server: a job's egress allowlist, kept in the database and set
// through the UI session, and `GET /job/egress`, the upgrade a running job connects out through with its proxy token.
//
// Feature: a job reaches only the hosts on its egress allowlist
//   Scenario: a host off the allowlist is refused, and the denial is on the job's timeline once
//   Scenario: a host an admin listed for the job's repository is reached, as a byte pipe
//   Scenario: a listed name that resolves to a loopback address is refused
//   Scenario: the allowlist is read and set through the UI session; a bad entry is refused
import { request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/users.ts';
import { running, start, stopGitProxies, type Started } from '../support/git-proxy.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((ok) => s.close(ok));
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
    t.app.user(ADMIN_ID).store.settings.setJobEgress({ defaults: true, hosts: [`localhost:${port}`], repos: {} });
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
    expect(read.body.egress).toEqual({ defaults: true, hosts: [], repos: {} });
    expect(read.body.defaultHosts).toContain('github.com:443');
    const bad = await t.app.ui('/ui/api/job-egress', { defaults: true, hosts: ['https://example.com'], repos: {} }, { token: session });
    expect(bad.status).toBe(400);
    const egress = { defaults: false, hosts: ['Dev.Example.com:8443'], repos: { 'Octo/Tools': ['*.example.org:443'] } };
    expect((await t.app.ui('/ui/api/job-egress', egress, { token: session })).body).toEqual({ egress: { defaults: false, hosts: ['dev.example.com:8443'], repos: { 'octo/tools': ['*.example.org:443'] } } });
    expect(t.app.user(ADMIN_ID).store.settings.getJobEgress()).toEqual({ defaults: false, hosts: ['dev.example.com:8443'], repos: { 'octo/tools': ['*.example.org:443'] } });
    const changed = t.app.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'job_egress.changed');
    expect(changed.map((e) => e.data)).toEqual([{ by: expect.any(String), defaults: false, hosts: 1, repos: 1 }]);
  });
});
