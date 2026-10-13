// Issue #1001: a remembered write approval. A person's explicit approval of a write, sync or apply on an asset is
// remembered per asset and access, until an admin forgets it or the admin-set time limit ends; a later template or run
// whose every change is remembered, and whose reads are approved with no person, needs no person. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import {
  DEFAULT_REMEMBER_HOURS, forgetting, liveWrites, readApprovedWithoutPerson, rememberedCovers, remembering, type RememberedWrite,
} from '../../src/domain/remembered-writes.ts';

const WRITE: OperationProfile = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } };
const NS: OperationProfile = { operation: 'apply', asset: { kind: 'namespace', name: 'lab/identity' } };
const READ: OperationProfile = { operation: 'read', asset: { kind: 'cluster', name: 'lab' } };
const AT = new Date('2026-10-13T10:00:00Z');
const hoursAfter = (h: number): Date => new Date(AT.getTime() + h * 3600_000);

describe('remembered write approvals (issue #1001)', () => {
  it('remembers a write per asset and access, once; a later approval replaces it', () => {
    const one = remembering([], WRITE, 'Ada', AT, DEFAULT_REMEMBER_HOURS);
    expect(one).toEqual([{ operation: 'write', asset: WRITE.asset, by: 'Ada', at: AT.toISOString() }]);
    const two = remembering(one, WRITE, 'Bea', hoursAfter(1), DEFAULT_REMEMBER_HOURS);
    expect(two).toEqual([{ operation: 'write', asset: WRITE.asset, by: 'Bea', at: hoursAfter(1).toISOString() }]);
    expect(remembering(two, NS, 'Ada', AT, DEFAULT_REMEMBER_HOURS)).toHaveLength(2);
  });

  it('never remembers a read', () => {
    expect(remembering([], READ, 'Ada', AT, DEFAULT_REMEMBER_HOURS)).toEqual([]);
  });

  it('is live until the time limit ends, with its end; 0 hours keeps it until it is forgotten', () => {
    const list = remembering([], WRITE, 'Ada', AT, 24);
    expect(liveWrites(list, 24, hoursAfter(23))).toEqual([{ ...list[0], expiresAt: hoursAfter(24).toISOString() }]);
    expect(liveWrites(list, 24, hoursAfter(24))).toEqual([]);
    expect(liveWrites(list, 0, hoursAfter(10_000))).toEqual([list[0]]);
    // A shorter time limit set later counts at once.
    expect(liveWrites(list, 1, hoursAfter(2))).toEqual([]);
  });

  it('drops what ended when it remembers another', () => {
    const old = remembering([], WRITE, 'Ada', AT, 1);
    expect(remembering(old, NS, 'Ada', hoursAfter(5), 1).map((w) => w.operation)).toEqual(['apply']);
  });

  it('forgets one asset and access', () => {
    const list = remembering(remembering([], WRITE, 'Ada', AT, 0), NS, 'Ada', AT, 0);
    expect(forgetting(list, WRITE)).toEqual([list[1]]);
  });

  it('covers a template only when it holds no secret, each change is remembered, and each read is approved with no person', () => {
    const live: RememberedWrite[] = remembering(remembering([], WRITE, 'Ada', AT, 0), NS, 'Ada', AT, 0);
    const yes = (): boolean => true, no = (): boolean => false;
    expect(rememberedCovers({ secrets: [], profiles: [WRITE, NS] }, live, no)).toBe(true);
    expect(rememberedCovers({ secrets: [], profiles: [WRITE, READ] }, live, yes)).toBe(true);
    expect(rememberedCovers({ secrets: [], profiles: [WRITE, READ] }, live, no)).toBe(false);
    expect(rememberedCovers({ secrets: ['KUBE_TOKEN'], profiles: [WRITE] }, live, yes)).toBe(false);
    expect(rememberedCovers({ secrets: [], profiles: [{ ...WRITE, operation: 'sync' }] }, live, yes)).toBe(false);
    // Nothing to remember: reads only are the auto-approve policy's and the read policy's, never this.
    expect(rememberedCovers({ secrets: [], profiles: [READ] }, live, yes)).toBe(false);
  });

  it('a read is approved with no person when the read policy holds it, or the auto-approve policy holds low', () => {
    const off = { skipTemplateApproval: false, skipSandboxApproval: false, autoApprove: { low: false, medium: false, high: false } };
    expect(readApprovedWithoutPerson({ assets: ['cluster/lab'] }, off)(READ)).toBe(true);
    expect(readApprovedWithoutPerson(undefined, off)(READ)).toBe(false);
    expect(readApprovedWithoutPerson(undefined, undefined)(READ)).toBe(true);
  });
});
