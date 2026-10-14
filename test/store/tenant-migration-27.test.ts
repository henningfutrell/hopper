// Tenant migration 27 (issue #567): the logins a device-flow polling loop flooded — the same job and tool reported
// again every few seconds, each one marked completed — collapse into one per real prompt. A login reported while
// the one before it still lived (before its `expiresAt`) is that login again: it goes, and the one kept takes its
// last status, end and expiry. A login reported after the one before it expired is a prompt of its own and stays;
// so do another tool's, another job's and a question's. Events are never rewritten. A second run changes nothing.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { collapseFloodedLogins } from '../../src/store/migration-login-flood.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const at = (sec: number): string => new Date(Date.parse('2026-10-09T10:00:00.000Z') + sec * 1000).toISOString();

function login(raw: Db, id: string, o: { job?: string; question?: string; tool?: string; created: number; status: string; ended?: number; reason?: string }): Record<string, unknown> {
  const body = {
    id, ...(o.job ? { jobId: o.job } : {}), ...(o.question ? { questionId: o.question } : {}), run: 'herdr-claude', renewable: true,
    kind: 'device_code', tool: o.tool ?? 'python auth.py', status: o.status, expiresAt: at(o.created + 900),
    createdAt: at(o.created), updatedAt: at(o.ended ?? o.created), ...(o.ended !== undefined ? { endedAt: at(o.ended) } : {}),
    ...(o.reason ? { reason: o.reason } : {}),
  };
  raw.run('INSERT INTO logins (id, job_id, question_id, status, created_at, body) VALUES (?, ?, ?, ?, ?, ?)',
    id, o.job ?? null, o.question ?? null, o.status, body.createdAt, JSON.stringify(body));
  return body;
}

const rows = (raw: Db) => raw.all('SELECT id, status, body FROM logins ORDER BY seq').map((r) => ({ id: String(r.id), status: String(r.status), ...JSON.parse(String(r.body)) as Record<string, unknown> }));

function seeded(): { raw: Db; kept: Record<string, unknown>; apart: Record<string, unknown>[] } {
  const raw = t.tenantAt(t.url(), 26);
  // The flood: one job, one tool, a new login every 6 s, each completed by the next poll; the last failed when the job ended.
  const kept = login(raw, 'f0', { job: 'j1', created: 0, status: 'completed', ended: 5 });
  for (let i = 1; i < 40; i++) login(raw, `f${i}`, { job: 'j1', created: i * 6, status: 'completed', ended: i * 6 + 5 });
  login(raw, 'f40', { job: 'j1', created: 240, status: 'failed', ended: 300, reason: 'the job ended' });
  // The same job's prompt after the flood's last code expired: a prompt of its own.
  const apart = [
    login(raw, 'later', { job: 'j1', created: 240 + 901, status: 'completed', ended: 1200 }),
    // Another tool, another job, a question's: none of them the flood.
    login(raw, 'gh', { job: 'j1', tool: 'gh', created: 10, status: 'completed', ended: 60 }),
    login(raw, 'other-job', { job: 'j2', created: 12, status: 'pending' }),
    login(raw, 'question', { question: 'q1', tool: 'gh', created: 14, status: 'failed', ended: 30, reason: 'the run ended' }),
  ];
  raw.run(
    'INSERT INTO events (id, type, at, job_id, lane_id, machine_id, decision_id, data, question_id, schema_version) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, 1)',
    'e1', 'auth.completed', at(5), 'j1', JSON.stringify({ loginId: 'f1', kind: 'device_code', tool: 'python auth.py' }),
  );
  return { raw, kept, apart };
}

describe('tenant migration 27: a flooded login collapses into one', () => {
  it('keeps the first of each run of re-reports, with the last one\'s status, end and expiry; leaves every other login', () => {
    const { raw, kept, apart } = seeded();
    migrateTenant(raw, 27);
    expect(rows(raw)).toEqual([
      { ...kept, status: 'failed', endedAt: at(300), updatedAt: at(300), expiresAt: at(240 + 900), reason: 'the job ended' },
      ...apart,
    ]);
    expect(raw.all("SELECT id FROM events WHERE type = 'auth.completed'")).toHaveLength(1);
    raw.close();
  });

  it('a second run changes nothing', () => {
    const { raw } = seeded();
    migrateTenant(raw, 27);
    const once = rows(raw);
    collapseFloodedLogins(raw);
    expect(rows(raw)).toEqual(once);
    raw.close();
  });
});
