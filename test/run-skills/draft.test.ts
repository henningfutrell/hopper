// A file-issue run (issue #472, design.md "Run skills") against a fake `claude`: the skill goes on stdin, nothing is
// written for it, and the run leaves nothing on the machine — on success, on an error and on a login that expired —,
// with the user's own config dirs unchanged. The draft comes back checked against the constraints, with the skill id.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ON_MACHINE, type ClaudePrintOptions } from '../../src/plugins/claude-print.ts';
import { draftIssue } from '../../src/run-skills/draft.ts';
import { loadRunSkill } from '../../src/run-skills/index.ts';
import type { LoginReport, RunLogins } from '../../src/domain/types.ts';

const BIN = join(import.meta.dirname, '..', 'plugins', 'fake-claude.mjs');
const KEYS = ['FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_STRUCTURED', 'FAKE_CLAUDE_LITTER', 'CLAUDE_CONFIG_DIR'];
const saved: Record<string, string | undefined> = {};
let dir: string;
let config: string;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'jh-run-skill-'));
  config = join(dir, 'claude-config');
  mkdirSync(join(config, 'skills'), { recursive: true });
  writeFileSync(join(config, 'settings.json'), '{"mine":true}');
  process.env.FAKE_CLAUDE_OUT = join(dir, 'rec.json');
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_LITTER;
  process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ title: 'Export button does nothing', body: '## Summary\n\nThe export button does nothing.', labels: ['bug'], notes: 'rephrased' });
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});

const rec = () => JSON.parse(readFileSync(join(dir, 'rec.json'), 'utf8')) as { argv: string[]; stdin: string; cwd: string };
const signal = () => new AbortController().signal;
/** As on an attached machine: claude through ON_MACHINE, in a fresh private dir, here. */
const onMachine: ClaudePrintOptions['wrap'] = (argv) => ['sh', ['-c', ON_MACHINE, 'sh', ...argv]];
const run = (over: Partial<Omit<ClaudePrintOptions, 'jsonSchema'>> = {}) => ({ bin: BIN, model: 'opus', cwd: dir, timeoutMs: 5000, ...over });
const input = { repo: 'acme/widgets', text: 'The export button does nothing.' };

function fakeLogins() {
  const reports: LoginReport[] = [];
  const ends: string[] = [];
  const logins: RunLogins = {
    report: (r) => { reports.push(r); return 'login-1'; },
    check: () => ({ action: 'wait' }) as never,
    completed: () => { ends.push('completed'); },
    expired: () => { ends.push('expired'); },
    failed: (_id, reason) => { ends.push(`failed: ${reason}`); },
  } as RunLogins;
  return { logins, reports, ends };
}

describe('draftIssue', () => {
  it('sends the skill on stdin, locked down, and answers the draft, its findings and the skill id', async () => {
    const skill = loadRunSkill('file-issue');
    const r = await draftIssue(run(), input, signal());
    expect(r).toMatchObject({ draft: { title: 'Export button does nothing', labels: ['bug'], notes: 'rephrased' }, findings: [], skill: { name: 'file-issue', id: skill.id } });
    const { argv, stdin } = rec();
    expect(stdin).toContain(skill.id);
    expect(stdin).toContain('The export button does nothing.');
    expect(argv).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--tools']));
    expect(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', '']);
  });

  it('a draft that breaks a constraint comes back with its findings, never filed or changed', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ title: 'Export fails', body: 'Reported by @octocat', labels: ['hopper'], notes: '' });
    const r = await draftIssue(run(), input, signal());
    expect('findings' in r && r.findings.map((f) => f.constraint).sort()).toEqual(['no-hopper-label', 'no-mention']);
  });

  it('a skill whose files do not match its id is refused before claude runs', async () => {
    const skill = loadRunSkill('file-issue');
    const tampered = { ...skill, files: { ...skill.files, 'template.md': 'changed' } };
    const r = await draftIssue(run(), input, signal(), tampered);
    expect(r).toEqual({ error: expect.stringMatching(/do not match its id/) });
    expect(existsSync(join(dir, 'rec.json'))).toBe(false);
  });

  it('a device code the run waits on goes to the logins, never into the answer', async () => {
    process.env.FAKE_CLAUDE_MODE = 'device-code-fails';
    const { logins, reports, ends } = fakeLogins();
    const r = await draftIssue(run({ logins }), input, signal());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ tool: 'gh' });
    expect(ends[0]).toMatch(/^failed/);
    expect(JSON.stringify(r)).not.toContain('WDJB-MJHT');
  });

  for (const [what, mode] of [['success', undefined], ['an error', 'exit1'], ['a login that expired', 'device-code-fails']] as const) {
    it(`leaves no file of the skill or the session on the machine after ${what}, and the user's config dirs unchanged`, async () => {
      if (mode) process.env.FAKE_CLAUDE_MODE = mode;
      process.env.FAKE_CLAUDE_LITTER = '1';
      const before = readdirSync(config).sort();
      await draftIssue(run({ wrap: onMachine }), input, signal());
      const { cwd } = rec();
      expect(cwd).not.toBe(dir);
      expect(existsSync(cwd)).toBe(false);
      expect(existsSync(join(config, 'projects')) ? readdirSync(join(config, 'projects')) : []).toEqual([]);
      expect(readdirSync(config).filter((n) => n !== 'projects').sort()).toEqual(before);
      expect(readdirSync(join(config, 'skills'))).toEqual([]);
      expect(readFileSync(join(config, 'settings.json'), 'utf8')).toBe('{"mine":true}');
    });
  }
});
