// The built-in question plugins that run the `claude` CLI in print mode — `claude-cli` (answerer)
// and `claude-cli-assessor` — against a fake `claude` executable, plus `always-escalate`. Both
// claude plugins run locked down: no tools, no MCP, no settings, no session, schema-bound output,
// env scrubbed of the Claude Code markers.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerDraft, AnswerRequest } from '../../src/domain/ports.ts';
import type { Question } from '../../src/domain/types.ts';
import claudeCli from '../../src/plugins/answerer/claude-cli/index.ts';
import alwaysEscalate from '../../src/plugins/assessor/always-escalate/index.ts';
import claudeCliAssessor from '../../src/plugins/assessor/claude-cli-assessor/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { fakeKit, fixedClock } from './support.ts';

const BIN = join(import.meta.dirname, 'fake-claude.mjs');
let dir: string;
let out: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION', 'FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_STRUCTURED', 'KEEP_ME'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'jh-claude-'));
  out = join(dir, 'rec.json');
  process.env.FAKE_CLAUDE_OUT = out;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  process.env.CLAUDE_CODE_SESSION = 'abc';
  process.env.KEEP_ME = 'yes';
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_STRUCTURED;
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const question = {
  id: 'q1', jobId: 'j1', text: 'Which database should I use?', recentOutput: 'building schema\nneed a db',
  detectedBy: 'marker', status: 'open', tier: 'opus', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '',
} as Question;
const req = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({
  question, jobPrompt: 'Build the invoicing service', jobGoal: 'invoicing', rules: 'RULE: prefer sqlite', previous: [], ...over,
});
const draft: AnswerDraft = { answer: 'use sqlite', confident: true, reason: 'the rules prefer it' };
const ctx = () => ({ clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: dir, scratchDir: join(dir, 'scratch') });
const signal = () => new AbortController().signal;
const rec = () => JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; cwd: string };

/** The plugin's options as the core validates them (defaults applied). */
function opts(def: typeof claudeCli | typeof claudeCliAssessor, raw: Record<string, unknown>): never {
  const p = parseOptions(def, raw);
  if (!p.ok) throw new Error(p.error);
  return p.options as never;
}
const answerer = (raw: Record<string, unknown> = {}) => claudeCli.create(ctx(), opts(claudeCli, { bin: BIN, timeoutMs: 5000, ...raw }));
const assessor = (raw: Record<string, unknown> = {}) => claudeCliAssessor.create(ctx(), opts(claudeCliAssessor, { bin: BIN, timeoutMs: 5000, ...raw }));

/** argv with the --json-schema value replaced, and the parsed schema. */
function argvAndSchema(): { argv: string[]; schema: Record<string, unknown> } {
  const { argv } = rec();
  const at = argv.indexOf('--json-schema') + 1;
  return { argv: argv.map((a, i) => (i === at ? '<schema>' : a)), schema: JSON.parse(argv[at]!) as Record<string, unknown> };
}

const LOCKDOWN_TAIL = ['--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', ''];

describe('claude-cli (answerer)', () => {
  it('is an answerer; options bin, model (default opus), timeoutMs, effort (optional)', async () => {
    expect(claudeCli).toMatchObject({ id: 'claude-cli', role: 'answerer' });
    expect(parseOptions(claudeCli, {})).toEqual({ ok: true, options: { bin: 'claude', model: 'opus', timeoutMs: 180_000 } });
    expect(parseOptions(claudeCli, { effort: 'high' })).toMatchObject({ ok: true, options: { effort: 'high' } });
    expect(parseOptions(claudeCli, { effort: 'enormous' }).ok).toBe(false);
  });

  it('spawns locked down with the draft schema (no risky), --tools "" last, in the data dir', async () => {
    await (await answerer()).answer(req(), signal());
    const { argv, schema } = argvAndSchema();
    expect(argv).toEqual(['-p', '--model', 'opus', '--output-format', 'json', '--json-schema', '<schema>', ...LOCKDOWN_TAIL]);
    // Literal draft-07 shape: the claude CLI rejects a `$schema` it does not know.
    expect(schema).toEqual({
      type: 'object',
      properties: { answer: { type: 'string' }, confident: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['answer', 'confident', 'reason'],
      additionalProperties: false,
    });
    expect(rec().cwd).toBe(dir);
  });

  it('passes --effort when set, before the lockdown flags', async () => {
    await (await answerer({ effort: 'low', model: 'sonnet' })).answer(req(), signal());
    expect(argvAndSchema().argv).toEqual(['-p', '--model', 'sonnet', '--effort', 'low', '--output-format', 'json', '--json-schema', '<schema>', ...LOCKDOWN_TAIL]);
  });

  it('puts rules, job prompt, output, question and earlier attempts on stdin', async () => {
    const previous = [{ tier: 'opus', role: 'answerer' as const, startedAt: 'a', outcome: 'escalated' as const, reason: 'unsure about scale' }];
    await (await answerer()).answer(req({ previous }), signal());
    const { stdin } = rec();
    for (const s of ['RULE: prefer sqlite', 'Build the invoicing service', 'need a db', 'Which database should I use?', 'unsure about scale']) expect(stdin).toContain(s);
  });

  it('scrubs CLAUDECODE and CLAUDE_CODE_* from the environment, keeps the rest', async () => {
    await (await answerer()).answer(req(), signal());
    const { env } = rec();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(env.KEEP_ME).toBe('yes');
  });

  it('returns the validated draft', async () => {
    expect(await (await answerer()).answer(req(), signal())).toEqual({ answer: 'use postgres', confident: true, reason: 'rules' });
  });

  it.each(['malformed', 'invalid', 'exit1'])('%s output returns { error }', async (mode) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    expect(await (await answerer()).answer(req(), signal())).toEqual({ error: expect.any(String) });
  });

  it('a missing binary returns { error }; a timeout returns { error }', async () => {
    expect(await (await answerer({ bin: join(dir, 'nope') })).answer(req(), signal())).toEqual({ error: expect.any(String) });
    process.env.FAKE_CLAUDE_MODE = 'hang';
    expect(await (await answerer({ timeoutMs: 300 })).answer(req(), signal())).toEqual({ error: expect.stringMatching(/timeout/i) });
  });

  it('abort returns { error } and kills the child', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const ac = new AbortController();
    const p = (await answerer({ timeoutMs: 10_000 })).answer(req(), ac.signal);
    setTimeout(() => ac.abort('cancel'), 300);
    expect(await p).toEqual({ error: expect.stringMatching(/abort/i) });
  });
});

describe('claude-cli-assessor', () => {
  it('is an assessor; options bin, model (default fable), timeoutMs', () => {
    expect(claudeCliAssessor).toMatchObject({ id: 'claude-cli-assessor', role: 'assessor' });
    expect(parseOptions(claudeCliAssessor, {})).toEqual({ ok: true, options: { bin: 'claude', model: 'fable', timeoutMs: 180_000 } });
  });

  it('spawns with the same lockdown and the assessment schema { escalate, reason }', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ escalate: false, reason: 'routine' });
    await (await assessor()).assess(req(), draft, signal());
    const { argv, schema } = argvAndSchema();
    expect(argv).toEqual(['-p', '--model', 'fable', '--output-format', 'json', '--json-schema', '<schema>', ...LOCKDOWN_TAIL]);
    expect(schema).toEqual({
      type: 'object',
      properties: { escalate: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['escalate', 'reason'],
      additionalProperties: false,
    });
    const { env, cwd } = rec();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(cwd).toBe(dir);
  });

  it('the prompt carries the rules, the job prompt, the question, the draft and the answerer reason', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ escalate: true, reason: 'x' });
    await (await assessor()).assess(req(), draft, signal());
    const { stdin } = rec();
    for (const s of ['RULE: prefer sqlite', 'Build the invoicing service', 'Which database should I use?', 'use sqlite', 'the rules prefer it']) expect(stdin).toContain(s);
  });

  it.each([
    [{ escalate: false, reason: 'routine' }, { escalate: false, reason: 'routine' }],
    [{ escalate: true, reason: 'irreversible' }, { escalate: true, reason: 'irreversible' }],
  ])('returns a schema-valid assessment %j', async (structured, want) => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify(structured);
    expect(await (await assessor()).assess(req(), draft, signal())).toEqual(want);
  });

  it.each([
    ['escalate as a string', { escalate: 'false', reason: 'r' }],
    ['escalate missing', { reason: 'r' }],
    ['reason missing', { escalate: false }],
  ])('%s returns { error }', async (_n, structured) => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify(structured);
    expect(await (await assessor()).assess(req(), draft, signal())).toEqual({ error: expect.any(String) });
  });

  it.each(['malformed', 'exit1'])('%s output returns { error }', async (mode) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    expect(await (await assessor()).assess(req(), draft, signal())).toEqual({ error: expect.any(String) });
  });
});

describe('detection: which + version, never a model call', () => {
  it.each([claudeCli, claudeCliAssessor])('$id: available with the version when the bin is on PATH', async (def) => {
    const calls: string[][] = [];
    const kit = fakeKit({ version: async (bin, args) => { calls.push([bin, ...(args ?? [])]); return '2.1.0 (Claude Code)'; } });
    expect(await def.detect(kit, opts(def, {}))).toEqual({ status: 'available', detail: '2.1.0 (Claude Code)' });
    expect(calls).toEqual([['claude', '--version']]);
  });

  it.each([claudeCli, claudeCliAssessor])('$id: unavailable when the bin is missing or its --version fails', async (def) => {
    expect(await def.detect(fakeKit({ which: async () => undefined }), opts(def, { bin: 'claude' }))).toEqual({
      status: 'unavailable', reason: expect.stringContaining('claude'),
    });
    expect(await def.detect(fakeKit({ version: async () => undefined }), opts(def, {}))).toMatchObject({ status: 'unavailable' });
  });
});

describe('always-escalate', () => {
  it('is an assessor, always available, and escalates everything', async () => {
    expect(alwaysEscalate).toMatchObject({ id: 'always-escalate', role: 'assessor' });
    expect(await alwaysEscalate.detect(fakeKit(), {})).toEqual({ status: 'available' });
    const a = await alwaysEscalate.create(ctx(), {});
    expect(await a.assess(req(), draft, signal())).toEqual({ escalate: true, reason: expect.any(String) });
  });
});
