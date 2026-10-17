// File an issue (issue #471, design.md "File an issue"): one user's drafts and filed issues. `status` says whether the
// flow can run now and why not; `context` is a job's, masked, for the person to read and edit; `prompt` is exactly what
// the drafting skill is sent; `draft` runs it with the user's own signed-in Claude, cancelled when the person cancels,
// and answers the draft cleaned of secrets and personal data; `check` is the confirm step, on the text as the person
// edited it; `file` files that text only when the person confirmed it, with their own GitHub connection, on one of
// their job repositories, with no label and no assignee, so it never queues a job. The scan runs again at `file`, on
// the edited text. Drafts are kept nowhere: the UI holds them until it closes. Events never carry the text.
import {
  filedBody, ISSUE_DRAFT_SKILL, ISSUE_TITLE_MAX, issueDraftPrompt,
  type FiledIssue, type IssueCheck, type IssueDraft, type IssueDraftRequest, type IssueDraftStatus,
} from '../domain/issue-drafts.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import { maskReportText, TAIL_LINES } from '../bug-reports/context.ts';
import { PromotionGitHubError, type PromotionGitHub } from '../promotions/github.ts';
import { cleanText, postRefusal, scanText } from '../promotions/scan.ts';

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
  /** One run; never throws. `signal` ends it: the person cancelled, or the time is up. */
  draft(prompt: string, signal: AbortSignal): Promise<{ title: string; body: string; model?: string } | { error: string }>;
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
  draft(r: IssueDraftRequest, signal: AbortSignal): Promise<IssueDraft>;
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
  const scanOf = (title: string, body: string) => scanText(`${title}\n${filedBody(body)}`);

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

    prompt: (r) => issueDraftPrompt({ ...r, repo: allowed(r.repo) }),

    async draft(r, signal) {
      const repo = allowed(r.repo);
      const found = await o.drafter.available();
      if (!found.ok) throw new IssueDraftRefused(409, found.reason);
      const cancelled = () => new IssueDraftRefused(499, 'the draft was cancelled');
      if (signal.aborted) throw cancelled();
      const timeout = AbortSignal.timeout(o.timeoutMs);
      const reply = await o.drafter.draft(issueDraftPrompt({ ...r, repo }), AbortSignal.any([signal, timeout]));
      if (signal.aborted) throw cancelled();
      if (timeout.aborted) throw new IssueDraftRefused(504, `${o.drafter.provider} gave no draft in ${Math.round(o.timeoutMs / 1000)} s. Your text is kept: try again`);
      if ('error' in reply) throw new IssueDraftRefused(502, `${o.drafter.provider} could not draft the issue: ${reply.error}. Your text is kept: try again`);
      const title = cleanText(reply.title.trim()).slice(0, ISSUE_TITLE_MAX);
      const body = cleanText(reply.body.trim());
      const findings = scanText(`${reply.title}\n${reply.body}`);
      o.record({ type: 'issue_draft.drafted', data: { repo, provider: o.drafter.provider, ...(reply.model ? { model: reply.model } : {}), skill: ISSUE_DRAFT_SKILL, masked: findings.length > 0 } });
      return { repo, title, body, findings, provider: o.drafter.provider, ...(reply.model ? { model: reply.model } : {}), skill: ISSUE_DRAFT_SKILL };
    },

    async check(r) {
      const repo = allowed(r.repo);
      const { visibility } = await facts(repo, connected(repo));
      const findings = scanOf(r.title, r.body);
      const refusal = postRefusal(findings, { visibility, ...(r.allowPersonalData ? { allowPersonalData: true } : {}) });
      return { repo, visibility, title: r.title, body: filedBody(r.body), labels: [], assignees: [], findings, ...(refusal ? { refusal } : {}) };
    },

    async file(r, by) {
      if (!r.confirmed) throw new IssueDraftRefused(400, 'confirm the issue first: nothing is filed without your confirmation');
      const repo = allowed(r.repo);
      const api = connected(repo);
      const { visibility } = await facts(repo, api);
      // The scan again, on the text as the person edited it, not only on the draft.
      const refusal = postRefusal(scanOf(r.title, r.body), { visibility, ...(r.allowPersonalData ? { allowPersonalData: true } : {}) });
      if (refusal) throw new IssueDraftRefused(422, refusal);
      if (visibility === 'public' && !r.confirmPublic) throw new IssueDraftRefused(409, `${repo} ${PUBLIC_NOTE}`);
      // No label and no assignee: a filed issue never queues a job.
      const made = await onGitHub(() => api.create(repo, { title: r.title.trim(), body: filedBody(r.body), labels: [] }));
      o.record({
        type: 'issue_draft.filed', ...(r.jobId && o.job(r.jobId) ? { jobId: r.jobId } : {}),
        data: { repo, number: made.number, url: made.url, by, provider: o.drafter.provider, skill: ISSUE_DRAFT_SKILL },
      });
      return { repo, number: made.number, url: made.url };
    },
  };
}
