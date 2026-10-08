// Issue #451: the key webhook signing secrets are sealed under is the runtime's HOPPER_TOKEN_KEY. With none,
// no secret is stored and a stored one is said to be unreadable — never read as "no secret". A new key with
// the old one as HOPPER_TOKEN_KEY_PREVIOUS seals every secret again at start. A subscription from before
// keeps reading the runtime variable it names (also as NAME_FILE) until a secret is stored for it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSealer } from '../../src/secrets/sealer.ts';
import { waitFor } from '../support/wait.ts';
import { edit, ENTERED, KEY, list, NEW_KEY, nextDelivery, REPLACED, rowOf, signatureOf, storedRows, subOf, TWO, useWebhookApp } from '../support/webhooks.ts';

const { start, restart, receiver, nowhere } = useWebhookApp();

describe('the encryption key (HOPPER_TOKEN_KEY)', () => {
  it('none: a secret is not stored, and the answer says why; nothing written', async () => {
    const { a, token } = await start([], { WEBHOOK_SECRET_X: 'x' });
    for (const body of [
      { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED },
      { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'] },
    ]) {
      const r = await edit(a, token, body);
      expect(r.status).toBe(503);
      expect(r.body.error).toContain('HOPPER_TOKEN_KEY is not set');
    }
    expect(storedRows(a)).toEqual([]);
  });

  it('gone after a secret was stored: unreadable, said plainly — never "no secret"; nothing sent', async () => {
    const { a: first, token: t1 } = await start();
    await edit(first, t1, { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: ENTERED });
    const { a, token } = await restart(first, {});
    const problem = subOf(await list(a), 'hook').secretProblem as string;
    expect(problem).toContain('HOPPER_TOKEN_KEY is not set');
    expect(problem).toContain('cannot be opened');
    const res = await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token });
    expect(res.body).toMatchObject({ ok: false, detail: problem });
  });

  it('another key: unreadable, naming the key id it was sealed under; a delivery retries with that reason', async () => {
    const rx = await receiver();
    const { a: first, token: t1 } = await start();
    await edit(first, t1, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secret: ENTERED });
    const { a } = await restart(first, { HOPPER_TOKEN_KEY: NEW_KEY });
    const problem = subOf(await list(a), 'rx').secretProblem as string;
    expect(problem).toContain(`sealed under key ${createSealer(KEY).keyId}`);
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const d = await waitFor(() => a.user().store.webhooks.listDeliveries({ limit: 10 }).find((x) => x.eventType === 'job.finished' && x.lastError));
    expect(d.lastError).toContain('cannot be opened');
    expect(rx.received).toHaveLength(0);
  });

  it('a new key with the old one as HOPPER_TOKEN_KEY_PREVIOUS: sealed again under the new key at start; deliveries keep signing', async () => {
    const rx = await receiver();
    const { a: first, token: t1 } = await start();
    await edit(first, t1, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secret: ENTERED });
    const { a } = await restart(first, { HOPPER_TOKEN_KEY: NEW_KEY, HOPPER_TOKEN_KEY_PREVIOUS: KEY });
    expect(String(rowOf(a, 'rx').secret_sealed).split('.')[1]).toBe(createSealer(NEW_KEY).keyId);
    const got = await nextDelivery(a, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, got));
    await nowhere(a, ENTERED);
  });
});

describe('a subscription from before issue #451: its secret from the runtime variable it names', () => {
  it('keeps signing from the variable, and says so', async () => {
    const { a } = await start(TWO, { HOPPER_TOKEN_KEY: KEY, WEBHOOK_SECRET_GROK: 's-grok' });
    const body = await list(a);
    expect(body.subscriptions.map((s: Record<string, unknown>) => [s.name, s.secretEnv, s.secretProblem, s.secretChangedAt])).toEqual([
      ['grok-bot', 'WEBHOOK_SECRET_GROK', undefined, undefined],
      ['other', 'WEBHOOK_SECRET_OTHER', 'WEBHOOK_SECRET_OTHER is not set', undefined],
    ]);
    expect(JSON.stringify(body)).not.toContain('s-grok');
  });

  it('a delivery signs with the secret from a mounted secret file (NAME_FILE)', async () => {
    const rx = await receiver();
    const file = join(mkdtempSync(join(tmpdir(), 'jh-mounted-')), 'hook');
    writeFileSync(file, 'from-mounted-file\n', { mode: 0o600 });
    const { a } = await start([{ name: 'rx', url: rx.url, events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_RX' }], { HOPPER_TOKEN_KEY: KEY, WEBHOOK_SECRET_RX_FILE: file });
    const got = await nextDelivery(a, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf('from-mounted-file', got));
  });

  it('replace stores the secret in the hopper: the variable is no longer named or read', async () => {
    const rx = await receiver();
    const secrets: Record<string, string> = { HOPPER_TOKEN_KEY: KEY, WEBHOOK_SECRET_RX: 'from-runtime' };
    const { a, token } = await start([{ name: 'rx', url: rx.url, events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_RX' }], secrets);
    const r = await edit(a, token, { action: 'replace', name: 'rx', secret: REPLACED });
    expect(r.status).toBe(200);
    expect(subOf(r.body, 'rx')).not.toHaveProperty('secretEnv');
    expect(rowOf(a, 'rx').secret_env).toBe('');
    delete secrets.WEBHOOK_SECRET_RX;
    const got = await nextDelivery(a, rx);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(REPLACED, got));
  });
});

