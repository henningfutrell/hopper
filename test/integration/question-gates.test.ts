// Question gates (issue #18): the rules (config record `rules`) and the risk rules as the UI reads them, and
// the rules edited from the UI through POST /ui/api/rules — against the rules' version (sha-256 of
// their JSON value), size-capped, behind the UI session. The rules are read on every ask, so a saved edit
// reaches the next question's escalation levels without a restart.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { QuestionGatesView, RulesView } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(o: { rules?: string; seams?: Parameters<typeof startTestApp>[0]['seams'] } = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (o.rules !== undefined) writeConfig(db.dbPath, 'rules', o.rules);
  t = await startTestApp({ dbPath: db.dbPath, ...(o.seams ? { seams: o.seams } : {}) });
  return { a: t };
}
const rulesText = (a: TestApp) => a.user().store.config.read('rules');

/** The version of rules `text`: the sha-256 of its JSON value. */
const sha = (text: string) => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const gates = async (a: TestApp) => (await a.api<QuestionGatesView>('GET', '/api/question-gates')).body;

describe('GET /api/question-gates', () => {
  it('reads the rules with their version, and lists every risk rule with one line', async () => {
    const { a } = await start({ rules: '- never push to main\n' });
    const g = await gates(a);
    expect(g.rules).toEqual({ text: '- never push to main\n', version: sha('- never push to main\n'), missing: false });
    expect(g.riskRules.map((r) => r.name)).toEqual(['delete', 'deploy', 'force-push', 'spend', 'credentials', 'send-message']);
    for (const r of g.riskRules) expect(r.describe).toMatch(/\S/);
  });

  it('missing rules read as empty, version `missing`', async () => {
    const { a } = await start();
    expect((await gates(a)).rules).toEqual({ text: '', version: 'missing', missing: true });
  });
});

describe('POST /ui/api/rules', () => {
  it('saves the text against the version read; answers the new view', async () => {
    const { a } = await start({ rules: 'old\n' });
    const token = await a.login();
    const res = await a.ui<RulesView>('/ui/api/rules', { text: 'new rules\n', version: sha('old\n') }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'new rules\n', version: sha('new rules\n'), missing: false });
    expect(rulesText(a)).toBe('new rules\n');
    expect((await gates(a)).rules.version).toBe(sha('new rules\n'));
  });

  it('creates missing rules against version `missing`', async () => {
    const { a } = await start();
    const token = await a.login();
    const res = await a.ui('/ui/api/rules', { text: 'first\n', version: 'missing' }, { token });
    expect(res.status).toBe(200);
    expect(rulesText(a)).toBe('first\n');
  });

  it('a stale version is 409 and nothing is written', async () => {
    const { a } = await start({ rules: 'v1\n' });
    const token = await a.login();
    writeConfig(a.dbPath, 'rules', 'edited elsewhere\n');
    const res = await a.ui<{ error: string }>('/ui/api/rules', { text: 'from the UI\n', version: sha('v1\n') }, { token });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/the rules changed since they were read; reload and edit again/);
    expect(rulesText(a)).toBe('edited elsewhere\n');
  });

  it('text over 64 KiB is 400 and nothing is written', async () => {
    const { a } = await start({ rules: 'v1\n' });
    const token = await a.login();
    const res = await a.ui<{ error: string }>('/ui/api/rules', { text: 'é'.repeat(32 * 1024 + 1), version: sha('v1\n') }, { token });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/64 KiB/);
    expect(rulesText(a)).toBe('v1\n');
  });

  it('without a UI session it is 403 and nothing is written', async () => {
    const { a } = await start();
    const res = await a.ui('/ui/api/rules', { text: 'sneaky\n', version: 'missing' });
    expect(res.status).toBe(403);
    expect(rulesText(a)).toBeUndefined();
  });

  it('the next question\'s escalation levels get the saved rules, without a restart', async () => {
    const seen: string[] = [];
    const low = createFakeLevel({ name: 'low', script: (req: AnswerRequest) => { seen.push(`low:${req.rules}`); return { answer: 'ok', escalate: true, reason: 'not sure' }; } });
    const high = createFakeLevel({ name: 'high', script: (req: AnswerRequest) => { seen.push(`high:${req.rules}`); return { answer: 'ok', escalate: false, reason: 'fine', confidence: 'high' }; } });
    const { a } = await start({ rules: 'before\n', seams: { levels: [low, high] } });
    const token = await a.login();
    expect((await a.ui('/ui/api/rules', { text: 'always say yes\n', version: sha('before\n') }, { token })).status).toBe(200);
    const job = await a.pull({ op: 'ask', message: 'Proceed?' });
    await a.waitForStatus(job.id, 'finished');
    expect(seen).toEqual(['low:always say yes\n', 'high:always say yes\n']);
  });
});
