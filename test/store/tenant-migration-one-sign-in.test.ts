// The migration of issue #2898: a store from before may hold two waiting sign-ins on one machine and tool. The newest stays; each
// older one is cancelled, so the unique index can hold. A job's logins, ended sign-ins, other machines' and other tools' stay as
// they were.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function login(raw: Db, id: string, o: { status?: string; machineId?: string; tool?: string; run?: string; jobId?: string }): void {
  const at = `2026-11-02T10:00:${id.padStart(2, '0')}.000Z`;
  const body = {
    id, kind: 'paste_code', tool: o.tool ?? 'claude', run: o.run ?? 'sign-in', renewable: false, status: o.status ?? 'pending', expiresAt: '2026-11-02T11:00:00.000Z',
    createdAt: at, updatedAt: at, ...(o.machineId ? { machineId: o.machineId } : {}), ...(o.jobId ? { jobId: o.jobId } : {}),
  };
  raw.run('INSERT INTO logins (id, job_id, question_id, status, created_at, body) VALUES (?, ?, ?, ?, ?, ?)', id, o.jobId ?? null, null, body.status, at, JSON.stringify(body));
}

const body = (raw: Db, id: string): Record<string, unknown> => JSON.parse(String(raw.get('SELECT body FROM logins WHERE id = ?', id)!.body)) as Record<string, unknown>;
const statusOf = (raw: Db, id: string): string => String(raw.get('SELECT status FROM logins WHERE id = ?', id)!.status);

describe('tenant migration: one waiting sign-in per machine and tool (issue #2898)', () => {
  it('keeps the newest waiting sign-in, and the index then refuses a second', () => {
    // The store before migration 108, the one of issue #2898.
    const before = 107;
    const raw = t.tenantAt(t.url(), before);
    login(raw, '1', { machineId: 'box' });
    login(raw, '2', { machineId: 'box' });
    login(raw, '3', { machineId: 'box' });
    login(raw, '4', { machineId: 'other' });
    login(raw, '5', { machineId: 'box', tool: 'other' });
    login(raw, '6', { machineId: 'box', status: 'failed' });
    login(raw, '7', { machineId: 'box', run: 'herdr-claude', jobId: 'j1', tool: 'claude' });
    login(raw, '8', { machineId: 'box', run: 'herdr-claude', jobId: 'j2', tool: 'claude' });
    login(raw, '9', { tool: 'claude setup-token' });
    login(raw, '10', { tool: 'claude setup-token' });
    migrateTenant(raw);

    expect(['1', '2', '3'].map((id) => statusOf(raw, id))).toEqual(['cancelled', 'cancelled', 'pending']);
    expect(body(raw, '1')).toMatchObject({ status: 'cancelled', supersededBy: '3', endedAt: expect.any(String) });
    expect(body(raw, '2')).toMatchObject({ status: 'cancelled', supersededBy: '3' });
    expect(body(raw, '3')).toMatchObject({ status: 'pending' });
    expect(['4', '5', '7', '8', '10'].map((id) => statusOf(raw, id))).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    expect(statusOf(raw, '6')).toBe('failed');
    expect(statusOf(raw, '9')).toBe('cancelled');

    expect(() => login(raw, '11', { machineId: 'box' })).toThrow();
    expect(() => login(raw, '12', { tool: 'claude setup-token' })).toThrow();
    login(raw, '13', { machineId: 'box', run: 'herdr-claude', jobId: 'j3' });
  });
});
