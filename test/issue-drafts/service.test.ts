// File an issue (issue #471), the service with doubles at its seams: the drafter (the user's own AI connection) and the
// person's GitHub. Nothing is filed without the person's confirmation; the scan runs again on the edited text; filing
// adds no label and no assignee; a cancel, a timeout and a provider's error each keep the person's text and file nothing.
//
// Feature: File an issue
//   Scenario: no provider, no GitHub, no job repository: it says why, and cannot be used
//   Scenario: the file-issue run skill's prompt is what is sent, exactly; a repository that is not a job repository is refused
//   Scenario: a draft comes back cleaned, with the constraints it broke; its suggested labels are dropped
//   Scenario: the drafter is given the draft scope; the host name is refused at filing (issue #475)
//   Scenario: a cancel mid-draft, a timeout and a provider's error file nothing
//   Scenario: filing needs the confirmation; an edit that brings in a secret or an @ mention is refused at filing
//   Scenario: a public repository needs its own confirmation; a filed issue has no label and no assignee
//   Scenario: an issue sent again with its key, or twice at once, is filed once; its text ends with its post key (issue #2813)
import { describe, expect, it } from 'vitest';
import { FILED_NOTE } from '../../src/domain/issue-drafts.ts';
import { postKeyLine } from '../../src/domain/post-key.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { createIssueDrafts, IssueDraftRefused, type IssueDrafter, type IssueGitHub } from '../../src/issue-drafts/index.ts';
import type { DraftScope } from '../../src/run-skills/constraints.ts';
import { fileIssuePrompt } from '../../src/run-skills/file-issue.ts';
import { loadRunSkill } from '../../src/run-skills/index.ts';

const SKILL = loadRunSkill('file-issue');
const SKILL_NAME = `file-issue@${SKILL.id}`;

const REPO = 'octo-org/hello';
const TOKEN = `ghp_${'a'.repeat(36)}`;

/** The service with a drafter double and a fake GitHub; `visibility` of every repository. */
function setUp(o: { drafter?: Partial<IssueDrafter>; visibility?: 'public' | 'private'; repos?: string[]; github?: false; timeoutMs?: number; hostname?: string } = {}) {
  const events: NewEvent[] = [];
  const created: { repo: string; title: string; body: string; labels: string[] }[] = [];
  const api: IssueGitHub = {
    repo: async () => ({ visibility: o.visibility ?? 'private', hasIssues: true, defaultBranch: 'main' }),
    create: async (repo, issue) => {
      created.push({ repo, ...issue });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { number: 7, url: `https://github.com/${repo}/issues/7` };
    },
  };
  const drafter: IssueDrafter = {
    provider: 'claude',
    available: async () => ({ ok: true }),
    draft: async () => ({ title: 'Queue stalls after a restart', body: '## Summary\nThe queue stalls.', notes: 'Rephrased.', model: 'claude-sonnet-5-5' }),
    ...o.drafter,
  };
  const drafts = createIssueDrafts({
    drafter, repos: () => o.repos ?? [REPO], timeoutMs: o.timeoutMs ?? 5000,
    github: () => (o.github === false ? { problem: 'your GitHub is not connected' } : { api }),
    job: () => undefined, record: (e) => { events.push(e); }, ...(o.hostname ? { hostname: o.hostname } : {}),
  });
  return { drafts, events, created };
}

/** The refusal `p` ends with. */
const refusal = async (p: Promise<unknown>): Promise<IssueDraftRefused> => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  if (!(e instanceof IssueDraftRefused)) throw new Error(`expected a refusal, got ${String(e)}`);
  return e;
};

/** A drafter that answers only when its run is ended. */
const waits: Partial<IssueDrafter> = {
  draft: (_s, _i, _scope, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ error: 'aborted' })); }),
};

describe('File an issue (issue #471)', () => {
  it('says why it cannot be used: no provider, no GitHub, no job repository', async () => {
    expect(await setUp({ drafter: { available: async () => ({ ok: false, reason: 'Claude is not installed' }) } }).drafts.status())
      .toEqual({ provider: 'claude', available: false, usable: false, reason: 'Claude is not installed', repos: [REPO] });
    expect((await setUp({ github: false }).drafts.status())).toMatchObject({ available: true, usable: false, reason: 'your GitHub is not connected' });
    expect((await setUp({ repos: [] }).drafts.status())).toMatchObject({ usable: false, reason: expect.stringMatching(/no job repositories/) });
    expect(await setUp().drafts.status()).toEqual({ provider: 'claude', available: true, usable: true, repos: [REPO] });
  });

  it('shows the run skill\'s prompt as it is sent; a repository that is not a job repository is refused', async () => {
    const sent: string[] = [];
    const { drafts } = setUp({ drafter: { draft: async (skill, input) => { sent.push(fileIssuePrompt(skill, input)); return { title: 't', body: 'b', notes: '' }; } } });
    const r = { repo: REPO, text: 'The queue stalls after a restart.', context: '- Job: j1 (failed)', instructions: 'Shorter title', previous: { title: 'Old title', body: 'Old body' } };
    const prompt = drafts.prompt(r);
    expect(prompt).toContain(`hopper run skill file-issue ${SKILL.id}`);
    expect(prompt).toContain('The queue stalls after a restart.');
    expect(prompt).toContain('- Job: j1 (failed)');
    expect(prompt).toContain('Old body');
    expect(prompt).toContain('Shorter title');
    expect(prompt).toContain(`Target repository: \`${REPO}\``);
    await drafts.draft(r, new AbortController().signal);
    expect(sent).toEqual([prompt]);
    expect((await refusal(drafts.draft({ ...r, repo: 'someone/else' }, new AbortController().signal))).status).toBe(400);
    expect(() => drafts.prompt({ ...r, repo: 'someone/else' })).toThrow(/not one of your job repositories/);
  });

  it('answers the draft cleaned, with the constraints it broke, its labels dropped, and records it without the text', async () => {
    const { drafts, events } = setUp({ drafter: { draft: async () => ({ title: 'Lockout', body: `Mail ada@example.com, token ${TOKEN}`, labels: ['hopper', 'bug'], notes: 'Kept short.', model: 'claude-sonnet-5-5' }) } });
    const d = await drafts.draft({ repo: REPO, text: 'A lockout.' }, new AbortController().signal);
    expect(d.body).not.toContain('ada@example.com');
    expect(d.body).not.toContain(TOKEN);
    expect(d.findings.map((f) => f.constraint)).toEqual(['no-secret', 'no-personal-data', 'no-hopper-label']);
    expect(d).toMatchObject({ repo: REPO, title: 'Lockout', notes: 'Kept short.', provider: 'claude', model: 'claude-sonnet-5-5', skill: SKILL_NAME });
    expect(d).not.toHaveProperty('labels');
    expect(events).toEqual([{ type: 'issue_draft.drafted', data: { repo: REPO, provider: 'claude', model: 'claude-sonnet-5-5', skill: SKILL_NAME, findings: ['no-secret', 'no-personal-data', 'no-hopper-label'] } }]);
  });

  it('gives the drafter the draft scope, keeps the findings it made before its mask, and refuses the host name at filing (issue #475)', async () => {
    const scopes: DraftScope[] = [];
    const { drafts } = setUp({
      hostname: 'quartz-box',
      drafter: { draft: async (_s, _i, scope) => { scopes.push(scope); return { title: 't', body: '[name, masked]', notes: '', findings: [{ constraint: 'no-known-name', what: 'it names the user' }] }; } },
    });
    const d = await drafts.draft({ repo: REPO, text: 'A lockout.' }, new AbortController().signal);
    expect(scopes).toEqual([{ repos: [REPO], known: ['quartz-box'] }]);
    expect(d.findings.map((f) => f.constraint)).toEqual(['no-known-name']);
    const named = { repo: REPO, title: 'Queue stalls', body: 'It stalls on quartz-box.' };
    expect((await drafts.check(named)).findings.map((f) => f.constraint)).toEqual(['no-known-name']);
    expect((await refusal(drafts.file({ ...named, confirmed: true }, 'ada'))).status).toBe(422);
  });

  it('a cancel mid-draft ends the run and files nothing', async () => {
    let ended = false;
    let started!: () => void;
    const running$ = new Promise<void>((resolve) => { started = resolve; });
    const { drafts, events, created } = setUp({
      drafter: { draft: (_s, _i, _scope, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { ended = true; resolve({ error: 'aborted' }); }); started(); }) },
    });
    const cancel = new AbortController();
    const running = drafts.draft({ repo: REPO, text: 'A lockout.' }, cancel.signal);
    await running$;
    cancel.abort();
    expect((await refusal(running)).status).toBe(499);
    expect(ended).toBe(true);
    expect(events).toEqual([]);
    expect(created).toEqual([]);
    // Cancelled before the run started: no run at all.
    const before = new AbortController();
    before.abort();
    expect((await refusal(drafts.draft({ repo: REPO, text: 'A lockout.' }, before.signal))).status).toBe(499);
  });

  it('a provider that gives no draft in time: a plain message that keeps the text', async () => {
    const { drafts, created } = setUp({ drafter: waits, timeoutMs: 20 });
    const e = await refusal(drafts.draft({ repo: REPO, text: 'A lockout.' }, new AbortController().signal));
    expect(e.status).toBe(504);
    expect(e.message).toMatch(/gave no draft in .* Your text is kept/);
    expect(created).toEqual([]);
  });

  it('a provider\'s error, and no provider: plain messages', async () => {
    const failing = setUp({ drafter: { draft: async () => ({ error: 'claude exited 1: not logged in' }) } });
    const e = await refusal(failing.drafts.draft({ repo: REPO, text: 'x' }, new AbortController().signal));
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/not logged in\. Your text is kept/);
    const none = setUp({ drafter: { available: async () => ({ ok: false, reason: 'Claude is not installed' }) } });
    expect((await refusal(none.drafts.draft({ repo: REPO, text: 'x' }, new AbortController().signal))).status).toBe(409);
  });

  it('files only once the person confirmed it, with no label and no assignee, the note last', async () => {
    const { drafts, created, events } = setUp();
    const issue = { repo: REPO, title: 'Queue stalls', body: '## Summary\nThe queue stalls.' };
    expect((await refusal(drafts.file({ ...issue, confirmed: false }, 'ada'))).status).toBe(400);
    expect(created).toEqual([]);

    const check = await drafts.check(issue);
    expect(check).toMatchObject({ repo: REPO, visibility: 'private', labels: [], assignees: [], findings: [] });
    expect(check.refusal).toBeUndefined();
    expect(check.body.endsWith(FILED_NOTE)).toBe(true);

    expect(await drafts.file({ ...issue, confirmed: true }, 'ada')).toEqual({ repo: REPO, number: 7, url: `https://github.com/${REPO}/issues/7` });
    expect(created).toEqual([{ repo: REPO, title: 'Queue stalls', body: expect.stringMatching(/<!-- hopper post [^\n]+ -->$/), labels: [] }]);
    expect(created[0]!.body.startsWith(check.body)).toBe(true);
    expect(events).toEqual([{ type: 'issue_draft.filed', data: { repo: REPO, number: 7, url: `https://github.com/${REPO}/issues/7`, by: 'ada', provider: 'claude', skill: SKILL_NAME } }]);
  });

  it('checks the edited text again at filing: a secret or an @ mention the person put in is refused', async () => {
    const { drafts, created } = setUp();
    const edited = { repo: REPO, title: 'Queue stalls', body: `It stalls. The token is ${TOKEN}` };
    expect((await drafts.check(edited)).refusal).toMatch(/secret/);
    expect((await refusal(drafts.file({ ...edited, confirmed: true }, 'ada'))).status).toBe(422);
    const mention = { repo: REPO, title: 'Queue stalls', body: 'It stalls. Ask @octocat.' };
    expect((await drafts.check(mention)).findings.map((f) => f.constraint)).toEqual(['no-mention']);
    expect((await refusal(drafts.file({ ...mention, confirmed: true }, 'ada'))).status).toBe(422);
    expect(created).toEqual([]);
  });

  it('a public repository needs its own confirmation; personal data is refused there', async () => {
    const { drafts, created } = setUp({ visibility: 'public' });
    const issue = { repo: REPO, title: 'Queue stalls', body: 'It stalls.', confirmed: true };
    expect((await refusal(drafts.file(issue, 'ada'))).status).toBe(409);
    expect((await refusal(drafts.file({ ...issue, body: 'Ask ada@example.com', confirmPublic: true }, 'ada'))).status).toBe(422);
    expect(created).toEqual([]);
    await drafts.file({ ...issue, confirmPublic: true }, 'ada');
    expect(created).toHaveLength(1);
  });

  it('files an issue sent again with its key, or twice at once, once; its text ends with its post key (issue #2813)', async () => {
    const { drafts, created, events } = setUp();
    const issue = { repo: REPO, title: 'Queue stalls', body: 'It stalls.', confirmed: true, key: 'file-issue-0001' };
    const [a, b] = await Promise.all([drafts.file(issue, 'ada'), drafts.file(issue, 'ada')]);
    const again = await drafts.file(issue, 'ada');
    expect(a).toEqual({ repo: REPO, number: 7, url: `https://github.com/${REPO}/issues/7` });
    expect(b).toEqual(a);
    expect(again).toEqual(a);
    expect(created).toHaveLength(1);
    expect(created[0]!.body.endsWith(postKeyLine('file-issue-0001'))).toBe(true);
    expect(events.filter((e) => e.type === 'issue_draft.filed')).toHaveLength(1);
    await drafts.file({ ...issue, key: 'file-issue-0002' }, 'ada');
    expect(created).toHaveLength(2);
  });
});
