// Issue #18: webhook subscriptions are edited from the UI. Issue #78: the subscriptions are rows in the
// database and nothing else — POST /ui/api/webhooks adds, changes or removes one row, and the answer
// shows it. No config record holds them.
// Issue #451: a subscription's signing secret is the hopper's own. It is typed in or made by the hopper,
// kept in the database sealed under the runtime's HOPPER_MASTER_KEY (src/secrets/sealer.ts), and write-only:
// no answer, log line or event carries it, except the one answer that shows a secret the hopper made.
// Replace and Rotate apply from the next delivery. A subscription from before keeps reading the runtime
// variable it names until a secret is stored for it.
import { describe, expect, it } from 'vitest';
import { CONFIG_NAMES } from '../../src/domain/ports.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import {
  BEFORE, edit, ENTERED, KEY, list, nextDelivery, REPLACED, rowOf, signatureOf, stored, storedRows, subOf, TWO, useWebhookApp, RUNTIME,
} from '../support/webhooks.ts';

const { start, restart, receiver, nowhere } = useWebhookApp();

describe('GET /api/webhooks: what the UI edits', () => {
  it('a stored secret shows as set, with when it changed; never the secret; no config record', async () => {
    const { a, token } = await start();
    expect((await edit(a, token, { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED })).status).toBe(200);
    const sub = subOf(await list(a), 'hook');
    expect(sub.secretChangedAt).toEqual(expect.any(String));
    expect(sub).not.toHaveProperty('secretEnv');
    expect(sub).not.toHaveProperty('secretProblem');
    expect(sub).not.toHaveProperty('secret');
    await nowhere(a, ENTERED);
    expect(await list(a)).not.toHaveProperty('config');
  });

  it('no config record holds them', () => {
    expect(CONFIG_NAMES).not.toContain('webhooks');
  });
});

describe('POST /ui/api/webhooks — add', () => {
  it('with a secret typed in: stored sealed, answered never, and deliveries are signed with it', async () => {
    const { a, token } = await start();
    const rx = await receiver();
    const r = await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secret: ENTERED });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(ENTERED);
    expect(r.body).not.toHaveProperty('generatedSecret');
    const got = await nextDelivery(a, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, got));
    await nowhere(a, ENTERED);
  });

  it('the stored column is ciphertext under the runtime\'s key, bound to the subscription', async () => {
    const { a, token } = await start();
    await edit(a, token, { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED });
    const row = rowOf(a, 'hook');
    expect(JSON.stringify(row)).not.toContain(ENTERED);
    expect(row.secret_env).toBe('');
    expect(String(row.secret_sealed)).toMatch(/^hs1\./);
    expect(createSealer(KEY).open(String(row.secret_sealed), `webhook:${String(row.id)}/signing-secret`)).toBe(ENTERED);
  });

  it('with no secret: the hopper makes one, shows it in this answer only, and signs with it', async () => {
    const { a, token } = await start();
    const rx = await receiver();
    const r = await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'] });
    expect(r.status).toBe(200);
    const made = r.body.generatedSecret as string;
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    const got = await nextDelivery(a, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(made, got));
    await nowhere(a, made);
    // Shown once: the next answer has none.
    expect((await edit(a, token, { action: 'edit', name: 'rx', active: true })).body).not.toHaveProperty('generatedSecret');
  });

  it('the first subscription, inactive', async () => {
    const { a, token } = await start();
    const r = await edit(a, token, { action: 'add', name: 'first', url: 'https://example.invalid/h', events: ['*'], active: false });
    expect(r.status).toBe(200);
    expect((await list(a)).subscriptions).toMatchObject([{ name: 'first', events: ['*'], active: false }]);
  });

  it('a name already there: 409, nothing written', async () => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'add', name: 'other', url: 'http://127.0.0.1:1/x', events: ['*'], secret: ENTERED });
    expect(r.status).toBe(409);
    expect(stored(a)).toEqual(BEFORE);
    expect(rowOf(a, 'other').secret_sealed).toBeNull();
  });

  it.each([
    ['a non-http url', { url: 'ftp://127.0.0.1/x', events: ['*'] }, 'url'],
    ['an unknown event type', { url: 'http://127.0.0.1:1/x', events: ['job.exploded'] }, 'must be an event type or "*"'],
    ['no events', { url: 'http://127.0.0.1:1/x', events: [] }, 'events'],
    ['a short secret', { url: 'http://127.0.0.1:1/x', events: ['*'], secret: 'short' }, 'secret'],
    ['a secret with a space', { url: 'http://127.0.0.1:1/x', events: ['*'], secret: `${ENTERED} x` }, 'secret'],
  ])('%s: 400 naming the field, nothing written; the secret not echoed', async (_what, fields, message) => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'add', name: 'bad', ...fields });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(message);
    if ('secret' in fields) expect(r.body.error).not.toContain(fields.secret);
    expect(stored(a)).toEqual(BEFORE);
  });

  it('a runtime variable (secretEnv) or a version in the body: 400, nothing written', async () => {
    const { a, token } = await start(TWO);
    for (const extra of [{ secretEnv: 'WEBHOOK_SECRET_N' }, { secretEnv: 'WEBHOOK_SECRET_N', secret: ENTERED }, { version: 'missing' }]) {
      const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], ...extra });
      expect(r.status).toBe(400);
    }
    expect(stored(a)).toEqual(BEFORE);
  });

  it('the answer is never cached', async () => {
    const { a, token } = await start();
    const res = await fetch(`${a.url}/ui/api/webhooks`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: a.url, 'x-hopper-session': token },
      body: JSON.stringify({ action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /ui/api/webhooks — replace and rotate', () => {
  it('replace: the next delivery is signed with the new secret, without a restart; never answered', async () => {
    const { a, token } = await start();
    const rx = await receiver();
    await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secret: ENTERED });
    const changedAt = subOf(await list(a), 'rx').secretChangedAt as string;
    const first = await nextDelivery(a, rx);
    expect(first.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, first));
    await new Promise((r) => setTimeout(r, 5));
    const r = await edit(a, token, { action: 'replace', name: 'rx', secret: REPLACED });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(REPLACED);
    expect(r.body).not.toHaveProperty('generatedSecret');
    expect(subOf(r.body, 'rx').secretChangedAt).not.toBe(changedAt);
    const second = await nextDelivery(a, rx);
    expect(second.headers['x-hopper-signature']).toBe(signatureOf(REPLACED, second));
    await nowhere(a, REPLACED);
    await nowhere(a, ENTERED);
  });

  it('rotate: the hopper makes a new secret, shows it once, and the next delivery is signed with it', async () => {
    const { a, token } = await start();
    const rx = await receiver();
    await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secret: ENTERED });
    const r = await edit(a, token, { action: 'rotate', name: 'rx' });
    expect(r.status).toBe(200);
    const made = r.body.generatedSecret as string;
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    const got = await nextDelivery(a, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(made, got));
    await nowhere(a, made);
  });

  it('a bad secret, an unknown name, or rotate with a secret: refused, nothing changed', async () => {
    const { a, token } = await start();
    await edit(a, token, { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED });
    const sealed = rowOf(a, 'hook').secret_sealed;
    expect((await edit(a, token, { action: 'replace', name: 'hook', secret: 'short' })).status).toBe(400);
    expect((await edit(a, token, { action: 'replace', name: 'hook' })).status).toBe(400);
    expect((await edit(a, token, { action: 'rotate', name: 'hook', secret: REPLACED })).status).toBe(400);
    expect((await edit(a, token, { action: 'replace', name: 'nope', secret: REPLACED })).status).toBe(404);
    expect((await edit(a, token, { action: 'rotate', name: 'nope' })).status).toBe(404);
    expect(rowOf(a, 'hook').secret_sealed).toBe(sealed);
  });

  it('edit takes no secret: 400', async () => {
    const { a, token } = await start(TWO);
    expect((await edit(a, token, { action: 'edit', name: 'other', secret: ENTERED })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', secretEnv: 'WEBHOOK_SECRET_Y' })).status).toBe(400);
    expect(stored(a)).toEqual(BEFORE);
  });
});

describe('POST /ui/api/webhooks — edit', () => {
  it('changes url, events and active of one row; the other row and its secret stay', async () => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'edit', name: 'other', url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false });
    expect(r.status).toBe(200);
    expect(subOf(r.body, 'other')).toMatchObject({ url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false, secretEnv: 'WEBHOOK_SECRET_OTHER' });
    expect(stored(a)).toEqual([BEFORE[0], { name: 'other', url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false }]);
  });

  it('only the fields sent change; the id and the stored secret stay', async () => {
    const { a, token } = await start();
    await edit(a, token, { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED });
    const { id, secret_sealed: sealed } = rowOf(a, 'hook');
    expect((await edit(a, token, { action: 'edit', name: 'hook', active: false })).status).toBe(200);
    expect(rowOf(a, 'hook')).toMatchObject({ id, secret_sealed: sealed, active: 0 });
  });

  it('no such name: 404; a name or bad url in the body: 400', async () => {
    const { a, token } = await start(TWO);
    expect((await edit(a, token, { action: 'edit', name: 'nope', active: false })).status).toBe(404);
    expect((await edit(a, token, { action: 'edit', name: 'other', newName: 'x' })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', url: 'not a url' })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', events: ['job.exploded'] })).status).toBe(400);
    expect(stored(a)).toEqual(BEFORE);
  });
});

describe('POST /ui/api/webhooks — remove', () => {
  it('drops the row and its secret with it; the other stays', async () => {
    const { a, token } = await start(TWO);
    await edit(a, token, { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED });
    const r = await edit(a, token, { action: 'remove', name: 'hook' });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot', 'other']);
    expect(storedRows(a).map((row) => row.name)).toEqual(['grok-bot', 'other']);
    expect(storedRows(a).every((row) => row.secret_sealed === null)).toBe(true);
  });

  it('no such name: 404', async () => {
    const { a, token } = await start(TWO);
    expect((await edit(a, token, { action: 'remove', name: 'nope' })).status).toBe(404);
  });
});

describe('subscriptions survive a restart', () => {
  it('a subscription added from the UI, and its secret, are there after the daemon restarts on the same database', async () => {
    const rx = await receiver();
    const { a, token } = await start();
    expect((await edit(a, token, { action: 'add', name: 'kept', url: rx.url, events: ['job.finished'], secret: ENTERED })).status).toBe(200);
    const { a: again } = await restart(a, { ...RUNTIME });
    expect((await list(again)).subscriptions.map((s: { name: string }) => s.name)).toEqual(['kept']);
    const got = await nextDelivery(again, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, got));
  });
});

describe('POST /ui/api/webhooks — the guard', () => {
  it('without a UI session: 403, nothing changed', async () => {
    const { a } = await start(TWO);
    expect((await a.ui('/ui/api/webhooks', { action: 'remove', name: 'other' })).status).toBe(403);
    expect((await a.ui('/ui/api/webhooks', { action: 'rotate', name: 'other' })).status).toBe(403);
    expect(stored(a)).toEqual(BEFORE);
    expect(rowOf(a, 'other').secret_sealed).toBeNull();
  });
});

// Issue #378: a test event checks the URL and the secret without waiting for a real event.
describe('POST /ui/api/webhooks/test — Send test event', () => {
  it('posts one signed test event to the subscription and answers the HTTP result; no delivery is stored', async () => {
    const r = await receiver();
    const { a, token } = await start();
    await edit(a, token, { action: 'add', name: 'hook', url: r.url, events: ['*'], secret: ENTERED });
    const res = await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 200 });
    expect(r.received).toHaveLength(1);
    const got = r.received[0]!;
    expect(got.headers['x-hopper-event']).toBe('webhook.test');
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, got));
    expect(JSON.parse(got.body)).toMatchObject({ type: 'webhook.test', data: { test: true, subscription: 'hook' } });
    expect(a.user().store.webhooks.listDeliveries({ limit: 10 })).toEqual([]);
  });

  // Issue #481: the test event has the type the subscription names, so the receiver's routing matches real events.
  it('a subscription to question.escalated_to_human: the test event has that type, marked test, shaped like the real data', async () => {
    const r = await receiver();
    const { a, token } = await start();
    await edit(a, token, { action: 'add', name: 'grok', url: r.url, events: ['question.escalated_to_human'], secret: ENTERED });
    const res = await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'grok' }, { token });
    expect(res.body).toMatchObject({ ok: true, status: 200 });
    const got = r.received[0]!;
    expect(got.headers['x-hopper-event']).toBe('question.escalated_to_human');
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, got));
    expect(JSON.parse(got.body)).toMatchObject({ type: 'question.escalated_to_human', data: { test: true, subscription: 'grok', questionId: expect.any(String) } });
    expect(a.user().store.webhooks.listDeliveries({ limit: 10 })).toEqual([]);
  });

  it('a receiver refusing it: ok false with its status', async () => {
    const r = await receiver(401);
    const { a, token } = await start();
    await edit(a, token, { action: 'add', name: 'hook', url: r.url, events: ['*'], secret: ENTERED });
    expect((await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token })).body).toMatchObject({ ok: false, status: 401 });
  });

  it('its runtime variable unset: nothing sent, the answer says why; no such name: 404; no session: 403', async () => {
    const r = await receiver();
    const { a, token } = await start([{ name: 'hook', url: r.url, events: ['*'], secretEnv: 'WEBHOOK_SECRET_NONE' }]);
    const res = await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token });
    expect(res.body).toMatchObject({ ok: false, detail: 'WEBHOOK_SECRET_NONE is not set' });
    expect(r.received).toHaveLength(0);
    expect((await a.ui('/ui/api/webhooks/test', { name: 'nope' }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/webhooks/test', { name: 'hook' })).status).toBe(403);
  });
});
