// File an issue (issue #471, design.md "File an issue"): one user's drafts and filed issues. `status` says whether the
// flow can run now and why not; `context` is a job's, masked, for the person to read and edit; `prompt` is exactly what
// the file-issue run skill (src/run-skills/, issue #472) is sent; `draft` runs it with the user's own signed-in Claude,
// cancelled when the person cancels, and answers the draft cleaned of secrets and personal data, with the constraints
// it broke; `check` is the confirm step, the same constraints on the text as the person edited it; `file` files that
// text only when the person confirmed it, with their own GitHub connection, on one of their job repositories, with no
// label and no assignee, so it never queues a job, and runs the constraints again. Drafts are kept nowhere: the UI holds
// them until it closes. Events never carry the text.
import {
  draftContext, filedBody, filingRefusal, type DraftAnswer, type FiledIssue, type IssueCheck, type IssueDraftRequest, type IssueDraftStatus,
} from '../domain/issue-drafts.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import { maskReportText } from '../bug-reports/context.ts';
import { PromotionGitHubError, type PromotionGitHub } from '../promotions/github.ts';
import { cleanText } from '../promotions/scan.ts';
import { checkDraft, type DraftFinding, type DraftScope } from '../run-skills/constraints.ts';
import { fileIssuePrompt, type FileIssueInput, type IssueDraft } from '../run-skills/file-issue.ts';
import { checkRunSkill, loadRunSkill, type RunSkill } from '../run-skills/index.ts';

/** The log lines of the job a draft's context carries, the last ones. */
const TAIL_LINES = 20;

/** Why a draft or a filing did not go on: `status` as the HTTP edge answers it. */
export class IssueDraftRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'IssueDraftRefused';
    this.status = status;
  }
}

/** The user's own AI connection that drafts: whether it is there now, and one run of the drafting skill. */
export interface IssueDrafter {
  provider: string;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * One run of the run skill, checked against `scope`; never throws. `signal` ends it: the person cancelled, or the time
   * is up. `findings`: what the draft broke before the drafter masked it; else the service checks the draft it got.
   */
  draft(skill: RunSkill, input: FileIssueInput, scope: DraftScope, signal: AbortSignal): Promise<(IssueDraft & { model?: string; findings?: DraftFinding[] }) | { error: string }>;
}

export type IssueGitHub = Pick<PromotionGitHub, 'repo' | 'create'>;

export interface IssueDraftsOptions {
  drafter: IssueDrafter;
  /** The repositories an issue may be filed on: the user's job repositories. */
  repos(): string[];
  /** The person's own GitHub connection for `repo`, or why there is none. */
  github(repo?: string): { api: IssueGitHub } | { problem: string };
  job(id: string): Job | undefined;
  record(event: NewEvent): void;
  /** The most a draft may take. */
  timeoutMs: number;
  /** The host name, masked in a job's context. */
  hostname?: string;
  /** The file-issue run skill; default its files as built in. */
  skill?: RunSkill;
}

export interface FileRequest {
  repo: string;
  title: string;
  body: string;
  /** The person confirmed the confirm step: nothing is filed without it. */
  confirmed: boolean;
  confirmPublic?: boolean;
  allowPersonalData?: boolean;
  /** The job the person attached as context: the filed event goes on its timeline. */
  jobId?: string;
}

export interface IssueDrafts {
  status(): Promise<IssueDraftStatus>;
  context(jobId: string): string;
  prompt(r: IssueDraftRequest): string;
  draft(r: IssueDraftRequest, signal: AbortSignal): Promise<DraftAnswer>;
  check(r: { repo: string; title: string; body: string; allowPersonalData?: boolean }): Promise<IssueCheck>;
  file(r: FileRequest, by: string): Promise<FiledIssue>;
}

const PUBLIC_NOTE = 'is public: anybody can read what is filed. Confirm it to file there';

/** GitHub's failure as a refusal: 502. */
const onGitHub = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof PromotionGitHubError) throw new IssueDraftRefused(502, e.message);
    throw e;
  }
};

export function createIssueDrafts(o: IssueDraftsOptions): IssueDrafts {
  const allowed = (repo: string): string => {
    const name = o.repos().find((r) => r.toLowerCase() === repo.toLowerCase());
    if (!name) throw new IssueDraftRefused(400, `${repo} is not one of your job repositories: pick one of them`);
    return name;
  };
  const connected = (repo: string) => {
    const gh = o.github(repo);
    if ('problem' in gh) throw new IssueDraftRefused(409, gh.problem);
    return gh.api;
  };
  const facts = async (repo: string, api: IssueGitHub) => {
    const f = await onGitHub(() => api.repo(repo));
    if (!f.hasIssues) throw new IssueDraftRefused(409, `${repo} takes no issues: pick another repository`);
    return f;
  };
  const skill = o.skill ?? loadRunSkill('file-issue');
  const skillName = `${skill.name}@${skill.id}`;
  /** The run skill's input: the repository the person chose, their text, and the context with a run again's draft. */
  const inputOf = (r: IssueDraftRequest, repo: string): FileIssueInput => {
    const context = draftContext(r);
    return { repo, text: r.text, ...(context ? { context } : {}) };
  };
  /** What the drafts are checked against (issue #475): the user's job repositories and the host name. */
  const scope = (): DraftScope => ({ repos: o.repos(), ...(o.hostname ? { known: [o.hostname] } : {}) });
  /** The constraints on the text as it would be filed: the person's title and body, no labels. */
  const findingsOf = (repo: string, title: string, body: string) => checkDraft({ repo, title, body, labels: [] }, scope());

  return {
    async status() {
      const repos = o.repos();
      const found = await o.drafter.available();
      const gh = o.github(repos[0]);
      const reason = !found.ok ? found.reason
        : 'problem' in gh ? gh.problem
          : repos.length === 0 ? 'you have no job repositories: pick some in Sources' : undefined;
      return { provider: o.drafter.provider, available: found.ok, usable: reason === undefined, ...(reason ? { reason } : {}), repos };
    },

    context(jobId) {
      const job = o.job(jobId);
      if (!job) throw new IssueDraftRefused(404, `job ${jobId} not found`);
      const s = job.source;
      const lines = [
        `- Job: ${job.id} (${job.status})`,
        ...(s?.title ? [`- Item: ${s.title}`] : []),
        ...(s?.url ? [`- Link: ${s.url}`] : []),
        ...(job.error ? [`- Error: ${job.error.split('\n')[0]!.slice(0, 500)}`] : []),
      ];
      const tail = job.errorTail?.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
      if (tail) lines.push('', `Last ${TAIL_LINES} log lines of the job:`, '', '```text', tail.replaceAll('```', "'''"), '```');
      return cleanText(maskReportText(lines.join('\n'), o.hostname));
    },

    prompt: (r) => fileIssuePrompt(skill, inputOf(r, allowed(r.repo))),

    async draft(r, signal) {
      const repo = allowed(r.repo);
      const found = await o.drafter.available();
      if (!found.ok) throw new IssueDraftRefused(409, found.reason);
      const cancelled = () => new IssueDraftRefused(499, 'the draft was cancelled');
      if (signal.aborted) throw cancelled();
      const broken = checkRunSkill(skill);
      if (broken) throw new IssueDraftRefused(500, broken);
      const timeout = AbortSignal.timeout(o.timeoutMs);
      const reply = await o.drafter.draft(skill, inputOf(r, repo), scope(), AbortSignal.any([signal, timeout]));
      if (signal.aborted) throw cancelled();
      if (timeout.aborted) throw new IssueDraftRefused(504, `${o.drafter.provider} gave no draft in ${Math.round(o.timeoutMs / 1000)} s. Your text is kept: try again`);
      if ('error' in reply) throw new IssueDraftRefused(502, `${o.drafter.provider} could not draft the issue: ${reply.error}. Your text is kept: try again`);
      // The constraints on the draft as written; then a secret or personal data is masked before the person sees it.
      // Suggested labels are dropped: filing adds none (issue #470 D8).
      const findings = reply.findings ?? checkDraft({ repo, title: reply.title, body: reply.body, labels: reply.labels ?? [] }, scope());
      const title = cleanText(reply.title.trim());
      const body = cleanText(reply.body.trim());
      o.record({ type: 'issue_draft.drafted', data: { repo, provider: o.drafter.provider, ...(reply.model ? { model: reply.model } : {}), skill: skillName, findings: findings.map((f) => f.constraint) } });
      return { repo, title, body, notes: cleanText(reply.notes.trim()), findings, provider: o.drafter.provider, ...(reply.model ? { model: reply.model } : {}), skill: skillName };
    },

    async check(r) {
      const repo = allowed(r.repo);
      const { visibility } = await facts(repo, connected(repo));
      const findings = findingsOf(repo, r.title, r.body);
      const refusal = filingRefusal(findings, { visibility, ...(r.allowPersonalData ? { allowPersonalData: true } : {}) });
      return { repo, visibility, title: r.title, body: filedBody(r.body), labels: [], assignees: [], findings, ...(refusal ? { refusal } : {}) };
    },

    async file(r, by) {
      if (!r.confirmed) throw new IssueDraftRefused(400, 'confirm the issue first: nothing is filed without your confirmation');
      const repo = allowed(r.repo);
      const api = connected(repo);
      const { visibility } = await facts(repo, api);
      // The constraints again, on the text as the person edited it, not only on the draft.
      const refusal = filingRefusal(findingsOf(repo, r.title, r.body), { visibility, ...(r.allowPersonalData ? { allowPersonalData: true } : {}) });
      if (refusal) throw new IssueDraftRefused(422, refusal);
      if (visibility === 'public' && !r.confirmPublic) throw new IssueDraftRefused(409, `${repo} ${PUBLIC_NOTE}`);
      // No label and no assignee: a filed issue never queues a job.
      const made = await onGitHub(() => api.create(repo, { title: r.title.trim(), body: filedBody(r.body), labels: [] }));
      o.record({
        type: 'issue_draft.filed', ...(r.jobId && o.job(r.jobId) ? { jobId: r.jobId } : {}),
        data: { repo, number: made.number, url: made.url, by, provider: o.drafter.provider, skill: skillName },
      });
      return { repo, number: made.number, url: made.url };
    },
  };
}
