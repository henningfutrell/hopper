// Several users of one hopper (issue #158, design.md "Users: one hopper, separate users"), through
// the real HTTP server and the real store: each user's jobs, questions, events, plugins and webhooks
// are their own; an admin adds a user and hands over its login link; a loopback read without a session
// reads a user's work only while the hopper has one user; an admin reads the totals, never a user's work.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { mintLoginCode } from '../../src/http/ui/login-code.ts';
import { openSse } from '../support/sse.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { withStores } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';
import { openDb } from '../../src/store/db.ts';
import { migrateInstance } from '../../src/store/migrations.ts';
import { databaseUrlFor, untouchedUrlFor } from '../support/database.ts';
import { runCli } from '../../src/cli.ts';
import { rmSync } from 'node:fs';
import { createStickyExecutor } from '../support/doubles.ts';
import { copyBuilder, createInstall, createUpstream, tempDir } from '../update/support.ts';
import { createStoreRepo, entry } from '../plugin-store/support.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> = {}, before?: (dbPath: string) => void): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const hard = { op: 'ask', message: 'This one is hard and risky' };
const sleep = { op: 'sleep', ms: 60_000 };
const session = (token: string) => ({ 'x-hopper-session': token });

/** Owner signed in; the user `bea` added from the UI, signed in with the link the answer carried. */
async function twoUsers(a: TestApp): Promise<{ admin: string; bea: string }> {
  const admin = await a.login();
  const added = await a.ui<{ user: { id: string; name: string }; links: string[] }>('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin });
  expect(added.status).toBe(200);
  expect(added.body.user).toEqual({ id: 'bea', name: 'Bea', createdAt: expect.any(String) });
  expect(added.body.links).toContainEqual(expect.stringMatching(new RegExp(`^${a.url}/#login=[0-9a-f]{64}$`)));
  const code = /#login=([0-9a-f]{64})$/.exec(added.body.links[0]!)![1]!;
  return { admin, bea: await a.loginWith(code) };
}

describe('two users of one hopper', () => {
  it('each sees only their own jobs, questions, events and webhooks', async () => {
    const a = await start();
    const { admin, bea } = await twoUsers(a);
    const adminJob = await a.pull(hard, { title: 'admin work' });
    const adminQuestion = await a.waitForQuestion(adminJob.id, (q) => q.tier === 'human');
    const beaJob = await a.pull(sleep, { title: 'bea work' }, 'bea');
    expect((await a.ui('/ui/api/webhooks', { action: 'add', name: 'hook', url: 'http://127.0.0.1:9/hook', events: ['*'], secretEnv: 'WEBHOOK_SECRET_A' }, { token: admin })).status).toBe(200);

    const read = async <T>(path: string, token: string): Promise<T> => (await a.api<T>('GET', path, undefined, session(token))).body;
    expect((await read<{ jobs: Job[] }>('/api/jobs', admin)).jobs.map((j) => j.id)).toEqual([adminJob.id]);
    expect((await read<{ jobs: Job[] }>('/api/jobs', bea)).jobs.map((j) => j.id)).toEqual([beaJob.id]);
    expect((await a.api('GET', `/api/jobs/${adminJob.id}`, undefined, session(bea))).status).toBe(404);
    expect((await read<{ questions: Question[] }>('/api/questions?status=all', admin)).questions.map((q) => q.id)).toEqual([adminQuestion.id]);
    expect((await read<{ questions: Question[] }>('/api/questions?status=all', bea)).questions).toEqual([]);
    expect((await a.api('GET', `/api/questions/${adminQuestion.id}`, undefined, session(bea))).status).toBe(404);
    const beaEvents = (await read<{ events: DomainEvent[] }>('/api/events?limit=1000', bea)).events;
    expect(beaEvents.some((e) => e.jobId === beaJob.id)).toBe(true);
    expect(beaEvents.some((e) => e.jobId === adminJob.id || e.questionId === adminQuestion.id)).toBe(false);
    expect((await read<{ subscriptions: unknown[] }>('/api/webhooks', admin)).subscriptions).toHaveLength(1);
    expect((await read<{ subscriptions: unknown[] }>('/api/webhooks', bea)).subscriptions).toEqual([]);
  });

  it('a mutation on another user\'s question or job is 404, and changes nothing', async () => {
    const a = await start();
    const { bea } = await twoUsers(a);
    const job = await a.pull(hard);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    for (const verb of ['answer', 'close', 'dismiss', 'seen']) {
      expect((await a.ui(`/ui/api/questions/${q.id}/${verb}`, { answer: 'mine now' }, { token: bea })).status, verb).toBe(404);
    }
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: bea })).status).toBe(404);
    expect((await a.job(job.id)).status).toBe('waiting_answer');
    const after = (await a.questionsOf(job.id))[0]!;
    expect(after.status).toBe('open');
    expect(after.seenAt).toBeUndefined();
  });

  it('an admin of one user changing plugins changes only that user\'s plugins config', async () => {
    const a = await start();
    const { admin, bea } = await twoUsers(a);
    const report = (await a.api('GET', '/api/plugins', undefined, session(bea))).body;
    const r = await a.ui('/ui/api/plugins', { action: 'select', role: 'queue-sorter', plugin: 'oldest-first', version: report.config.version }, { token: bea });
    expect(r.status).toBe(200);
    expect((a.user('bea').store.config.read('plugins') as { queueSorter?: unknown }).queueSorter).toMatchObject({ plugin: 'oldest-first' });
    expect((a.user().store.config.read('plugins') as { queueSorter?: unknown }).queueSorter).toBeUndefined();
    expect((await a.api('GET', '/api/plugins', undefined, session(admin))).body.queueSorter.instance.plugin).toBe('priority');
  });

  it('the queue gate is each user\'s own', async () => {
    const a = await start();
    const { admin, bea } = await twoUsers(a);
    expect((await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token: bea })).status).toBe(200);
    expect((await a.api('GET', '/api/queue', undefined, session(bea))).body.gate.mode).toBe('review');
    expect((await a.api('GET', '/api/queue', undefined, session(admin))).body.gate.mode).toBe('auto-accept');
  });

  it('the event stream carries the session user\'s events only', async () => {
    const a = await start();
    const { bea } = await twoUsers(a);
    const stream = await openSse(`${a.url}/api/events/stream?after=0`, session(bea));
    try {
      const adminJob = await a.pull(sleep);
      const beaJob = await a.pull(sleep, {}, 'bea');
      await waitFor(() => stream.messages.some((m) => m.event === 'job.queued' && (JSON.parse(m.data) as DomainEvent).jobId === beaJob.id));
      expect(stream.messages.filter((m) => m.id !== undefined).some((m) => (JSON.parse(m.data) as DomainEvent).jobId === adminJob.id)).toBe(false);
    } finally {
      stream.close();
    }
  });
});

describe('users, sessions and login codes', () => {
  it('a login code minted for a user signs in as that user', async () => {
    const a = await start();
    const bea = await a.addUser('Bea');
    const token = await a.loginWith(mintLoginCode(a.app.instance, { now: () => new Date() }, bea.id));
    const view = (await a.api('GET', '/ui/api/session', undefined, session(token))).body;
    expect(view).toMatchObject({ authenticated: true, user: { id: 'bea', name: 'Bea', role: 'admin', realm: 'local', identity: 'login code' } });
    const admin = await a.login();
    expect((await a.api('GET', '/ui/api/session', undefined, session(admin))).body.user).toMatchObject({ id: 'admin', name: 'admin' });
  });

  it('GET /api/users lists the users, nothing of theirs; POST /ui/api/users needs a free name', async () => {
    const a = await start();
    const admin = await a.login();
    expect((await a.ui('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/users', { action: 'add', name: 'bea' }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/users', { action: 'add', name: 'Cy' })).status).toBe(403);
    const users = (await a.api('GET', '/api/users')).body.users;
    expect(users).toEqual([
      { id: 'admin', name: 'admin', createdAt: expect.any(String) },
      { id: 'bea', name: 'Bea', createdAt: expect.any(String) },
    ]);
    expect((await a.api('GET', '/api/users', undefined, session(admin))).status).toBe(200);
  });

  it('with one user, a loopback read without a session reads that user\'s work', async () => {
    const a = await start();
    const job = await a.pull(sleep);
    expect((await a.api('GET', '/api/jobs')).body.jobs.map((j: Job) => j.id)).toEqual([job.id]);
  });

  it('with several users, a loopback read without a session reads no user\'s work, whatever x-hopper-user says', async () => {
    const a = await start();
    await a.addUser('Bea');
    await a.pull(sleep);
    await a.pull(sleep, {}, 'bea');
    const tries: Record<string, string>[] = [{}, { 'x-hopper-user': 'bea' }, { 'x-hopper-user': 'admin' }];
    for (const headers of tries) {
      for (const path of ['/api/jobs', '/api/questions', '/api/events', '/api/plugins', '/api/webhooks']) {
        expect((await a.api('GET', path, undefined, headers)).status, `${path} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    expect((await a.api('GET', '/api/users')).status).toBe(200);
  });
});

describe('who you are, and signing in with several users (issue #167)', () => {
  it('logged out on loopback, the session names the user a read shows; one user needs no sign-in', async () => {
    const a = await start();
    expect((await a.api('GET', '/ui/api/session')).body).toMatchObject({ authenticated: false, viewing: { id: 'admin', name: 'admin' }, signIn: { required: false } });
  });

  it('with several users sign-in is required; signed in, the session names its own user and no other', async () => {
    const a = await start();
    await a.addUser('Bea');
    const loggedOut = (await a.api('GET', '/ui/api/session')).body;
    expect(loggedOut).toMatchObject({ authenticated: false, signIn: { required: true } });
    expect(loggedOut.viewing).toBeUndefined();
    expect((await a.api('GET', '/ui/api/session', undefined, { 'x-hopper-user': 'bea' })).body.viewing).toBeUndefined();
    const view = (await a.api('GET', '/ui/api/session', undefined, session(await a.login('bea')))).body;
    expect(view).toMatchObject({ authenticated: true, user: { id: 'bea', name: 'Bea' }, signIn: { required: true } });
    expect(view.viewing).toBeUndefined();
  });
});

describe('a user\'s runtime', () => {
  it('a user added while the daemon runs gets its runtime: its plugins config, its herdr session hopper-<id>, its jobs run', async () => {
    const a = await start();
    const bea = await a.addUser('Bea');
    const plugins = a.user(bea.id).store.config.read('plugins') as { executors: { plugin: string; options?: { session?: string } }[] };
    expect(plugins.executors.filter((e) => e.plugin === 'herdr-claude').map((e) => e.options?.session)).toEqual(['hopper-bea']);
    const report = (await a.api('GET', '/api/plugins', undefined, session(await a.login('bea')))).body;
    expect(report.executors.instances.find((i: { instance: { plugin: string } }) => i.instance.plugin === 'herdr-claude').instance.options.session).toBe('hopper-bea');
    expect((a.user().store.config.read('plugins') as { executors?: unknown }).executors).toEqual([{ name: 'test', plugin: 'test' }]);
    const job = await a.pull({ op: 'echo', message: 'hi' }, { executor: 'scripted' }, 'bea');
    expect((await a.waitForStatusOf(job.id, 'finished', 'bea')).status).toBe('finished');
  });

  it('a user added later reads secrets only under its prefix', async () => {
    const secrets: Record<string, string | undefined> = { WEBHOOK_SECRET_A: 'admin-secret' };
    const a = await start({ secrets });
    const admin = await a.login();
    const bea = await a.addUser('Bea');
    const beaToken = await a.loginWith(mintLoginCode(a.app.instance, { now: () => new Date() }, bea.id));
    const hook = { action: 'add', name: 'hook', url: 'http://127.0.0.1:9/hook', events: ['*'], secretEnv: 'WEBHOOK_SECRET_A' };
    expect((await a.ui('/ui/api/webhooks', hook, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/webhooks', hook, { token: beaToken })).status).toBe(200);
    const subs = async (token: string) => (await a.api('GET', '/api/webhooks', undefined, session(token))).body.subscriptions;
    expect((await subs(admin))[0].secretProblem).toBeUndefined();
    expect((await subs(beaToken))[0].secretProblem).toEqual(expect.stringContaining('HOPPER_USER_BEA_WEBHOOK_SECRET_A'));
    secrets.HOPPER_USER_BEA_WEBHOOK_SECRET_A = 'bea-secret';
    expect((await subs(beaToken))[0].secretProblem).toBeUndefined();
  });

  it('the processes of a user added later find the CLIs\' config in its own work dir; admin\'s environment is unchanged', async () => {
    const herdr = createFakeHerdrClient({ session: 'fake', turns: [{ output: ['● Done.', '  HOPPER_DONE'] }, { output: ['● Done.', '  HOPPER_DONE'] }] });
    const executors = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
    const a = await start({ plugins: { executors }, seams: { herdr } });
    const bea = await a.addUser('Bea');
    const doc = a.user(bea.id).store.config;
    doc.write('plugins', { version: 1, executors, jobSources: [], usageSources: [], notifiers: [] }, doc.version('plugins'));
    const beaToken = await a.login('bea');
    await waitFor(async () => (await a.api('GET', '/api/plugins', undefined, session(beaToken))).body.config.version === doc.version('plugins'));
    const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
    const adminJob = await a.pull({}, item);
    await a.waitForStatus(adminJob.id, 'finished', 8000);
    const beaJob = await a.pull({}, item, 'bea');
    await a.waitForStatusOf(beaJob.id, 'finished', 'bea', 8000);
    const tabs = herdr.calls.filter((c) => c.method === 'createTab').map((c) => (c.args[0] as { env: Record<string, string> }).env);
    expect(tabs[0]).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(tabs[0]).not.toHaveProperty('GH_CONFIG_DIR');
    expect(tabs[1]).toMatchObject({ CLAUDE_CONFIG_DIR: `${a.dataDir}/users/bea/claude`, GH_CONFIG_DIR: `${a.dataDir}/users/bea/gh` });
  });
});

describe('the instance\'s parts are shared', () => {
  it('an update check is announced to every user; a job of any user that a restart would lose holds the restart, counted, never named', async () => {
    const root = tempDir('jh-users-update-');
    const up = createUpstream(root);
    const c1 = up.commit('first', 'v1');
    up.commit('second', 'v2');
    const appDir = createInstall(root, up.dir, c1);
    const restarts: number[] = [];
    const sticky = createStickyExecutor();
    try {
      const a = await start({ seams: { executors: [sticky], update: { appDir, builder: copyBuilder(), restart: async () => { restarts.push(1); } } } });
      const admin = await a.login();
      await a.addUser('Bea');
      const job = await a.pull({}, { executor: 'sticky' }, 'bea');
      await a.waitForStatusOf(job.id, 'running', 'bea');
      expect((await a.ui('/ui/api/update', { action: 'check' }, { token: admin })).status).toBe(200);
      const beaEvents = (await a.api('GET', '/api/events?limit=1000', undefined, session(await a.login('bea')))).body.events as DomainEvent[];
      expect(beaEvents.map((e) => e.type)).toContain('update.available');
      expect((await a.ui('/ui/api/update', { action: 'apply' }, { token: admin })).status).toBe(200);
      const detail = await waitFor(async () => {
        const d = (await a.api('GET', '/api/update')).body.apply?.detail as string | undefined;
        return d?.startsWith('waiting for') ? d : undefined;
      });
      expect(detail).toBe('waiting for 1 running job: a restart would lose it');
      expect(JSON.stringify(a.user().store.events.since(0, 1000))).not.toContain(job.id);
      expect(restarts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a store install is every user\'s plugin', async () => {
    const root = tempDir('jh-users-store-');
    const repo = createStoreRepo(root);
    repo.addExample('queue-sorter', 'word-first');
    repo.commit('one plugin', [entry('queue-sorter', 'word-first')]);
    try {
      const a = await start({ env: { HOPPER_PLUGIN_STORE: repo.dir } });
      const admin = await a.login();
      await a.addUser('Bea');
      await waitFor(async () => (await a.api('GET', '/api/plugin-store')).body.commit !== undefined);
      expect((await a.ui('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token: admin })).status).toBe(200);
      const beaPlugins = (await a.api('GET', '/api/plugins', undefined, session(await a.login('bea')))).body.plugins as { id: string }[];
      expect(beaPlugins.map((p) => p.id)).toContain('word-first');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a user added with the operator CLI', () => {
  it('a running daemon starts its runtime when it next reads the users', async () => {
    const a = await start();
    const r = runCli(['user', 'add', 'Cy'], { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: () => {}, err: () => {} });
    expect(r).toBe(0);
    await waitFor(() => a.app.users().some((u) => u.id === 'cy') && (() => { try { return a.user('cy'); } catch { return undefined; } })());
    expect((await a.api('GET', '/api/jobs', undefined, session(await a.login('cy')))).status).toBe(200);
  });
});

describe('an install from before several users', () => {
  it('migrations 17 and 21 make its jobs and config admin\'s, and admin\'s runtime runs the job that was waiting', async () => {
    const at = '2026-10-01T00:00:00.000Z';
    const a = await start({}, (dbPath) => {
      const v16 = openDb(untouchedUrlFor(dbPath));
      migrateInstance(v16, 16);
      const job = { id: 'old-job', spec: { executor: 'scripted', payload: { prompt: JSON.stringify({ op: 'echo', message: 'kept' }), cwd: '/tmp', env: {} } }, priority: 50, status: 'queued', approved: false, createdAt: at, updatedAt: at, attempts: 0 };
      v16.run("INSERT INTO jobs (id, status, created_at, body) VALUES ('old-job', 'queued', ?, ?)", at, JSON.stringify(job));
      v16.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('rules.md', 'old rules', ?)", at);
      v16.close();
    });
    const done = await a.waitForStatus('old-job', 'finished');
    expect(done.result).toEqual({ echo: 'kept' });
    expect(withStores(a.dbPath, (instance, admin) => ({ users: instance.users.list().map((u) => u.id), rules: admin.config.read('rules') })))
      .toEqual({ users: ['admin'], rules: 'old rules' });
  });
});
