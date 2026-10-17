// The repository job rules (issue #1472): what every job of one repository is told after the job rules — the config
// record `repo-job-rules`, a map from `owner/name`, or `owner/*` for every repository of that owner, to a text. Edited
// whole from the UI (POST /ui/api/repo-job-rules) or with `hopper config set`, and read when each job starts, so an edit
// reaches the next job. A job is told its owner's rules, then its repository's; a job of no repository, none.
// design.md "Repository job rules".
import type { ConfigRecords } from '../domain/ports.ts';
import type { RepoJobRulesView } from '../domain/types.ts';
import { JOB_RULES_MAX_BYTES } from './index.ts';

/** The config record that holds them. */
export const REPO_JOB_RULES = 'repo-job-rules';

/** The most repositories (and owners) that may have rules. */
export const REPO_JOB_RULES_MAX_REPOS = 100;

const NAME = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;

const isMap = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Why `raw` cannot be the repository job rules, or undefined. */
export function repoJobRulesProblem(raw: unknown): string | undefined {
  if (!isMap(raw)) return 'the repository job rules are a map of repository to text';
  const names = Object.keys(raw);
  if (names.length > REPO_JOB_RULES_MAX_REPOS) return `at most ${REPO_JOB_RULES_MAX_REPOS} repositories have rules; this has ${names.length}`;
  const seen = new Map<string, string>();
  for (const name of names) {
    if (!NAME.test(name)) return `${name} is no repository: write owner/name or owner/*`;
    const text = raw[name];
    if (typeof text !== 'string') return `the rules of ${name} are a text`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > JOB_RULES_MAX_BYTES) return `the rules of ${name} may hold at most 16 KiB; this is ${bytes} bytes`;
    const other = seen.get(name.toLowerCase());
    if (other !== undefined) return `${name} and ${other} name one repository`;
    seen.set(name.toLowerCase(), name);
  }
  return undefined;
}

const saved = (config: ConfigRecords): Record<string, string> => {
  const raw = config.read(REPO_JOB_RULES);
  return raw !== undefined && repoJobRulesProblem(raw) === undefined ? raw as Record<string, string> : {};
};

/** What a job of `repo` (`owner/name`) is told after the job rules: its owner's rules, then its repository's; else ''. */
export function repoJobRulesFor(config: ConfigRecords, repo: string | undefined): string {
  if (!repo) return '';
  const wanted = repo.toLowerCase();
  const owner = `${wanted.split('/')[0]}/*`;
  const rules = Object.entries(saved(config));
  return [owner, wanted]
    .flatMap((key) => rules.filter(([name]) => name.toLowerCase() === key))
    .filter(([, text]) => text.trim() !== '')
    .map(([name, text]) => `[hopper repository rules] Rules set in the hopper for every job of ${name}:\n${text.trim()}`)
    .join('\n');
}

/** The job rules followed by the repository job rules. */
export const withRepoJobRules = (jobRules: string, repoRules: string): string =>
  repoRules === '' ? jobRules : jobRules === '' ? repoRules : `${jobRules}\n${repoRules}`;

/** The repository job rules as the UI reads them, sorted by name; `version` is the record's. */
export function repoJobRulesView(config: ConfigRecords): RepoJobRulesView {
  const repos = Object.entries(saved(config)).map(([repo, text]) => ({ repo, text })).sort((a, b) => a.repo.localeCompare(b.repo));
  return { repos, version: config.version(REPO_JOB_RULES) };
}

export type RepoJobRulesEdit = { ok: true; view: RepoJobRulesView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the repository job rules with `repos` if they are still at `version`. */
export function writeRepoJobRules(config: ConfigRecords, repos: Record<string, string>, version: string): RepoJobRulesEdit {
  const problem = repoJobRulesProblem(repos);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!config.write(REPO_JOB_RULES, repos, version)) return { ok: false, code: 'conflict', error: 'the repository job rules changed since they were read; reload and edit again' };
  return { ok: true, view: repoJobRulesView(config) };
}
