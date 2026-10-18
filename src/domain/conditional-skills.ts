// Conditional skills (issue #1924, design.md "Conditional skills"): library skills a job gets beside its work skill, because
// a skill rule of the user's matches what it works on — its repository, its labels, its kind of work. A skill may carry done
// criteria (`done.json`) that the hopper checks itself before it takes the job as done: the checks it names passed, and no
// terraform plan destroys or replaces more than its limit. Chosen at the job's first start with its work skill, and kept.
// Pure.
import type { ChecksState } from './pull-requests.ts';
import { WORK_KINDS, type WorkKind } from './skill-library.ts';

/** A skill rule: the library skill a job gets when each condition it names matches (one of its values each). */
export interface SkillRule {
  skill: string;
  /** `owner/name`, lowercased. */
  repos?: string[];
  /** A label of the job's item, any case. */
  labels?: string[];
  kinds?: WorkKind[];
}

/** What a rule reads of a job. */
export interface RuleSignals { repo?: string | undefined; labels?: readonly string[] | undefined; kind: WorkKind }

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Why `rule` cannot be a skill rule, or undefined. */
export function skillRuleProblem(rule: SkillRule): string | undefined {
  if (typeof rule !== 'object' || rule === null) return 'a skill rule is an object';
  if (typeof rule.skill !== 'string' || !NAME.test(rule.skill)) return `${JSON.stringify(rule.skill)} is no skill name`;
  const lists = [rule.repos, rule.labels, rule.kinds];
  if (lists.some((l) => l !== undefined && (!Array.isArray(l) || !l.every((v) => typeof v === 'string' && v !== '')))) return `skill rule ${rule.skill}: each condition is a list of words`;
  if (!lists.some((l) => l !== undefined && l.length > 0)) return `skill rule ${rule.skill}: name at least one condition (repos, labels, kinds)`;
  const repo = rule.repos?.find((r) => !REPO.test(r));
  if (repo !== undefined) return `skill rule ${rule.skill}: ${JSON.stringify(repo)} is no repository: write owner/name`;
  const kind = rule.kinds?.find((k) => !(WORK_KINDS as readonly string[]).includes(k));
  if (kind !== undefined) return `skill rule ${rule.skill}: ${JSON.stringify(kind)} is no kind of work (${WORK_KINDS.join(', ')})`;
  return undefined;
}

/** The rule as kept: its repositories lowercased, empty conditions dropped. */
export const keptRule = (rule: SkillRule): SkillRule => ({
  skill: rule.skill,
  ...(rule.repos?.length ? { repos: rule.repos.map((r) => r.toLowerCase()) } : {}),
  ...(rule.labels?.length ? { labels: [...rule.labels] } : {}),
  ...(rule.kinds?.length ? { kinds: [...rule.kinds] } : {}),
});

/** Why `rule` matches the job, by each condition it names (`repository o/n`, `label x`, `kind of work k`); undefined: it does not. */
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
  return why;
}

/**
 * A done criterion the hopper checks on the job's own pull request: `checks-passed`, at least one check (a check run or a
 * commit status) whose name matches `checks` ran, and each one passed; `plan-destroy`, no terraform plan in the output of the
 * checks `checks` names (every check, absent) or in the pull request's comments since its head commit destroys or replaces
 * more than `max` resources (0, absent), and one such plan is there.
 */
export type DoneCriterion = { kind: 'checks-passed'; checks: string } | { kind: 'plan-destroy'; checks?: string; max?: number };

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
    } else return `${DONE_FILE}: ${JSON.stringify(c?.kind)} is no done criterion (checks-passed, plan-destroy)`;
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

/** The destroy count of each terraform plan in `text`: a `Plan: … N to destroy` line (a replace counts there), `No changes.` 0. */
export function planDestroys(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/Plan:[^\n]*?(\d+) to destroy|No changes\. (?:Your infrastructure matches|Infrastructure is up-to-date)/g)) out.push(m[1] === undefined ? 0 : Number(m[1]));
  return out;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Each done criterion not met on the pull request, said plainly; empty: all met. */
export function unmetCriteria(criteria: readonly DoneCriterion[], pr: { checks: readonly CheckFact[]; comments: readonly string[] }): string[] {
  const out: string[] = [];
  for (const c of criteria) {
    const named = c.checks === undefined ? pr.checks : pr.checks.filter((k) => nameMatches(c.checks!, k.name));
    if (c.kind === 'checks-passed') {
      const not = named.filter((k) => k.state !== 'passing');
      if (named.length === 0) out.push(`no check named ${c.checks} ran yet`);
      else if (not.length > 0) out.push(`check ${not.map((k) => `${k.name} is ${k.state}`).join(', ')}`);
      continue;
    }
    const max = c.max ?? 0;
    const plans = [
      ...named.flatMap((k) => planDestroys(k.text ?? '').map((n) => ({ n, where: k.name }))),
      ...pr.comments.flatMap((t) => planDestroys(t).map((n) => ({ n, where: 'a comment' }))),
    ];
    if (plans.length === 0) {
      out.push(`no terraform plan summary in ${c.checks === undefined ? 'the checks' : `the checks named ${c.checks}`} or the pull request's comments`);
      continue;
    }
    const over = plans.filter((p) => p.n > max);
    if (over.length > 0) {
      const most = Math.max(...over.map((p) => p.n));
      out.push(`a terraform plan destroys or replaces ${plural(most, 'resource')} (${[...new Set(over.map((p) => p.where))].join(', ')}); at most ${max} may be`);
    }
  }
  return out;
}

/** The done criteria in plain words, for the job's prompt. */
export const criteriaLine = (criteria: readonly DoneCriterion[]): string => criteria.map((c) => (c.kind === 'checks-passed'
  ? `every check named ${c.checks} passed`
  : `no terraform plan ${c.checks === undefined ? '' : `of the checks named ${c.checks} `}destroys or replaces ${(c.max ?? 0) === 0 ? 'a resource' : `more than ${plural(c.max!, 'resource')}`}`)).join('; ');

/** A conditional skill a job got (issue #1924): kept on its timeline as `job.conditional_skills_chosen`, with why and its done criteria. */
export interface ConditionalSkillChosen { name: string; version: string; seq: number; why: string[]; done: DoneCriterion[] }

/** The variable that names the index of the job's conditional skills on its machine. */
export const CONDITIONAL_SKILLS_VARIABLE = 'HOPPER_CONDITIONAL_SKILLS';
const DIR = 'conditional-skill';
const INDEX = `${DIR}/INDEX.md`;

/** The line the job's prompt carries for its conditional skills, after the work skill's; none: no line. */
export function conditionalSkillsRule(chosen: readonly ConditionalSkillChosen[]): string | undefined {
  if (chosen.length === 0) return undefined;
  const skills = chosen.map((c) => `${c.name}, version ${c.version} (${c.why.join(', ')})`).join('; ');
  const done = chosen.filter((c) => c.done.length > 0).map((c) => `${c.name}: ${criteriaLine(c.done)}`);
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
    ...chosen.map((c) => `- \`${c.name}/SKILL.md\` (version ${c.version}): because of ${c.why.join(', ')}.${c.done.length > 0 ? ` The hopper checks before the job is done: ${criteriaLine(c.done)}.` : ''}`), ''].join('\n');
  return { files: out, paths: { [CONDITIONAL_SKILLS_VARIABLE]: INDEX } };
}

/** The text of a done-check miss by a conditional skill's done criteria (issue #1924, src/sources/github/done-criteria.ts). */
export const DONE_CRITERIA_UNMET_TEXT = /^not complete:.*\bPR #\d+: done criteria of skill [a-z0-9-]+ not (met|known)/i;

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
