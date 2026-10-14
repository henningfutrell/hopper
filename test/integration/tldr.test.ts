// The TL;DR (issue #569, design.md "TL;DR") over the real HTTP server and database: a cheap model (Claude Haiku) writes
// one or two plain sentences for every long card — a question, a research report, a hand-off —, once,
// stored with the card, and again when its text changes; the routes show it while it matches the text. The model is a
// double at its seam (`UserSeams.tldrWriter`). Without it (an error, no model) the card has none and a notification
// leads with the agent's own summary. A proposal leads with its own TL;DR part (issue #651). A setting turns it off,
// live (GET /api/tldr, POST /ui/api/tldr).
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Question, ReviewItemView, TldrSettings, TldrWriter } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { THREE_PATHS } from '../support/proposal-paths.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** A model double: the prompts it got, and its answer (or an error). */
function fakeWriter(answer: (prompt: string) => { text: string; model?: string } | { error: string } = () => ({ text: 'Pick a branch: dev or main.', model: 'claude-haiku-test' })) {
  const prompts: string[] = [];
  const writer: TldrWriter = async (prompt) => {
    prompts.push(prompt);
    return answer(prompt);
  };
  return { prompts, writer };
}

async function start(writer: TldrWriter): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, seams: { levels: [], tldrWriter: writer } });
  return t;
}

const LONG_QUESTION = [
  '## Branch', '',
  'Which branch do I rebase the fix onto?', '',
  'The fix touches the release script. Both branches carry it.', '',
  ...Array.from({ length: 8 }, (_, i) => `${i + 1}. branch \`b${i}\`: one of the options.`),
  '', '<script>window.pwned = 1</script>',
].join('\n');
const ask = (message: string) => ({ op: 'ask', message });
const LONG_REPORT = [
  'Question: what does the machine probe learn today?',
  'Findings: the home probe reads the home directory and the shell',
  ...Array.from({ length: 8 }, (_, i) => `- finding ${i + 1}: one more fact`),
  'Sources and evidence: src/machines/probe.ts',
  'Confidence: high',
  'Open threads: credentials; containers',
  'Next step: a tool probe beside the home probe',
].join('\n');

const setTldr = (a: TestApp, token: string, body: Partial<TldrSettings>) => a.ui<TldrSettings>('/ui/api/tldr', body, { token });
const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reportOf = async (a: TestApp, jobId: string): Promise<ReviewItemView | undefined> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', '/api/research?status=all')).body.items.find((p) => p.jobId === jobId);
const proposalOf = async (a: TestApp, jobId: string): Promise<ReviewItemView | undefined> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=all')).body.items.find((p) => p.jobId === jobId);

describe('the TL;DR of a long question', () => {
  it('is written once by the model, stored with the question, shown by the routes, and is an event', async () => {
    const m = fakeWriter();
    const a = await start(m.writer);
    const job = await a.pull(ask(LONG_QUESTION));
    const q = await a.waitForQuestion(job.id, (x) => x.tldr !== undefined);
    expect(q.tldr).toMatchObject({ text: 'Pick a branch: dev or main.', model: 'claude-haiku-test' });
    expect(m.prompts).toHaveLength(1);
    expect(m.prompts[0]).toContain('Which branch do I rebase the fix onto?');
    expect((await a.api<Question>('GET', `/api/questions/${q.id}`)).body.tldr?.text).toBe('Pick a branch: dev or main.');
    const written = (await ofJob(a, job.id)).filter((e) => e.type === 'tldr.written');
    expect(written.map((e) => e.data)).toEqual([{ kind: 'question', id: q.id, text: 'Pick a branch: dev or main.', model: 'claude-haiku-test' }]);
    await sleep(300);
    expect(m.prompts).toHaveLength(1);
  });

  it('a short question gets none: nothing is asked', async () => {
    const m = fakeWriter();
    const a = await start(m.writer);
    const job = await a.pull(ask('Which branch?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await sleep(300);
    expect(m.prompts).toEqual([]);
    expect((await a.questionsOf(job.id))[0]!.tldr).toBeUndefined();
    expect((await ofJob(a, job.id)).find((e) => e.type === 'question.escalated_to_human')!.data.tldr).toBeUndefined();
    expect(q.text).toBe('Which branch?');
  });

  it('the model\'s answer is plain text: HTML and Markdown taken out', async () => {
    const m = fakeWriter(() => ({ text: '<img src=x onerror=alert(1)>Pick **`dev`** or [main](https://x.test).' }));
    const a = await start(m.writer);
    const job = await a.pull(ask(LONG_QUESTION));
    const q = await a.waitForQuestion(job.id, (x) => x.tldr !== undefined);
    expect(q.tldr!.text).toBe('Pick dev or main.');
  });

  it('the model fails: no TL;DR, the question goes on, and the notification leads with the agent\'s own summary', async () => {
    const m = fakeWriter(() => ({ error: 'claude not found: claude' }));
    const a = await start(m.writer);
    const job = await a.pull(ask(LONG_QUESTION));
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await waitFor(() => m.prompts.length === 1, { what: 'the model asked' });
    await sleep(300);
    expect(m.prompts).toHaveLength(1);
    expect((await a.questionsOf(job.id))[0]!.tldr).toBeUndefined();
    const toHuman = (await ofJob(a, job.id)).find((e) => e.type === 'question.escalated_to_human')!;
    expect(toHuman.data.tldr).toBe('Which branch do I rebase the fix onto?');
  });
});

describe('the TL;DR of a research report', () => {
  it('is written for its round, and again for the next round once the job digs deeper', async () => {
    let n = 0;
    const m = fakeWriter(() => ({ text: `The probe reads the home dir, take ${++n}.` }));
    const a = await start(m.writer);
    const token = await a.login();
    const job = await a.pull({ op: 'research', message: LONG_REPORT }, { labels: ['hopper', 'hopper:research'] });
    const first = await waitFor(async () => {
      const r = await reportOf(a, job.id);
      return r?.tldr ? r : undefined;
    }, { what: 'the report\'s TL;DR' });
    expect(first.tldr!.text).toBe('The probe reads the home dir, take 1.');
    expect(m.prompts[0]).toContain('what does the machine probe learn today?');
    expect(m.prompts[0]).toContain('research report');

    const r = await a.ui(`/ui/api/research/${first.id}/dig-deeper`, { notes: 'look at the containers' }, { token });
    expect(r.status).toBe(200);
    const second = await waitFor(async () => {
      const x = await reportOf(a, job.id);
      return x && x.versions.length === 2 && x.tldr ? x : undefined;
    }, { what: 'the next round\'s TL;DR' });
    expect(second.tldr!.text).toBe('The probe reads the home dir, take 2.');
    expect(m.prompts[1]).toContain('Round after');
  });
});

describe('a proposal', () => {
  it('leads with its own TL;DR part (issue #651): the model is not asked, and the notification carries the part', async () => {
    const m = fakeWriter();
    const a = await start(m.writer);
    const job = await a.pull({ op: 'propose', message: THREE_PATHS });
    await waitFor(async () => ((await proposalOf(a, job.id))?.stage === 'human' ? true : undefined), { what: 'the proposal at a person' });
    await sleep(300);
    expect(m.prompts).toEqual([]);
    expect((await proposalOf(a, job.id))!.tldr).toBeUndefined();
    const toHuman = (await ofJob(a, job.id)).find((e) => e.type === 'proposal.escalated_to_human')!;
    expect(toHuman.data.tldr).toBe('Paint the shed with a brush. It is cheap and safe.');
  });
});

describe('the TL;DR setting', () => {
  it('defaults to on; an admin turns it off, the change is an event, and then nothing is written or shown', async () => {
    const m = fakeWriter();
    const a = await start(m.writer);
    const token = await a.login();
    expect((await a.api('GET', '/api/tldr')).body).toEqual({ enabled: true });
    const first = await a.pull(ask(LONG_QUESTION));
    await a.waitForQuestion(first.id, (x) => x.tldr !== undefined);

    const r = await setTldr(a, token, { enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
    expect((await a.events('types=tldr.settings_changed'))[0]!.data).toMatchObject({ from: { enabled: true }, to: { enabled: false } });
    expect((await setTldr(a, token, {})).status).toBe(400);
    // Shown no more, though it is still stored.
    expect((await a.questionsOf(first.id))[0]!.tldr).toBeUndefined();

    const second = await a.pull(ask(`${LONG_QUESTION}\n\nAnother one.`));
    await a.waitForQuestion(second.id, (x) => x.tier === 'human');
    await sleep(300);
    expect(m.prompts).toHaveLength(1);
    expect((await ofJob(a, second.id)).find((e) => e.type === 'question.escalated_to_human')!.data.tldr).toBeUndefined();

    // On again: the open question gets its TL;DR, and the first one shows again.
    await setTldr(a, token, { enabled: true });
    await a.waitForQuestion(second.id, (x) => x.tldr !== undefined);
    expect((await a.questionsOf(first.id))[0]!.tldr?.text).toBe('Pick a branch: dev or main.');
  });
});
