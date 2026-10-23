// A job at work on a branch of octo/tools, for the push requirements' tests (issue #2555): a commit that adds a Kotlin file
// and a coverage file under the threshold, the client the job runs, and its push.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { run, running, seedCommit, type Started } from './git-proxy.ts';

export const REQUIREMENTS = [
  'requirements:',
  '  - id: kotlin-coverage',
  '    when: { paths: ["src/**/*.kt"] }',
  '    checks:',
  '      - name: changed-files coverage',
  '        run: cat coverage.txt',
  '        thresholds: { changedLines: { min: 80 } }',
  '  - id: migrations',
  '    when: { any: [{ paths: ["**/*.sql"] }, { paths: ["**/migrations/**"] }] }',
  '    checks:',
  '      - name: migration tests',
  '        run: "false"',
].join('\n');

/** `file`: the repository's requirements file, committed on dev first; null: none. */
export async function jobOnBranch(t: Started, file: string | null = REQUIREMENTS, job?: Job) {
  if (file !== null) await seedCommit(t, 'octo/tools', 'dev', { '.hopper/requirements.yaml': file });
  const r = await running(t, 'octo/tools', job);
  expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
  const work = join(r.home, 'tools');
  await r.git(['checkout', '--quiet', '-b', 'issue-7'], work);
  mkdirSync(join(work, 'src/a'), { recursive: true });
  writeFileSync(join(work, 'src/a/B.kt'), 'class B\n');
  writeFileSync(join(work, 'coverage.txt'), 'covered 70 of 100 changed lines\nhopper-measure changedLines=70\n');
  await r.git(['add', '.'], work);
  await r.git(['commit', '--quiet', '-m', 'Add B'], work);
  const env = { ...process.env, HOPPER_URL: r.env.HOPPER_URL, HOPPER_TOKEN_FILE: join(t.root, r.env.HOPPER_TOKEN_FILE!), HOME: r.home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...Object.fromEntries(Object.entries(r.env).filter(([k]) => k.startsWith('GIT_CONFIG_'))) };
  // The launcher the job runs, which runs the client beside it.
  const requirements = (...args: string[]) => run('sh', [join(t.root, r.env.HOPPER_REQUIREMENTS!), ...args], { cwd: work, env });
  const push = () => r.git(['push', 'origin', 'HEAD:refs/heads/issue-7'], work);
  return { ...r, work, requirements, push };
}
