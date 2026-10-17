// The cloud link (issue #467, design.md "The cloud link"): linking an install to hopper.io moves no data. On a fixture
// database with two users and their work, a link writes only its own record in the instance's settings, and an unlink
// removes it: every other row of every table, the instance's and each user's, is as it was.
//   Scenario: link then unlink a fixture database; every table but the link record is unchanged
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/store.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { createCloudLink } from '../../src/http/cloud-link.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { fixedClock, spec } from '../store/helpers.ts';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** An install with two users, each with a job, a question, an event, a setting and a webhook, and instance settings. */
function fixture(url: string): InstanceStore {
  const instance = openInstanceStore({ url, clock: fixedClock() });
  closers.push(() => instance.close());
  instance.settings.setAllowedHosts(['hopper.example.net']);
  instance.settings.setUpdateSettings({ channel: 'beta', autoUpdate: true });
  instance.users.add('octo');
  for (const user of instance.users.list()) {
    const store = instance.userStore(user);
    const job = store.jobs.create(spec, 50);
    store.questions.create({ jobId: job.id, text: 'which way?', recentOutput: '', detectedBy: 'marker', tier: 'human' });
    store.events.append({ type: 'job.queued', jobId: job.id, data: {} });
    store.settings.setQueueGate({ mode: 'review', autoAcceptPerHour: null });
    store.webhooks.add({ name: 'hook', url: 'http://127.0.0.1:1/hook', events: ['job.*'], active: true });
    store.close();
  }
  return instance;
}

/** Every row of every table of the install — the instance's schema and each user's — as sorted text, by table. */
function snapshot(db: Db, schema: string): Record<string, string[]> {
  const tables = db.all("SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE (table_schema = ? OR table_schema LIKE ?) AND table_type = 'BASE TABLE' ORDER BY 1, 2", schema, `${schema}\\_u\\_%`);
  const out: Record<string, string[]> = {};
  for (const { s, t } of tables) out[`${String(s)}.${String(t)}`] = db.all(`SELECT * FROM "${String(s)}"."${String(t)}"`).map((r) => JSON.stringify(r)).sort();
  return out;
}

describe('the cloud link on a fixture database', () => {
  it('a link writes only its own record; an unlink removes it and leaves every table as it was', () => {
    const url = installFromBefore(testDatabaseUrl());
    const schema = new URL(url).searchParams.get('schema')!;
    const instance = fixture(url);
    const raw = openDb(url);
    closers.push(() => raw.close());
    const events: NewEvent[] = [];
    const link = createCloudLink({ settings: instance.settings, events: { append: (e) => { events.push(e); } }, now: () => new Date('2026-10-17T08:00:00.000Z') });

    const before = snapshot(raw, schema);
    expect(Object.keys(before).filter((t) => t.includes('_u_')).length).toBeGreaterThan(1);
    const linked = link.link('octo-cat', 'admin');
    expect(linked.link).toMatchObject({ account: 'octo-cat', state: 'pending', linkedAt: '2026-10-17T08:00:00.000Z', by: 'admin' });

    const during = snapshot(raw, schema);
    const settings = `${schema}.settings`;
    expect({ ...during, [settings]: undefined }).toEqual({ ...before, [settings]: undefined });
    const added = during[settings]!.filter((r) => !before[settings]!.includes(r));
    expect(added.map((r) => (JSON.parse(r) as { key: string }).key)).toEqual(['cloudLink']);
    expect(before[settings]!.every((r) => during[settings]!.includes(r))).toBe(true);

    expect(link.unlink('admin')).toEqual({ link: null });
    expect(snapshot(raw, schema)).toEqual(before);
    expect(events.map((e) => e.type)).toEqual(['cloud_link.linked', 'cloud_link.unlinked']);
  });
});
