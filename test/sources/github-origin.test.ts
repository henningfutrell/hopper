// Trusted origin and request cards at the GitHub source (issue #652): an issue is taken only when a trusted actor wrote
// it, labelled it and assigned it to the user, and no job filed it; any other is a request card. Approve takes the text
// as read, and only while the issue still hashes so; an edit after the approval shows the card again.
import { describe, expect, it } from 'vitest';
import { requestHash } from '../../src/domain/intake-origin.ts';
import { DECLINED_REASON, REQUEST_REASON } from '../../src/sources/github/origin.ts';
import { ALREADY_APPROVED, ALREADY_TAKEN, TEXT_CHANGED_SINCE_SHOWN } from '../../src/sources/github/intake-actions.ts';
import { filedNote } from '../../src/github-proxy/index.ts';
import { REPO, setup, testTrust } from './fixtures/github-support.ts';

const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

describe('GitHub source: trusted origin (issue #652)', () => {
  it('an issue written, labelled and assigned by the user is taken, its origin trusted', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const items = await source.discover();
    expect(items.map((i) => [i.number, i.origin])).toEqual([[1, 'trusted']]);
    expect(source.intake?.()).toEqual([{ key: url(1), title: 'Issue 1', repo: REPO }]);
  });

  it('an issue by a stranger, labelled and assigned by the user, is a request card and no job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the CI.', labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    expect(await source.discover()).toEqual([]);
    const [card] = source.intake!();
    expect(card).toMatchObject({ key: url(1), reason: REQUEST_REASON, action: 'approve' });
    expect(card!.request).toEqual({
      hash: requestHash({ title: 'Do it', body: 'Change the CI.' }), title: 'Do it', body: 'Change the CI.', author: 'stranger',
      actors: [
        { role: 'author', login: 'stranger', trusted: false },
        { role: 'labelled', login: 'owner', trusted: true },
        { role: 'assigned', login: 'owner', trusted: true },
      ],
      why: ['written by stranger, not a trusted actor'],
    });
  });

  it('an issue labelled by a bot, or through an app, makes no job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'], labelledBy: 'helper[bot]' });
    gh.createIssue({ repo: REPO, labels: ['hopper'], labelledBy: { login: 'owner', viaApp: 'other-app' } });
    expect(await source.discover()).toEqual([]);
    expect(source.intake!().map((x) => x.request?.why)).toEqual([
      ['labelled by an app or a bot (helper[bot])'],
      ['labelled by an app or a bot (other-app)'],
    ]);
  });

  it('an issue a job filed through the hopper is a request card, though the user wrote it', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, body: `Follow-up.${filedNote('job-1', 'req-1')}`, labels: ['hopper'] });
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]!.request?.why).toEqual(['a job filed it']);
  });

  it('the trusted actors named are trusted, and the connected login only when it is named', async () => {
    const trust = testTrust(['teammate']);
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'teammate', labels: ['hopper'], labelledBy: 'teammate', assignedBy: 'teammate' });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(trust.asked).toEqual([['teammate', 'owner']]);
  });

  it('each act is asked with its GitHub user id, so trust follows the account, not its login (issue #930)', async () => {
    const trust = testTrust(['teammate']);
    const { gh, source } = setup({}, { trust });
    const teammate = { login: 'teammate', id: 42 };
    gh.createIssue({ repo: REPO, author: 'teammate', authorId: 42, labels: ['hopper'], labelledBy: teammate, assignedBy: teammate });
    await source.discover();
    expect(trust.askedActs).toEqual([[{ login: 'teammate', id: 42 }]]);
  });

  it('this hopper\'s own Assign to me is the user\'s act, though it went through the hopper\'s app', async () => {
    const trust = testTrust(undefined, { assignedHere: [url(1)] });
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, labels: ['hopper'], assignees: [] });
    gh.assign(REPO, 1, 'owner', undefined, { login: 'owner', viaApp: 'hopper-test-app' });
    expect((await source.discover()).map((i) => i.origin)).toEqual(['trusted']);
  });

  it('an issue whose job has not ended is not judged again: its events are not read', async () => {
    const { gh, source } = setup({}, { knownKeys: (keys) => new Set(keys), rerunnable: () => new Set() });
    gh.createIssue({ repo: REPO, author: 'stranger', labels: ['hopper'] });
    const items = await source.discover();
    expect(items.map((i) => [i.number, i.origin])).toEqual([[1, undefined]]);
    expect(gh.calls.some((c) => c.method === 'issueEvents')).toBe(false);
  });
});

describe('GitHub source: request cards (issue #652)', () => {
  it('Approve keeps the text as read, and the next sync takes the issue, its origin approved', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    gh.addComment(REPO, 1, 'owner', 'Go ahead.');
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash, acting: { person: 'owner', via: 'ui' } })).toEqual({ done: [url(1)], failed: {} });
    await source.flushOutbox?.();
    expect(trust.approvals.get(url(1))).toMatchObject({ source: 'github', text: { title: 'Do it', body: 'Change the README.' } });
    // The comments are read after the answer (issue #1194); the next discover waits for them.
    const items = await source.discover();
    expect(trust.approvals.get(url(1))).toMatchObject({ text: { comments: [{ author: 'owner', body: 'Go ahead.' }] } });
    expect(items.map((i) => [i.number, i.origin, i.body])).toEqual([[1, 'approved', 'Change the README.']]);
  });

  it('Approve refuses a hash that is not of the text the last sync showed', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: 'f'.repeat(64) })).toEqual({ done: [], failed: { [url(1)]: TEXT_CHANGED_SINCE_SHOWN } });
    await source.flushOutbox?.();
    expect(trust.approvals.size).toBe(0);
  });

  it('Approve after an edit the last sync did not see (issue #1194): the text shown is approved, with no read of the issue; the sync shows the card again', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    gh.editIssue(REPO, 1, { body: 'Change the CI.' }, 'stranger');
    const reads = gh.calls.filter((x) => x.method === 'getIssue').length;
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
    await source.flushOutbox?.();
    expect(gh.calls.filter((x) => x.method === 'getIssue')).toHaveLength(reads);
    expect(trust.approvals.get(url(1))).toMatchObject({ text: { body: 'Change the README.' } });
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]).toMatchObject({ action: 'approve', request: { body: 'Change the CI.', approved: { body: 'Change the README.' } } });
  });

  it('an issue edited after its approval makes no job until it is approved again, and the card shows what changed', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: source.intake!()[0]!.request!.hash });
    await source.flushOutbox?.();
    gh.editIssue(REPO, 1, { body: 'Change the CI.' }, 'stranger');
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]).toMatchObject({ action: 'approve', request: { body: 'Change the CI.', approved: { title: 'Do it', body: 'Change the README.' } } });
  });

  it('approvals sent while a sync runs each take, and that sync never shows a card as taken (issue #1019)', async () => {
    const trust = testTrust();
    let hold: Promise<void> | undefined;
    let held: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atHold = new Promise<void>((r) => { reached = r; });
    const gated: typeof trust = { ...trust, async trusted(acts, connected) { if (hold) { reached(); await hold; } return trust.trusted(acts, connected); } };
    const { gh, source } = setup({}, { trust: gated });
    for (const n of [1, 2, 3]) gh.createIssue({ repo: REPO, author: 'stranger', title: `Do ${n}`, body: `Change ${n}.`, labels: ['hopper'] });
    await source.discover();
    const hashOf = (n: number) => source.intake!().find((x) => x.key === url(n))!.request!.hash;
    const [h1, h2, h3] = [hashOf(1), hashOf(2), hashOf(3)];
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: h1 })).toEqual({ done: [url(1)], failed: {} });
    await source.flushOutbox?.();
    hold = new Promise((r) => { held = r; });
    const sync = source.discover();
    await atHold;
    // The sync is half way: the cards it lists are still the cards of the last sync, and Approve on them takes.
    expect(source.intake!().filter((x) => x.action === 'approve').map((x) => x.key)).toEqual([url(1), url(2), url(3)]);
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(2)], hash: h2 })).toEqual({ done: [url(2)], failed: {} });
    await source.flushOutbox?.();
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(3)], hash: h3 })).toEqual({ done: [url(3)], failed: {} });
    await source.flushOutbox?.();
    held();
    await sync;
    hold = undefined;
    expect((await source.discover()).map((i) => [i.number, i.origin])).toEqual([[1, 'approved'], [2, 'approved'], [3, 'approved']]);
  });

  it('only a request card is offered Approve', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: 'a'.repeat(64) })).toEqual({ done: [], failed: { [url(1)]: ALREADY_TAKEN } });
    await source.flushOutbox?.();
  });

  it('Approve again of a text already approved is done, after the sync took it too (issue #1045)', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
    await source.flushOutbox?.();
    expect((await source.discover()).map((i) => i.origin)).toEqual(['approved']);
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
    await source.flushOutbox?.();
  });

  it('Approve of an older text, on an issue taken with a newer approved text, says it is already approved (issue #1045)', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash });
    await source.flushOutbox?.();
    await source.discover();
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: 'a'.repeat(64) })).toEqual({ done: [], failed: { [url(1)]: ALREADY_APPROVED } });
    await source.flushOutbox?.();
  });

  it('Decline keeps the text as read declined: the next sync lists it declined, with no action, and writes nothing to GitHub (issue #1035)', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    expect(await source.intakeAction!({ kind: 'decline', keys: [url(1)], hash, acting: { person: 'owner', via: 'ui' } })).toEqual({ done: [url(1)], failed: {} });
    expect(trust.declines.get(url(1))).toMatchObject({ source: 'github', request: { hash } });
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]).toEqual({ key: url(1), title: 'Do it', repo: REPO, reason: DECLINED_REASON, group: 'declined' });
    const issue = await gh.getIssue(REPO, 1);
    expect([issue.state, issue.labels, issue.assignees]).toEqual(['open', ['hopper'], ['owner']]);
  });

  it('Decline refuses a text that changed since it was shown', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction!({ kind: 'decline', keys: [url(1)], hash: 'f'.repeat(64) })).toEqual({ done: [], failed: { [url(1)]: TEXT_CHANGED_SINCE_SHOWN } });
    expect(trust.declines.size).toBe(0);
  });

  it('an issue edited after its decline is a request card again (issue #1035)', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', labels: ['hopper'] });
    await source.discover();
    await source.intakeAction!({ kind: 'decline', keys: [url(1)], hash: source.intake!()[0]!.request!.hash });
    gh.editIssue(REPO, 1, { body: 'Change the CI.' }, 'stranger');
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]).toMatchObject({ reason: REQUEST_REASON, action: 'approve', request: { body: 'Change the CI.' } });
  });

  it('only a request card is offered Decline', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction!({ kind: 'decline', keys: [url(1)], hash: 'a'.repeat(64) })).toEqual({ done: [], failed: { [url(1)]: 'not offered: taken' } });
  });

  it('a job queued before origins were judged is judged at the next sync (issue #652, the backfill)', async () => {
    const pending = [url(1), url(2)];
    const trust = testTrust(undefined, { pending });
    const { gh, source } = setup({}, { trust, knownKeys: (keys) => new Set(keys.filter((k) => pending.includes(k))) });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the CI.', labels: ['hopper'] });
    const items = await source.discover();
    expect(items.map((i) => [i.number, i.origin])).toEqual([[1, 'trusted']]);
    expect(source.intake!().find((x) => x.key === url(2))).toMatchObject({ reason: REQUEST_REASON, action: 'approve', request: { author: 'stranger' } });
  });

  it('a job not pending is not judged again: its issue is offered as it is', async () => {
    const trust = testTrust();
    const { gh, source } = setup({}, { trust, knownKeys: (keys) => new Set(keys) });
    gh.createIssue({ repo: REPO, author: 'stranger', labels: ['hopper'] });
    const items = await source.discover();
    expect(items.map((i) => [i.number, i.origin])).toEqual([[1, undefined]]);
    expect(trust.asked).toEqual([]);
  });
});
