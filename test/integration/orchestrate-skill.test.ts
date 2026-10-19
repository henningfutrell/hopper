// Issue #1909: the hopper ships the orchestrate skill itself, and a job fans out sub-tasks that survive a move. Issue
// #2145 made it one skill with work: `orchestrate` is another name of it.
//
//   Given a running job of octo/tools#7, on a machine with no workflow repository, only the hopper's own files
//   When  the job runs `sh "$HOPPER_SKILL" work`, or `sh "$HOPPER_SKILL" orchestrate`
//   Then  it gets the bundled work skill, headed by its version, and `skill.loaded` on its timeline names that version
//   When  the job files a sub-task with `--required --key fanout-t1`, and files it again with the same key
//   Then  GitHub holds one child issue, a sub-issue of octo/tools#7, and the second answer is the first (replayed)
//   When  the job moves to another machine (its proxy token is the new run's) and files the sub-task again
//   Then  the hopper answers the issue it filed, and files nothing twice; the old machine's token is refused
//   When  a second job of the same issue (Run again) files the sub-task with the same key
//   Then  the hopper answers the issue the first job filed; a job of another issue with that key files its own
//   When  the job works in a repository that has its own copy of the skill, and says so with --repo-copy
//   Then  `skill.loaded` names the copy's folder, its git tree and commit, and whether it has changes
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { builtInSkills } from '../../src/skill-library/index.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = temp('hopper-orchestrate-machine-');
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools']);
  github.issues.push({ repo: 'octo/tools', number: 7, title: 'Ship it in parts', body: 'Please.', author: 'owner', labels: ['hopper'] });
  const job = await app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7 }, ADMIN_ID);
  const env = await waitFor(async () => h.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { app, github, root, env, jobId: job.id, h };
}

/** Another job of `number` (of the item `key`, when given: a Run again), on its own machine: its variables. */
async function another(t: Awaited<ReturnType<typeof start>>, number: number, key?: string) {
  const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools', number, ...(key ? { key } : {}) }, ADMIN_ID);
  const env = await waitFor(async () => t.h.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { env, jobId: job.id };
}

/** git in `dir`, with no config of the machine's (issue #1909 tests a repository's own copy of a skill). */
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** `hopper-skill`, run as the job runs it: its variables, its files under `root`. */
function hopperSkill(root: string, env: Record<string, string>, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(root, env.HOPPER_SKILL!), ...args], {
      // No repository above the test's temp dirs counts (a job's scratch dir is inside one).
      env: { PATH: process.env.PATH, HOPPER_URL: env.HOPPER_URL, HOPPER_TOKEN_FILE: join(root, env.HOPPER_TOKEN_FILE!), GIT_CEILING_DIRECTORIES: `${tmpdir()}:${realpathSync(tmpdir())}` } as NodeJS.ProcessEnv,
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;
const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const SUB_TASK = ['issue', 'create', '--repo', 'octo/tools', '--title', 'Part one', '--body', 'The schema change.', '--required', '--key', 'fanout-t1'];

describe('the orchestrate skill the hopper ships (issue #1909)', () => {
  it('is delivered to a job with nothing installed, the same text both ways, and its version is on the job\'s timeline', async () => {
    const t = await start();
    const { version, files } = builtInSkills().find((s) => s.name === 'work')!;
    // The work skill's files beside the scripts (issue #1911) carry the same text, at the version the job's record names;
    // it requires no other skill (issue #2145).
    expect(readFileSync(join(t.root, t.env.HOPPER_WORK_SKILL!), 'utf8')).toBe(files['SKILL.md']);
    expect(eventsOf(t.app, 'job.work_skill_chosen')[0]!.data).toMatchObject({ name: 'work', version, requires: [], missing: [] });

    const catalog = await hopperSkill(t.root, t.env, []);
    expect(catalog.stdout).toMatch(/^work: /m);
    expect(catalog.stdout).not.toMatch(/^orchestrate: /m);

    // Its other name loads the same skill, and the record names the skill it loaded.
    for (const name of ['work', 'orchestrate']) {
      const r = await hopperSkill(t.root, t.env, [name]);
      expect(r.code).toBe(0);
      expect(r.stdout.startsWith(`skill work, version ${version}\n`)).toBe(true);
      expect(r.stdout).toContain(files['SKILL.md']!.trim());
    }
    expect(eventsOf(t.app, 'skill.loaded')).toEqual([0, 1].map(() => expect.objectContaining({ jobId: t.jobId, data: expect.objectContaining({ skill: 'work', version }) })));

    const missing = await hopperSkill(t.root, t.env, ['orchestrate', 'nothing.md']);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(/^no: the skill work has no file nothing\.md\. It has: SKILL\.md/);
  });

  it('a sub-task filed with a fan-out key is filed once: again, and again after a move to another machine', async () => {
    const t = await start();
    const first = await hopperGh(t.root, t.env, SUB_TASK);
    expect(first.code).toBe(0);
    expect(json(first)).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', required: true });
    expect(json(first)).not.toHaveProperty('replayed');

    const again = await hopperGh(t.root, t.env, SUB_TASK);
    expect(json(again)).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', replayed: true });

    // The lost-machine move (issue #1569): the job resumes on another machine, with the new run's proxy token.
    const store = t.app.user(ADMIN_ID).store;
    store.jobs.update(t.jobId, { movedAway: 1 });
    const elsewhere = temp('hopper-orchestrate-elsewhere-');
    cpSync(join(t.root, t.env.HOPPER_GH!), join(elsewhere, t.env.HOPPER_GH!), { recursive: true });
    writeFileSync(join(elsewhere, t.env.HOPPER_TOKEN_FILE!), `${proxyToken(store.settings.getLinkKey()!.privateKey, t.app.user(ADMIN_ID).user.id, t.jobId, 1)}\n`, { mode: 0o600 });
    const resumed = await hopperGh(elsewhere, t.env, SUB_TASK);
    expect(json(resumed)).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', replayed: true });
    expect((await hopperGh(t.root, t.env, SUB_TASK)).code).toBe(1);

    expect(t.github.issues.filter((i) => i.repo === 'octo/tools' && i.number !== 7).map((i) => i.number)).toEqual([8]);
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues).toEqual(['octo/tools#8']);
    expect(eventsOf(t.app, 'job.child_issue_filed')).toHaveLength(1);
  });

  it('a sub-task filed by an earlier job of the same issue is not filed again by the next job (Run again)', async () => {
    const t = await start();
    expect(json(await hopperGh(t.root, t.env, SUB_TASK))).toMatchObject({ number: 8 });
    t.h.held.get(t.jobId)!.end();
    await t.app.waitForStatus(t.jobId, 'finished');

    const next = await another(t, 7, (await t.app.job(t.jobId)).source!.key);
    const again = await hopperGh(t.root, next.env, SUB_TASK);
    expect(json(again)).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', replayed: true });

    // A job of another issue with the same key files its own sub-task: the key is the issue's.
    t.github.issues.push({ repo: 'octo/tools', number: 20, title: 'Another', body: 'Please.', author: 'owner', labels: ['hopper'] });
    const other = await another(t, 20);
    const own = await hopperGh(t.root, other.env, SUB_TASK);
    expect(json(own)).toMatchObject({ ok: true, number: 21, parent: 'octo/tools#20' });
    expect(json(own)).not.toHaveProperty('replayed');
    expect(t.github.issues.filter((i) => i.title === 'Part one').map((i) => i.number)).toEqual([8, 21]);
  });

  it('a repository\'s own copy of the skill: the job says it follows it, and the record names its tree and commit', async () => {
    const t = await start();
    const repo = temp('hopper-orchestrate-repo-');
    const copy = join(repo, '.agents/skills/workflow-orchestrate');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'SKILL.md'), '# The repository\'s own way\n');
    git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'skill');
    const commit = git(repo, 'rev-parse', 'HEAD');
    const tree = git(repo, 'rev-parse', 'HEAD:.agents/skills/workflow-orchestrate');

    const r = await hopperSkill(t.root, t.env, ['work', '--repo-copy', copy]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('the repository\'s own copy at .agents/skills/workflow-orchestrate');
    const { version } = builtInSkills().find((s) => s.name === 'work')!;
    expect(eventsOf(t.app, 'skill.loaded').map((e) => e.data)).toEqual([expect.objectContaining({
      skill: 'work', version, repoCopy: { path: '.agents/skills/workflow-orchestrate', tree, commit, changed: false },
    })]);

    writeFileSync(join(copy, 'SKILL.md'), '# Changed here\n');
    expect((await hopperSkill(t.root, t.env, ['orchestrate', '--repo-copy', copy])).code).toBe(0);
    expect(eventsOf(t.app, 'skill.loaded')[0]!.data.repoCopy).toEqual({ path: '.agents/skills/workflow-orchestrate', tree, commit, changed: true });

    const nowhere = await hopperSkill(t.root, t.env, ['orchestrate', '--repo-copy', temp('hopper-orchestrate-no-git-')]);
    expect(nowhere.code).toBe(2);
    expect(nowhere.stderr).toContain('is not in a git repository');
    expect(eventsOf(t.app, 'skill.loaded')).toHaveLength(2);
  });

  it('a key that is no resend key is refused before anything is filed', async () => {
    const t = await start();
    const r = await hopperGh(t.root, t.env, [...SUB_TASK.slice(0, -1), 'no!']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('a resend key');
    expect(t.github.issues).toHaveLength(1);
  });
});
