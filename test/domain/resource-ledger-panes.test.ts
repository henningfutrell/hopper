// Issue #2504 part 13: a job's herdr pane as a ledger entry — recorded from the executor's saved state, closed only by the
// job's own cleanup through its executor (which closes the pane), failed when that cleanup did not reach its herdr, and
// closed when a person says it was closed by hand. No reap of the sweep and no survey judges it. Pure.
import { describe, expect, it } from 'vitest';
import { goneClosures, ledgerEntriesOf, ledgerParts, ledgerRootsOf, PANE_CLOSED_BY_HAND, PANE_NOT_REACHED, paneClosures, reapClosures, retainedEntriesOf, unledgeredEntriesOf, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const AT = '2026-10-23T10:00:00.000Z';

const entry = (kind: LedgerEntry['kind'], locator: string, over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ jobId: 'j1', machineId: 'm1', kind, locator, createdAt: AT, state: 'live', ...over });

describe('the herdr pane entry', () => {
  it('is recorded from the pane id the executor saved, on the job\'s machine', () => {
    expect(ledgerEntriesOf('j1', 'm1', { cwd: '/w', paneId: 'w1-3' }, AT)).toContainEqual({ jobId: 'j1', machineId: 'm1', kind: 'herdr_pane', locator: 'w1-3', createdAt: AT });
    expect(ledgerEntriesOf('j1', 'm1', { cwd: '/w', paneId: '' }, AT).map((e) => e.kind)).toEqual(['scratch_dir']);
  });

  it('is shown on the parts list as a herdr pane', () => {
    const parts = ledgerParts({ status: 'running' }, [entry('herdr_pane', 'w1-3')]);
    expect(parts.find((p) => p.kind === 'herdr_pane')).toMatchObject({ label: 'Herdr pane on m1', detail: 'w1-3: still there' });
  });
});

describe('what closes a herdr pane entry', () => {
  const pane = entry('herdr_pane', 'w1-3');

  it('no reap: the sweep and the machine reap stop processes and remove dirs, but close no pane', () => {
    expect(reapClosures([pane], { kept: [] })).toEqual([]);
    expect(reapClosures([pane], { kept: [] }, false)).toEqual([]);
  });

  it('the cleanup through the job\'s executor, which closed the pane: reaped, also with work kept', () => {
    expect(paneClosures([pane, entry('job_scope', 's')], 'closed')).toEqual([{ entry: pane, state: 'reaped' }]);
  });

  it('a cleanup that did not reach its herdr: failed, with why', () => {
    expect(paneClosures([pane], 'not_reached')).toEqual([{ entry: pane, state: 'failed', reason: PANE_NOT_REACHED }]);
    expect(paneClosures([{ ...pane, state: 'failed', reason: PANE_NOT_REACHED }], 'not_reached')).toEqual([]);
  });

  it('a person who closed it by hand: reaped, with that reason; a failed one too, but never a reaped one again', () => {
    expect(paneClosures([{ ...pane, state: 'failed', reason: PANE_NOT_REACHED }], 'by_hand')).toEqual([{ entry: { ...pane, state: 'failed', reason: PANE_NOT_REACHED }, state: 'reaped', reason: PANE_CLOSED_BY_HAND }]);
    expect(paneClosures([{ ...pane, state: 'reaped' }], 'by_hand')).toEqual([]);
  });

  it('a retention keeps no pane: the cleanup closes it all the same', () => {
    expect(retainedEntriesOf([pane])).toEqual([]);
  });

  it('the reconciler neither closes nor records one: the survey lists no pane, and a pane has no work tree', () => {
    const found = { scopes: [], processes: [], scratch: [], containers: [], roots: ['/w'], trees: [] };
    expect(goneClosures([pane], found, 'm1', () => ({ status: 'finished' }))).toEqual([]);
    expect(unledgeredEntriesOf(found, new Set(), () => ({ id: 'j1', status: 'finished' }), 'm1', undefined, Date.parse(AT))).toEqual([]);
    expect(ledgerRootsOf([pane], 'm1')).toEqual([]);
  });
});
