// Conditional skills (issue #1924, design.md "Conditional skills"): library skills a job gets beside its work skill, because
// a skill rule of the user's matches what it works on — its repository, its labels, its kind of work. A skill may carry done
// criteria (`done.json`) that the hopper checks itself before it takes the job as done: the checks it names passed, and no
// terraform plan destroys or replaces more than its limit, but for the deletes the job's issue allows by address. Chosen at
// the job's first start with its work skill, and kept; a rule's paths (part 2) are read at the done check, once the job pushed.
// Pure.
import { posix } from 'node:path';
import type { ChecksState } from './pull-requests.ts';
import { WORK_KINDS, type WorkKind } from './skill-library.ts';

/** A skill rule: the library skill a job gets when each condition it names matches (one of its values each). */
export interface SkillRule {
  skill: string;
  /** `owner/name`, or a GitLab project's whole path (`group/subgroup/name`, issue #1924 part 4), lowercased. */
  repos?: string[];
  /** A label of the job's item, any case. */
  labels?: string[];
  kinds?: WorkKind[];
  /**
   * Globs of the files the change touches (`*.tf`, `src/**`; a glob with no slash matches a file name in any folder). Not known
   * at the start: the rule gives its skill then, and the done check applies the skill's criteria only when a file matches.
   */
  paths?: string[];
}

/** What a rule reads of a job. */
export interface RuleSignals { repo?: string | undefined; labels?: readonly string[] | undefined; kind: WorkKind }

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

/** Why `rule` cannot be a skill rule, or undefined. */
export function skillRuleProblem(rule: SkillRule): string | undefined {
  if (typeof rule !== 'object' || rule === null) return 'a skill rule is an object';
  if (typeof rule.skill !== 'string' || !NAME.test(rule.skill)) return `${JSON.stringify(rule.skill)} is no skill name`;
  const lists = [rule.repos, rule.labels, rule.kinds, rule.paths];
  if (lists.some((l) => l !== undefined && (!Array.isArray(l) || !l.every((v) => typeof v === 'string' && v !== '')))) return `skill rule ${rule.skill}: each condition is a list of words`;
  if (!lists.some((l) => l !== undefined && l.length > 0)) return `skill rule ${rule.skill}: name at least one condition (repos, labels, kinds, paths)`;
  const repo = rule.repos?.find((r) => !REPO.test(r));
  if (repo !== undefined) return `skill rule ${rule.skill}: ${JSON.stringify(repo)} is no repository: write owner/name, or a GitLab project's group/name`;
  const kind = rule.kinds?.find((k) => !(WORK_KINDS as readonly string[]).includes(k));
  if (kind !== undefined) return `skill rule ${rule.skill}: ${JSON.stringify(kind)} is no kind of work (${WORK_KINDS.join(', ')})`;
  const path = rule.paths?.find((p) => p.startsWith('/') || p.split('/').includes('..'));
  if (path !== undefined) return `skill rule ${rule.skill}: ${JSON.stringify(path)} is no relative path glob`;
  return undefined;
}

/** The rule as kept: its repositories lowercased, empty conditions dropped. */
export const keptRule = (rule: SkillRule): SkillRule => ({
  skill: rule.skill,
  ...(rule.repos?.length ? { repos: rule.repos.map((r) => r.toLowerCase()) } : {}),
  ...(rule.labels?.length ? { labels: [...rule.labels] } : {}),
  ...(rule.kinds?.length ? { kinds: [...rule.kinds] } : {}),
  ...(rule.paths?.length ? { paths: [...rule.paths] } : {}),
});

/**
 * Why `rule` matches the job, by each condition it names (`repository o/n`, `label x`, `kind of work k`, `paths a, b`);
 * undefined: it does not. Its paths are not known at the start: they are said, and the done check reads them (`pathsApply`).
 */
export function ruleMatch(rule: SkillRule, job: RuleSignals): string[] | undefined {
  const why: string[] = [];
  if (rule.repos?.length) {
    const repo = job.repo?.toLowerCase();
    if (!repo || !rule.repos.some((r) => r.toLowerCase() === repo)) return undefined;
    why.push(`repository ${repo}`);
  }
  if (rule.labels?.length) {
    const label = rule.labels.find((l) => (job.labels ?? []).some((j) => j.toLowerCase() === l.toLowerCase()));
    if (label === undefined) return undefined;
    why.push(`label ${label.toLowerCase()}`);
  }
  if (rule.kinds?.length) {
    if (!rule.kinds.includes(job.kind)) return undefined;
    why.push(`kind of work ${job.kind}`);
  }
  if (rule.paths?.length) why.push(`paths ${rule.paths.join(', ')}`);
  return why;
}

export const globMatches = (glob: string, file: string): boolean =>
  posix.matchesGlob(file, glob) || (!glob.includes('/') && posix.matchesGlob(posix.basename(file), glob));

/**
 * Whether a skill a rule with `paths` gave applies to the pull request: one of its changed files matches. No paths, or the
 * files not known (no mirror) or not all named: it applies — not known is not a pass.
 */
export function pathsApply(paths: readonly string[] | undefined, pr: { files?: readonly string[] | undefined; filesCut?: true | undefined }): boolean {
  if (!paths?.length || pr.files === undefined || pr.filesCut) return true;
  return pr.files.some((f) => paths.some((g) => globMatches(g, f)));
}

/**
 * A done criterion the hopper checks on the job's own pull request: `checks-passed`, at least one check (a check run or a
 * commit status) whose name matches `checks` ran, and each one passed; `plan-destroy`, no terraform plan in the output of the
 * checks `checks` names (every check, absent) or in the pull request's comments since its head commit destroys or replaces
 * more than `max` resources (0, absent), and one such plan is there; `person-merges`, a person merges it (below).
 */
export type DoneCriterion = { kind: 'checks-passed'; checks: string } | { kind: 'plan-destroy'; checks?: string; max?: number }
  /**
   * `person-merges` (part 3): a person merges the pull request, never the hopper's yolo mode, when it changes a file `paths`
   * matches (always, absent; files not known: it applies). No miss at the done check: it holds the merge only (`mergeHolds`).
   */
  | { kind: 'person-merges'; paths?: string[] };

/** The file beside a skill's SKILL.md that holds its done criteria: `{ "criteria": [...] }`. */
export const DONE_FILE = 'done.json';

/** Why `text` cannot be a done.json, or undefined. */
export function doneFileProblem(text: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return `${DONE_FILE} is no JSON`; }
  const criteria = (parsed as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(criteria)) return `${DONE_FILE} holds { "criteria": [...] }`;
  for (const c of criteria as Record<string, unknown>[]) {
    if (c?.kind === 'checks-passed') {
      if (typeof c.checks !== 'string' || c.checks === '') return `${DONE_FILE}: checks-passed names its checks ("checks": a name, * for any text)`;
    } else if (c?.kind === 'plan-destroy') {
      if (c.checks !== undefined && (typeof c.checks !== 'string' || c.checks === '')) return `${DONE_FILE}: plan-destroy's "checks" is a name, * for any text`;
      if (c.max !== undefined && (!Number.isInteger(c.max) || (c.max as number) < 0)) return `${DONE_FILE}: plan-destroy's "max" is a whole number, 0 or more`;
    } else if (c?.kind === 'person-merges') {
      if (c.paths !== undefined && !(Array.isArray(c.paths) && c.paths.every((p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').includes('..')))) return `${DONE_FILE}: person-merges's "paths" is a list of relative path globs`;
    } else return `${DONE_FILE}: ${JSON.stringify(c?.kind)} is no done criterion (checks-passed, plan-destroy, person-merges)`;
  }
  return undefined;
}

/** A skill version's done criteria: its done.json's, else none. A done.json that is not valid gives none: its save refused it. */
export function doneCriteriaOf(files: Record<string, string>): DoneCriterion[] {
  const text = files[DONE_FILE];
  if (text === undefined || doneFileProblem(text) !== undefined) return [];
  return (JSON.parse(text) as { criteria: DoneCriterion[] }).criteria;
}

/** A check of the pull request's head commit, as the done check reads it: a check run's output text, a status none. */
export interface CheckFact { name: string; state: ChecksState; text?: string }

/** Whether a check's name matches `pattern`: any case, `*` any text. */
export function nameMatches(pattern: string, name: string): boolean {
  const re = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}$`, 'i').test(name);
}

// eslint-disable-next-line no-control-regex -- terminal colour codes in a check's output
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const PLAN = /Plan:[^\n]*?(\d+) to destroy|No changes\. (?:Your infrastructure matches|Infrastructure is up-to-date)/g;
const DESTROYED = /^[^\S\n]*#[^\S\n]+(\S+?)(?:[^\S\n]+\(deposed object \w+\))?[^\S\n]+(?:will be destroyed|must be replaced|will be replaced|is tainted, so must be replaced)/gm;

/** The addresses a terraform plan's resource lines destroy or replace (`# <address> will be destroyed`, `must be replaced`), each once. */
export const destroyedAddresses = (text: string): string[] =>
  [...new Set([...text.replace(ANSI, '').matchAll(DESTROYED)].map((m) => m[1]!))];

/**
 * Each terraform plan in `text`: its destroy count, from its `Plan: … N to destroy` line (a replace counts there; `No changes.`
 * 0), and the addresses its resource lines destroy or replace — the lines after the plan before it.
 */
export function plansIn(text: string): { destroys: number; addresses: string[] }[] {
  const plain = text.replace(ANSI, '');
  const out: { destroys: number; addresses: string[] }[] = [];
  let from = 0;
  for (const m of plain.matchAll(PLAN)) {
    out.push({ destroys: m[1] === undefined ? 0 : Number(m[1]), addresses: destroyedAddresses(plain.slice(from, m.index)) });
    from = m.index + m[0].length;
  }
  return out;
}

/** The destroy count of each terraform plan in `text`. */
export const planDestroys = (text: string): number[] => plansIn(text).map((p) => p.destroys);

const ALLOWED = /^[\s#>*_-]*allowed (?:deletes|destroys)[*_\s]*:?[*_]*(.*)$/i;
const ADDRESS = /^[A-Za-z_][\w-]*(?:\[[^\]\s]+\])?(?:\.[A-Za-z_][\w-]*(?:\[[^\]\s]+\])?)+$/;
const addressesOf = (part: string): string[] => {
  const quoted = [...part.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  return (quoted.length > 0 ? quoted : part.split(/[\s,]+/)).filter((a) => ADDRESS.test(a));
};

/**
 * The deletes an issue allows, by resource address: after a line `Allowed deletes:` (a heading or bold too), the addresses on
 * that line and in the list right below it (`-` or `*` items). Read from the text the job runs, never from a live edit.
 */
export function allowedDeletesIn(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    let listing = false;
    for (const line of text.split('\n')) {
      const head = ALLOWED.exec(line);
      if (head) { out.push(...addressesOf(head[1]!)); listing = true; continue; }
      const item = listing ? /^\s*[-*+]\s+(.*)$/.exec(line) : null;
      if (item) out.push(...addressesOf(item[1]!));
      else listing = false;
    }
  }
  return [...new Set(out)];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Each done criterion not met on the pull request, said plainly; empty: all met. `allowed`: the deletes the job's issue allows
 * by address (`allowedDeletesIn`); a plan's delete of one of them does not count.
 */
export function unmetCriteria(criteria: readonly DoneCriterion[], pr: { checks: readonly CheckFact[]; comments: readonly string[]; allowed?: readonly string[] }): string[] {
  const allowed = new Set(pr.allowed ?? []);
  const out: string[] = [];
  for (const c of criteria) {
    if (c.kind === 'person-merges') continue;
    const named = c.checks === undefined ? pr.checks : pr.checks.filter((k) => nameMatches(c.checks!, k.name));
    if (c.kind === 'checks-passed') {
      const not = named.filter((k) => k.state !== 'passing');
      if (named.length === 0) out.push(`no check named ${c.checks} ran yet`);
      else if (not.length > 0) out.push(`check ${not.map((k) => `${k.name} is ${k.state}`).join(', ')}`);
      continue;
    }
    const max = c.max ?? 0;
    const counted = (p: { destroys: number; addresses: string[] }, where: string) => {
      const not = p.addresses.filter((a) => !allowed.has(a));
      return { n: Math.max(p.destroys - (p.addresses.length - not.length), 0), not, where };
    };
    const plans = [
      ...named.flatMap((k) => plansIn(k.text ?? '').map((p) => counted(p, k.name))),
      ...pr.comments.flatMap((t) => plansIn(t).map((p) => counted(p, 'a comment'))),
    ];
    if (plans.length === 0) {
      out.push(`no terraform plan summary in ${c.checks === undefined ? 'the checks' : `the checks named ${c.checks}`} or the pull request's comments`);
      continue;
    }
    const over = plans.filter((p) => p.n > max);
    if (over.length > 0) {
      const most = Math.max(...over.map((p) => p.n));
      const not = allowed.size > 0 ? [...new Set(over.flatMap((p) => p.not))] : [];
      out.push(`a terraform plan destroys or replaces ${plural(most, 'resource')} (${[...new Set(over.map((p) => p.where))].join(', ')})${not.length > 0 ? `: ${not.join(', ')}, which the issue does not allow` : ''}; at most ${max} may be`);
    }
  }
  return out;
}

const personMerges = (paths: readonly string[] | undefined): string => `a person merges ${paths?.length ? `a change to ${paths.join(', ')}` : 'it'}, not the hopper`;

/**
 * Why the hopper must not merge the pull request itself (part 3): each `person-merges` criterion that applies to it, by the
 * files it changes (`pathsApply`: files not known apply). Empty: no hold.
 */
export const mergeHolds = (criteria: readonly DoneCriterion[], pr: { files?: readonly string[] | undefined; filesCut?: true | undefined }): string[] =>
  criteria.flatMap((c) => (c.kind === 'person-merges' && pathsApply(c.paths, pr) ? [personMerges(c.paths)] : []));

/** The done criteria in plain words, for the job's prompt. */
export const criteriaLine = (criteria: readonly DoneCriterion[]): string => criteria.map((c) => (c.kind === 'person-merges' ? personMerges(c.paths) : c.kind === 'checks-passed'
  ? `every check named ${c.checks} passed`
  : `no terraform plan ${c.checks === undefined ? '' : `of the checks named ${c.checks} `}destroys or replaces ${(c.max ?? 0) === 0 ? 'a resource' : `more than ${plural(c.max!, 'resource')}`}`)).join('; ');

/** A conditional skill a job got (issue #1924): kept on its timeline as `job.conditional_skills_chosen`, with why and its done criteria. */
export interface ConditionalSkillChosen {
  name: string; version: string; seq: number; why: string[]; done: DoneCriterion[];
  /** Its done criteria apply only when the change touches a file these match (`pathsApply`); absent: always. */
  paths?: string[];
}

/** A conditional skill's done criteria in plain words, after when they apply. */
const doneWhen = (c: ConditionalSkillChosen): string => `${c.paths?.length ? `when the change touches ${c.paths.join(', ')}: ` : ''}${criteriaLine(c.done)}`;
const doneOf = (c: ConditionalSkillChosen): string => `${c.name}${c.paths?.length ? ', ' : ': '}${doneWhen(c)}`;

/** The variable that names the index of the job's conditional skills on its machine. */
export const CONDITIONAL_SKILLS_VARIABLE = 'HOPPER_CONDITIONAL_SKILLS';
const DIR = 'conditional-skill';
const INDEX = `${DIR}/INDEX.md`;

/** The line the job's prompt carries for its conditional skills, after the work skill's; none: no line. */
export function conditionalSkillsRule(chosen: readonly ConditionalSkillChosen[]): string | undefined {
  if (chosen.length === 0) return undefined;
  const skills = chosen.map((c) => `${c.name}, version ${c.version} (${c.why.join(', ')})`).join('; ');
  const done = chosen.filter((c) => c.done.length > 0).map(doneOf);
  return `[hopper conditional skills] Because of what this job works on, it also has these skills: ${skills}. When the variable ${CONDITIONAL_SKILLS_VARIABLE} is set, read the file it names before you start: it lists each skill's SKILL.md. Follow them where the job rules and the repository's rules do not say otherwise.${done.length > 0 ? ` The hopper checks before the job is done: ${done.join('; ')}.` : ''}`;
}

/** The job rules followed by the conditional skills' line. */
export function withConditionalSkills(jobRules: string, chosen: readonly ConditionalSkillChosen[]): string {
  const line = conditionalSkillsRule(chosen);
  return line === undefined ? jobRules : jobRules === '' ? line : `${jobRules}\n${line}`;
}

/** The conditional skills' files as the job's credentials files, with their index, and the variable that names the index. */
export function conditionalSkillsCredentials(chosen: readonly ConditionalSkillChosen[], files: Record<string, Record<string, string>>): { files: Record<string, string>; paths: Record<string, string> } {
  if (chosen.length === 0) return { files: {}, paths: {} };
  const out: Record<string, string> = {};
  for (const c of chosen) for (const [path, text] of Object.entries(files[c.name] ?? {})) out[`${DIR}/${c.name}/${path}`] = text;
  out[INDEX] = ['# Conditional skills', '', 'Paths are relative to this file.', '',
    ...chosen.map((c) => `- \`${c.name}/SKILL.md\` (version ${c.version}): because of ${c.why.join(', ')}.${c.done.length > 0 ? ` The hopper checks before the job is done: ${doneWhen(c)}.` : ''}`), ''].join('\n');
  return { files: out, paths: { [CONDITIONAL_SKILLS_VARIABLE]: INDEX } };
}

/**
 * The text of a done-check miss by a conditional skill's done criteria (issue #1924, src/sources/github/done-criteria.ts): on a
 * pull request, `PR #N`, or a GitLab merge request, `MR !N` (part 4, src/gitlab/done-criteria.ts).
 */
export const DONE_CRITERIA_UNMET_TEXT = /^not complete:.*(?:\bPR #|\bMR !)\d+: done criteria of skill [a-z0-9-]+ not (met|known)/i;

/** What a job sent back for its unmet done criteria is told (issue #1924): what the hopper found, and to fix it on its branch. */
export function doneCriteriaBrief(error: string, resumes: boolean): string {
  const found = error.replace(/^not complete:\s*/i, '');
  return [resumes
    ? 'The hopper sends this job back to you in this same session and work tree: you ended the job as done, but the done criteria of its skills are not met.'
    : 'The hopper runs this issue again: the earlier job ended as done, but the done criteria of its skills were not met. Look for its branch and its pull request first.',
  `What the hopper found: ${found}.`,
  'Work on the branch of the pull request. Fix the cause in the code, push, and wait for the checks to end.',
  'Read the checks and the plan summaries again. Do not open a new pull request.',
  'When each done criterion is met, end the job as done. If you cannot meet one, end the job as failed and say why.'].join('\n');
}
