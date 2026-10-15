// Approve takes at the first click (issue #1316): the card leaves Intake in the answer, a sync that read the item before
// the approval does not bring it back, and an Approve on an item the last sync does not list with that text is resolved
// again from the issue as GitHub has it now.
import { describe, expect, it } from 'vitest';
import { requestHash } from '../../src/domain/intake-origin.ts';
import { NOT_SHOWN, TEXT_CHANGED_SINCE_SHOWN } from '../../src/sources/github/intake-actions.ts';
import { REPO, setup, testTrust } from './fixtures/github-support.ts';

const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const cards = (xs: { action?: string; key: string }[] | undefined) => (xs ?? []).filter((x) => x.action === 'approve').map((x) => x.key);

describe('GitHub source: Approve takes at the first click (issue #1316)', () => {
  it('the card leaves Intake in the answer, before any sync', async () => {
    const { gh, source } = setup({}, { trust: testTrust() });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
    // Taken, as the next sync lists it, its comment read still on its way.
    expect(source.intake!()).toEqual([{ key: url(1), title: 'Do it', repo: REPO, writeBehind: { act: 'approve', state: 'running' } }]);
  });

  it('Approve while a sync updates the same item: approved on the first try, and the sync does not bring the card back', async () => {
    const trust = testTrust();
    let hold: Promise<void> | undefined;
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atHold = new Promise<void>((r) => { reached = r; });
    // The sync is held after it read the item's origin, as a request card: the approval comes after that read.
    const gated: typeof trust = { ...trust, declined: (key, hash) => { if (hold) reached(); return trust.declined(key, hash); } };
    const { gh, source } = setup({}, { trust: gated });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    hold = new Promise((r) => { release = r; });
    const sync = source.discover();
    await atHold;
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
    release();
    await sync;
    hold = undefined;
    // The sync read the card before the approval, and lists it: Intake still does not.
    expect(cards(source.intake!())).toEqual([]);
    await source.flushOutbox?.();
    expect(trust.approvals.get(url(1))).toMatchObject({ text: { body: 'Change the README.' } });
    expect((await source.discover()).map((i) => [i.number, i.origin])).toEqual([[1, 'approved']]);
    expect(cards(source.intake!())).toEqual([]);
    // A second click, from a page that still shows the card, is done: one approval.
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
  });

  it('an approved item edited later is a card again, with its new text', async () => {
    const { gh, source } = setup({}, { trust: testTrust() });
    gh.createIssue({ repo: REPO, author: 'stranger', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: source.intake!()[0]!.request!.hash });
    await source.flushOutbox?.();
    gh.editIssue(REPO, 1, { body: 'Change the CI.' }, 'stranger');
    await source.discover();
    expect(source.intake!()[0]).toMatchObject({ action: 'approve', request: { body: 'Change the CI.' } });
  });

  it('no sync since a restart: Approve reads the issue now, and approves it when its text is the one read', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    const hash = requestHash({ title: 'Do it', body: 'Change the README.' });
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: 'f'.repeat(64) })).toEqual({ done: [], failed: { [url(1)]: TEXT_CHANGED_SINCE_SHOWN } });
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
    await source.flushOutbox?.();
    expect((await source.discover()).map((i) => [i.number, i.origin])).toEqual([[1, 'approved']]);
  });

  it('a last sync older than the page: Approve of the text GitHub has now is approved', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    gh.editIssue(REPO, 1, { body: 'Change the CI.' }, 'stranger');
    const now = requestHash({ title: 'Issue 1', body: 'Change the CI.' });
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: now })).toEqual({ done: [url(1)], failed: {} });
    expect(trust.approvals.get(url(1))).toMatchObject({ text: { body: 'Change the CI.' } });
  });

  it('an issue of trusted origin, or one not of the source, is not approved when resolved again', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, body: 'Mine.', labels: ['hopper'] });
    gh.createIssue({ repo: REPO, author: 'stranger', body: 'No label.', labels: [] });
    const r = await source.intakeAction!({ kind: 'approve', keys: [url(1), url(2)], hash: requestHash({ title: 'Issue 1', body: 'Mine.' }) });
    expect(r.done).toEqual([]);
    expect(r.failed[url(1)]).toMatch(/^already taken/);
    expect(r.failed[url(2)]).toBe(NOT_SHOWN);
    expect(trust.approvals.size).toBe(0);
  });
});
