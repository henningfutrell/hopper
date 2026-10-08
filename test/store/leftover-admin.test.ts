// The leftover default admin account (issue #265): on a hopper from before issue #238, the user `admin`
// stays beside the user the first GitHub admin signs in as. It is folded into that user — the real
// account — and is gone: every job, question, decision, event, lane, webhook, setting and config entry
// of either is the real user's, under the real user's id and name, with every sign-in, session and code.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { foldLeftoverAdmin } from '../../src/users/leftover-admin.ts';
import { installFromBefore, testPostgres } from '../support/database.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const schemaOf = (url: string): string => new URL(url).searchParams.get('schema')!;
const FUTURE = '2099-01-01T00:00:00.000Z';
const NOW = '2026-10-02T10:00:00.000Z';
const identity = { realm: 'github', subject: '42', groups: [] };

/** An install from before with `admin`'s work, and `octo` — the user GitHub user 42 signs in as — with work of its own. */
function twoUsers(o: { recordAdmin?: boolean } = {}) {
  const url = installFromBefore(t.url());
  const instance = openInstanceStore({ url, clock: fixedClock() });
  const admin = instance.userStore(instance.users.get('admin')!);
  const adminJob = admin.jobs.create(spec, 50);
  const adminQuestion = admin.questions.create({ jobId: adminJob.id, text: 'admin q?', recentOutput: '', detectedBy: 'marker', tier: 'human' });
  admin.events.append({ type: 'job.queued', jobId: adminJob.id, data: {} });
  admin.config.write('rules', 'admin rules', 'missing');
  admin.config.write('plugins', {
    version: 1,
    machines: [{ name: 'local', plugin: 'local', options: { lanes: 4, session: 'hopper' } }],
    jobSources: [{ name: 'github', plugin: 'github-gh', options: {} }],
    executors: [{ name: 'test', plugin: 'test' }],
  }, admin.config.version('plugins'));
  admin.settings.setQueueGate({ mode: 'review', autoAcceptPerHour: null });
  admin.webhooks.add({ name: 'hook', url: 'http://127.0.0.1:1/admin', events: ['job.*'], active: true });
  admin.close();

  const octoUser = instance.users.add('octo');
  instance.identities.link('github', '42', octoUser.id);
  const octo = instance.userStore(octoUser);
  const octoJob = octo.jobs.create(spec, 60);
  const octoEvent = octo.events.append({ type: 'job.queued', jobId: octoJob.id, data: {} });
  octo.config.write('rules', 'octo rules', 'missing');
  octo.config.write('plugins', {
    version: 1,
    machines: [{ name: 'local', plugin: 'local', options: { lanes: 2, session: 'octo' } }],
    jobSources: [{ name: 'github-account', plugin: 'github-account', options: {} }],
  }, octo.config.version('plugins'));
  octo.settings.setQueueGate({ mode: 'auto-accept', autoAcceptPerHour: 5 });
  octo.webhooks.add({ name: 'hook', url: 'http://127.0.0.1:1/octo', events: ['job.*'], active: true });
  const octoHook = octo.webhooks.add({ name: 'octo-hook', url: 'http://127.0.0.1:1/octo-2', events: ['job.*'], active: true })!;
  const delivery = octo.webhooks.createDelivery(octoHook.id, octoEvent);
  octo.connectedAccounts.put({ provider: 'github', account: 'octo', subject: '42', accessToken: 'tok', connectedAt: NOW });
  octo.close();

  instance.uiSessions.create({ tokenHash: 'octo-session', startedAt: NOW, lastSeenAt: NOW, checkedAt: NOW, role: 'admin', identity, userId: 'octo' });
  instance.loginCodes.create('admin-code', FUTURE, 'admin');
  if (o.recordAdmin !== false) {
    const store = instance.signInConfig;
    expect(store.write({ ...store.read(), githubAdmin: { realm: 'github', subject: '42' } }, store.version())).toBe(true);
  }
  return { url, instance, adminJob, adminQuestion, octoJob, octoEvent, delivery };
}

describe('the leftover default admin account is folded into the first GitHub admin\'s user (issue #265)', () => {
  it('leaves one user, the real one, holding everything both held', () => {
    const { url, instance, adminJob, adminQuestion, octoJob, octoEvent, delivery } = twoUsers();
    expect(foldLeftoverAdmin(instance)).toEqual({ from: 'admin', into: 'octo' });

    expect(instance.users.list()).toEqual([expect.objectContaining({ id: 'octo', name: 'octo' })]);
    expect(instance.users.get('admin')).toBeUndefined();
    // Sign-ins, sessions and login codes of either are the real user's.
    expect(instance.identities.userOf('github', '42')).toBe('octo');
    expect(instance.identities.userOf('none', 'anonymous')).toBe('octo');
    expect(instance.uiSessions.get('octo-session')?.userId).toBe('octo');
    expect(instance.loginCodes.live('admin-code', NOW)).toBe('octo');

    const store = instance.userStore(instance.users.get('octo')!);
    expect(store.jobs.list().map((j) => j.id).sort()).toEqual([adminJob.id, octoJob.id].sort());
    expect(store.questions.get(adminQuestion.id)?.text).toBe('admin q?');
    expect(store.events.since(0).map((e) => e.jobId).sort()).toEqual([adminJob.id, octoJob.id].sort());
    // Config and settings: the leftover's, which ran the hopper; what only the real user had joins it.
    expect(store.config.read('rules')).toBe('admin rules');
    expect(store.config.read('plugins')).toEqual({
      version: 1,
      machines: [{ name: 'local', plugin: 'local', options: { lanes: 4, session: 'hopper' } }],
      jobSources: [{ name: 'github', plugin: 'github-gh', options: {} }, { name: 'github-account', plugin: 'github-account', options: {} }],
      executors: [{ name: 'test', plugin: 'test' }],
    });
    expect(store.settings.getQueueGate()).toEqual({ mode: 'review', autoAcceptPerHour: null });
    expect(store.webhooks.list().map((w) => [w.name, w.url]).sort()).toEqual([['hook', 'http://127.0.0.1:1/admin'], ['octo-hook', 'http://127.0.0.1:1/octo-2']]);
    // A pending delivery goes with its subscription, naming its event where it now is.
    const moved = store.events.since(0).find((e) => e.id === octoEvent.id)!;
    expect(store.webhooks.dueDeliveries(new Date(FUTURE))).toEqual([expect.objectContaining({ id: delivery.id, eventSeq: moved.seq })]);
    // The real user's own GitHub connection stays theirs.
    expect(store.connectedAccounts.get('github')).toMatchObject({ account: 'octo', accessToken: 'tok' });
    // New rows go on after everything moved.
    const next = store.jobs.create(spec, 50);
    expect(store.jobs.list().map((j) => j.id)).toContain(next.id);
    store.close();
    instance.close();

    const raw = openDb(testPostgres());
    expect(raw.all('SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name LIKE ? ORDER BY 1', `${schemaOf(url)}_u_%`))
      .toEqual([{ s: `${schemaOf(url)}_u_octo` }]);
    raw.close();
  });

  it('keeps the leftover\'s place: the record that ran the hopper, its work dir and secret prefix, under the real user\'s id and name', () => {
    const { instance } = twoUsers();
    const before = instance.users.get('admin')!;
    foldLeftoverAdmin(instance);
    expect(instance.users.get('octo')).toEqual({ ...before, id: 'octo', name: 'octo' });
    instance.close();
  });

  it('does nothing when no GitHub admin is recorded, or the GitHub admin signs in as admin itself', () => {
    const { instance } = twoUsers({ recordAdmin: false });
    expect(foldLeftoverAdmin(instance)).toBeUndefined();
    expect(instance.users.list().map((u) => u.id)).toEqual(['admin', 'octo']);
    const store = instance.signInConfig;
    store.write({ ...store.read(), githubAdmin: { realm: 'github', subject: 'not-linked' } }, store.version());
    expect(foldLeftoverAdmin(instance)).toBeUndefined();
    instance.close();

    const url = installFromBefore(t.url());
    const alone = openInstanceStore({ url, clock: fixedClock() });
    alone.identities.link('github', '7', 'admin');
    alone.signInConfig.write({ ...alone.signInConfig.read(), githubAdmin: { realm: 'github', subject: '7' } }, alone.signInConfig.version());
    expect(foldLeftoverAdmin(alone)).toBeUndefined();
    expect(alone.users.list().map((u) => u.id)).toEqual(['admin']);
    alone.close();
  });

  it('does nothing on a hopper with no leftover', () => {
    const instance = openInstanceStore({ url: t.url(), clock: fixedClock() });
    const octo = instance.users.add('octo');
    instance.identities.link('github', '42', octo.id);
    instance.signInConfig.write({ ...instance.signInConfig.read(), githubAdmin: { realm: 'github', subject: '42' } }, instance.signInConfig.version());
    expect(foldLeftoverAdmin(instance)).toBeUndefined();
    expect(instance.users.list().map((u) => u.id)).toEqual(['octo']);
    instance.close();
  });
});
