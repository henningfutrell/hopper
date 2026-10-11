// Issue #718, item 4: an agent sets up its vault and its sandbox boxes with no UI session. A running job asks the job
// door — `/job/vault` and `/job/sandbox`, with its own proxy token, honoured only while the job is at work — and Access
// (OpenFGA, `vault#can_set_secret`, `#can_save_template`, `#can_launch_box`) decides each change. A job never approves:
// a template it saves waits for a person, as one the UI saves does. The real daemon, a joined machine, a job at work;
// OpenFGA and the container runtime are doubles at their ports.
//
// Feature: the vault and sandbox boxes through the job door
//   Scenario: a job sets a secret in its user's vault, and reads the vault without a value
//     Given a running job of a hopper with a master key
//     When the job posts `set DIAG_TOKEN` to /job/vault
//     Then GET /job/vault lists DIAG_TOKEN with its scope and no value
//     And `vault.secret_set` names the job as who set it
//   Scenario: a job saves a template; it waits for a person; the job launches a box of it once a person approved it
//   Scenario: a job cannot approve, remove or give: those actions are not the job door's
//   Scenario: a launch names an approved template; parameters outside its limits are refused; nothing starts
//   Scenario: a token that is not a running job's is refused
//   Scenario: Access decides: a model that gives a job no `vault#can_set_secret` refuses the set, saying why
//   Scenario: a model without the vault type refuses, naming the gap
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import type { AccessView, TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { artifactHarness, eventsOf } from '../support/artifacts.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import type { TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'example.org/diag-box:1';
const VALUE = 'diag-value-0123456789abcdef-never-read-back';

const h = artifactHarness();
afterEach(async () => { await h.stop(); });

async function boot(): Promise<{ a: TestApp; session: string; job: string; token: string; runtime: FakeContainerRuntime }> {
  const runtime = createFakeContainerRuntime();
  const booted = await h.boot({ secrets: { HOPPER_MASTER_KEY: KEY }, seams: { containerRuntime: runtime } });
  const { a, job } = booted;
  return { ...booted, runtime, token: proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job) };
}

interface Answer<T> { status: number; body: T & { error?: string } }
async function door<T = Record<string, unknown>>(a: TestApp, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>> {
  const res = await fetch(`${a.url}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as T & { error?: string } };
}

const diag = (v: VaultView): TemplateView | undefined => v.templates.find((t) => t.name === 'diag');

async function editModel(a: TestApp, session: string, dsl: string): Promise<void> {
  const view = (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body;
  expect((await a.ui('/ui/api/access', { action: 'model', dsl, version: view.model.version }, { token: session })).status).toBe(200);
}

describe('the vault and sandbox boxes through the job door (issue #718)', () => {
  it('a job sets a secret in its user\'s vault, and reads the vault without a value', async () => {
    const { a, job, token } = await boot();
    const set = await door<VaultView>(a, token, 'POST', '/job/vault', { action: 'set', name: 'DIAG_TOKEN', value: VALUE, scope: 'read-only diagnostics' });
    expect(set.status).toBe(200);
    expect(set.body.secrets).toContainEqual(expect.objectContaining({ name: 'DIAG_TOKEN', scope: 'read-only diagnostics' }));

    const read = await door<VaultView>(a, token, 'GET', '/job/vault');
    expect(read.status).toBe(200);
    expect(read.body.secrets.map((s) => s.name)).toContain('DIAG_TOKEN');
    expect(JSON.stringify(read.body)).not.toContain(VALUE);
    expect(eventsOf(a, 'vault.secret_set')).toEqual([expect.objectContaining({ data: expect.objectContaining({ name: 'DIAG_TOKEN', by: `job ${job}` }) })]);
    expect(JSON.stringify(eventsOf(a, 'vault.secret_set'))).not.toContain(VALUE);
  });

  it('a job saves a template; it waits for a person; the job launches a box of it once a person approved it', async () => {
    const { a, session, job, token, runtime } = await boot();
    await door(a, token, 'POST', '/job/vault', { action: 'set', name: 'DIAG_TOKEN', value: VALUE });
    const saved = await door<VaultView>(a, token, 'POST', '/job/vault', {
      action: 'save-template', name: 'diag', image: IMAGE, secrets: ['DIAG_TOKEN'],
      profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'prod' } }], limits: { cpus: { default: 1, max: 2 } },
    });
    expect(saved.status).toBe(200);
    expect(diag(saved.body)).toMatchObject({ pending: { secrets: ['DIAG_TOKEN'], image: true } });
    expect(diag(saved.body)?.approval).toBeUndefined();
    expect(eventsOf(a, 'template.saved')).toEqual([expect.objectContaining({ data: expect.objectContaining({ template: 'diag', by: `job ${job}` }) })]);

    // Not approved: the launch is refused and nothing starts.
    const early = await door(a, token, 'POST', '/job/sandbox', { template: 'diag' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/not approved/);
    expect(runtime.boxes.size).toBe(0);

    // A person approves it; then the job launches a box of it, and lists it.
    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: 'diag' }, { token: session })).status).toBe(200);
    const launched = await door<{ container: string }>(a, token, 'POST', '/job/sandbox', { template: 'diag', params: { cpus: 2, secrets: ['DIAG_TOKEN'] } });
    expect(launched.status).toBe(200);
    expect(runtime.boxes.get(launched.body.container)?.spec.image).toBe(IMAGE);
    const list = await door<{ boxes: { name: string; template?: { name: string } }[] }>(a, token, 'GET', '/job/sandbox');
    expect(list.status).toBe(200);
    expect(list.body.boxes).toEqual([expect.objectContaining({ name: launched.body.container, template: expect.objectContaining({ name: 'diag' }) })]);
  });

  it('a job cannot approve, remove or give: those actions are not the job door\'s', async () => {
    const { a, session, token } = await boot();
    await a.ui('/ui/api/vault', { action: 'set', name: 'DIAG_TOKEN', value: VALUE }, { token: session });
    await a.ui('/ui/api/vault', { action: 'save-template', name: 'diag', image: IMAGE, secrets: ['DIAG_TOKEN'] }, { token: session });
    for (const body of [
      { action: 'approve-template', name: 'diag' },
      { action: 'approve-profile', name: 'diag', operation: 'read', asset: { kind: 'cluster', name: 'prod' } },
      { action: 'revoke-template', name: 'diag' },
      { action: 'remove', name: 'DIAG_TOKEN' },
      { action: 'remove-template', name: 'diag' },
      { action: 'give-credential', request: 'r1', name: 'X', kind: 'token' },
    ]) {
      const r = await door(a, token, 'POST', '/job/vault', body);
      expect(r.status, body.action).toBe(400);
    }
    const v = (await door<VaultView>(a, token, 'GET', '/job/vault')).body;
    expect(diag(v)?.approval).toBeUndefined();
    expect(v.secrets.map((s) => s.name)).toContain('DIAG_TOKEN');
  });

  it('a launch names an approved template; parameters outside its limits are refused; nothing starts', async () => {
    const { a, session, token, runtime } = await boot();
    await a.ui('/ui/api/vault', { action: 'save-template', name: 'diag', image: IMAGE, secrets: [], limits: { cpus: { default: 1, max: 2 } } }, { token: session });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'diag' }, { token: session });
    expect((await door(a, token, 'POST', '/job/sandbox', {})).status).toBe(400);
    expect((await door(a, token, 'POST', '/job/sandbox', { template: 'nope' })).status).toBe(404);
    const wide = await door(a, token, 'POST', '/job/sandbox', { template: 'diag', params: { cpus: 8 } });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toMatch(/at most 2/);
    expect(runtime.boxes.size).toBe(0);
  });

  it('a token that is not a running job\'s is refused', async () => {
    const { a, job, token } = await boot();
    const forged = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, 'no-such-job');
    for (const t of ['nonsense', forged]) {
      expect((await door(a, t, 'GET', '/job/vault')).status).toBe(401);
      expect((await door(a, t, 'POST', '/job/vault', { action: 'set', name: 'X', value: VALUE })).status).toBe(401);
      expect((await door(a, t, 'POST', '/job/sandbox', { template: 'diag' })).status).toBe(401);
    }
    // The job ended: its token opens nothing.
    a.user().store.jobs.update(job, { status: 'finished' });
    const ended = await door(a, token, 'POST', '/job/vault', { action: 'set', name: 'X', value: VALUE });
    expect(ended.status).toBe(401);
    expect(ended.body.error).toMatch(/not at work/);
  });

  it('Access decides: a model that gives a job no vault#can_set_secret refuses the set, saying why', async () => {
    const { a, session, token } = await boot();
    await editModel(a, session, DEFAULT_ACCESS_MODEL.replace(/define can_set_secret: owner/, 'define can_set_secret: [user]'));
    const r = await door(a, token, 'POST', '/job/vault', { action: 'set', name: 'DIAG_TOKEN', value: VALUE });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/may not set a secret in vault:/);
    expect((await door<VaultView>(a, token, 'GET', '/job/vault')).body.secrets.map((s) => s.name)).not.toContain('DIAG_TOKEN');
    // The other actions are decided apart: saving a template still works.
    expect((await door(a, token, 'POST', '/job/vault', { action: 'save-template', name: 'diag', image: IMAGE, secrets: [] })).status).toBe(200);
  });

  it('a model without the vault type refuses, naming the gap', async () => {
    const { a, session, token } = await boot();
    const edited = DEFAULT_ACCESS_MODEL.replace(/# A user's vault and sandbox boxes[\s\S]*?define can_launch_box: owner\n/, '');
    expect(edited).not.toMatch(/^type vault$/m);
    await editModel(a, session, edited);
    const r = await door(a, token, 'POST', '/job/vault', { action: 'set', name: 'DIAG_TOKEN', value: VALUE });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('vault#owner');
  });
});
