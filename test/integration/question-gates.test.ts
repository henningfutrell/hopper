// Question gates (issue #18): the rules file and the risk rules as the UI reads them, and the rules
// file edited from the UI through POST /ui/api/rules-file — atomic, mode kept, against the file's
// version (sha-256 of its bytes), size-capped, behind the UI session. The rules file is read on
// every ask, so a saved edit reaches the next question's answerer without a restart.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { QuestionGatesView, RulesFileView } from '../../src/domain/types.ts';
import { createFakeAnswerer, createFakeAssessor } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(o: { rules?: string; mode?: number; seams?: Parameters<typeof startTestApp>[0]['seams'] } = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const rulesPath = join(dirname(db.dbPath), 'rules.md');
  if (o.rules !== undefined) {
    writeFileSync(rulesPath, o.rules);
    chmodSync(rulesPath, o.mode ?? 0o600);
  }
  t = await startTestApp({ dbPath: db.dbPath, env: { JOB_HOPPER_RULES_FILE: rulesPath }, ...(o.seams ? { seams: o.seams } : {}) });
  return { a: t, rulesPath };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const gates = async (a: TestApp) => (await a.api<QuestionGatesView>('GET', '/api/question-gates')).body;

describe('GET /api/question-gates', () => {
  it('reads the rules file with its path and version, and lists every risk rule with one line', async () => {
    const { a, rulesPath } = await start({ rules: '- never push to main\n' });
    const g = await gates(a);
    expect(g.rulesFile).toEqual({ path: rulesPath, text: '- never push to main\n', version: sha('- never push to main\n'), missing: false });
    expect(g.riskRules.map((r) => r.name)).toEqual(['delete', 'deploy', 'force-push', 'spend', 'credentials', 'send-message']);
    for (const r of g.riskRules) expect(r.describe).toMatch(/\S/);
  });

  it('a missing rules file reads as empty, version `missing`', async () => {
    const { a, rulesPath } = await start();
    expect((await gates(a)).rulesFile).toEqual({ path: rulesPath, text: '', version: 'missing', missing: true });
  });
});

describe('POST /ui/api/rules-file', () => {
  it('saves the text against the version read, atomically, keeping the file\'s mode; answers the new view', async () => {
    const { a, rulesPath } = await start({ rules: 'old\n', mode: 0o640 });
    const token = await a.login();
    const res = await a.ui<RulesFileView>('/ui/api/rules-file', { text: 'new rules\n', version: sha('old\n') }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: rulesPath, text: 'new rules\n', version: sha('new rules\n'), missing: false });
    expect(readFileSync(rulesPath, 'utf8')).toBe('new rules\n');
    expect(statSync(rulesPath).mode & 0o777).toBe(0o640);
    expect((await gates(a)).rulesFile.version).toBe(sha('new rules\n'));
  });

  it('creates a missing rules file mode 600 against version `missing`', async () => {
    const { a, rulesPath } = await start();
    const token = await a.login();
    const res = await a.ui('/ui/api/rules-file', { text: 'first\n', version: 'missing' }, { token });
    expect(res.status).toBe(200);
    expect(readFileSync(rulesPath, 'utf8')).toBe('first\n');
    expect(statSync(rulesPath).mode & 0o777).toBe(0o600);
  });

  it('a stale version is 409 and nothing is written', async () => {
    const { a, rulesPath } = await start({ rules: 'v1\n' });
    const token = await a.login();
    writeFileSync(rulesPath, 'edited by hand\n');
    const res = await a.ui<{ error: string }>('/ui/api/rules-file', { text: 'from the UI\n', version: sha('v1\n') }, { token });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed since it was read/);
    expect(readFileSync(rulesPath, 'utf8')).toBe('edited by hand\n');
  });

  it('text over 64 KiB is 400 and nothing is written', async () => {
    const { a, rulesPath } = await start({ rules: 'v1\n' });
    const token = await a.login();
    const res = await a.ui<{ error: string }>('/ui/api/rules-file', { text: 'é'.repeat(32 * 1024 + 1), version: sha('v1\n') }, { token });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/64 KiB/);
    expect(readFileSync(rulesPath, 'utf8')).toBe('v1\n');
  });

  it('without a UI session it is 403 and nothing is written', async () => {
    const { a, rulesPath } = await start();
    const res = await a.ui('/ui/api/rules-file', { text: 'sneaky\n', version: 'missing' });
    expect(res.status).toBe(403);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('the next question\'s answerer and assessor get the saved rules, without a restart', async () => {
    const seen: string[] = [];
    const answerer = createFakeAnswerer({ name: 'drafter', script: (req: AnswerRequest) => { seen.push(`answerer:${req.rules}`); return { answer: 'ok', confident: true, reason: 'rules' }; } });
    const assessor = createFakeAssessor({ name: 'judge', script: (req: AnswerRequest) => { seen.push(`assessor:${req.rules}`); return { escalate: false, reason: 'fine' }; } });
    const { a } = await start({ rules: 'before\n', seams: { answerer, assessor } });
    const token = await a.login();
    expect((await a.ui('/ui/api/rules-file', { text: 'always say yes\n', version: sha('before\n') }, { token })).status).toBe(200);
    const job = await a.pull({ op: 'ask', message: 'Proceed?' });
    await a.waitForStatus(job.id, 'finished');
    expect(seen).toEqual(['answerer:always say yes\n', 'assessor:always say yes\n']);
  });
});
