// scripts/migrate-sources-yaml.ts — what install.sh runs on ~/.config/job-hopper/sources.yaml:
// writes the phase-4 starter when absent; else rewrites the exact phase-3 starter line to
// `enabled: auto` once, warns about any other value and keeps it, and appends a commented
// `githubApp:` block once. Run against temp files only.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSourcesFile } from '../../src/sources/config.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-sources-yaml.ts', import.meta.url));
const run = promisify(execFile);
const STARTER_LINE = '  enabled: true              # false: pull nothing from GitHub';
const AUTO_LINE = '  enabled: auto               # auto: on only while no GitHub App is configured';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function temp(text?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'jh-migrate-'));
  dirs.push(d);
  const p = join(d, 'sources.yaml');
  if (text !== undefined) writeFileSync(p, text, { mode: 0o600 });
  return p;
}

async function migrate(path: string): Promise<{ stdout: string; stderr: string }> {
  return run('node', [SCRIPT, path]);
}

const phase3 = (enabledLine: string) => [
  '# job-hopper job sources.',
  'version: 1',
  'github:',
  enabledLine,
  '  pollSeconds: 60            # how often to sync',
  '  authors: [owner]  # only issues and replies by these authors are ever acted on',
  '',
].join('\n');

describe('migrate-sources-yaml', () => {
  it('rewrites the exact phase-3 starter line to auto, appends githubApp, says both; the result loads', async () => {
    const p = temp(phase3(STARTER_LINE));
    const r = await migrate(p);
    const text = readFileSync(p, 'utf8');
    expect(text.split('\n')).toContain(AUTO_LINE);
    expect(text).not.toContain(STARTER_LINE);
    expect(text.match(/^githubApp:/gm)).toHaveLength(1);
    expect(r.stdout).toContain(AUTO_LINE.trim());
    expect(r.stdout).toMatch(/githubApp/);
    const loaded = loadSourcesFile(p);
    if ('error' in loaded) throw new Error(loaded.error);
    expect(loaded.github?.enabled).toBe('auto');
    expect(loaded.githubApp).toMatchObject({ enabled: true, authors: ['owner'], label: 'hopper' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second run changes nothing and says so', async () => {
    const p = temp(phase3(STARTER_LINE));
    await migrate(p);
    const once = readFileSync(p, 'utf8');
    const r = await migrate(p);
    expect(readFileSync(p, 'utf8')).toBe(once);
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toMatch(/rewrote|append/i);
  });

  it.each(['  enabled: true', '  enabled: false   # mine', '  enabled: true              # edited comment'])(
    'any other value (%s) is kept, with a warning naming the file and the line', async (line) => {
      const p = temp(phase3(line));
      const r = await migrate(p);
      const text = readFileSync(p, 'utf8');
      expect(text.split('\n')).toContain(line);
      expect(r.stderr).toContain(p);
      expect(r.stderr).toContain(line.trim());
      expect(text.match(/^githubApp:/gm)).toHaveLength(1);
    });

  it('a file that already has githubApp gets no second block', async () => {
    const p = temp(`${phase3(AUTO_LINE)}githubApp:\n  enabled: false\n`);
    await migrate(p);
    const text = readFileSync(p, 'utf8');
    expect(text.match(/^githubApp:/gm)).toHaveLength(1);
    expect(text).toContain('  enabled: false');
  });

  it('no file: writes the phase-4 starter (auto + githubApp), mode 600, which loads', async () => {
    const p = temp();
    const r = await migrate(p);
    const text = readFileSync(p, 'utf8');
    expect(text.split('\n')).toContain(AUTO_LINE);
    expect(text.match(/^githubApp:/gm)).toHaveLength(1);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(r.stdout).toContain(p);
    const loaded = loadSourcesFile(p);
    if ('error' in loaded) throw new Error(loaded.error);
    expect(loaded.github).toMatchObject({ enabled: 'auto', authors: ['owner'] });
    expect(loaded.githubApp).toMatchObject({ enabled: true, appFile: expect.stringMatching(/\.config\/job-hopper\/github-app\.json$/) });
  });

  it('drops every progressCommentSeconds line (no progress comment exists any more), says so; the result loads; idempotent', async () => {
    const p = temp(`${phase3(AUTO_LINE)}  progressCommentSeconds: 300  # at most one progress-comment edit\ngithubApp:\n  enabled: true\n  progressCommentSeconds: 300\n  recentComments: 10\n`);
    const r = await migrate(p);
    const text = readFileSync(p, 'utf8');
    expect(text).not.toContain('progressCommentSeconds');
    expect(text).toContain('  recentComments: 10');
    expect(r.stdout).toMatch(/progressCommentSeconds/);
    const loaded = loadSourcesFile(p);
    if ('error' in loaded) throw new Error(loaded.error);
    expect(loaded.githubApp).toMatchObject({ enabled: true, recentComments: 10 });
    const again = await migrate(p);
    expect(readFileSync(p, 'utf8')).toBe(text);
    expect(again.stdout).not.toMatch(/progressCommentSeconds/);
  });

  it('a starter written today has no progressCommentSeconds', async () => {
    const p = temp();
    await migrate(p);
    expect(readFileSync(p, 'utf8')).not.toContain('progressCommentSeconds');
  });
});
