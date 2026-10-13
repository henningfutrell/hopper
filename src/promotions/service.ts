// Promote to GitHub (issue #946, design.md "Promote to GitHub"): one user's promotions of their direct jobs. `preview`
// answers what would be posted — the brief and the results cleaned, the routing labels, the job's artifacts as links,
// the repository's visibility, what the scan found — and changes nothing. `promote` posts what the person confirmed,
// with their own GitHub connection: a new issue, or a comment on the issue they picked; made again, it edits what the
// live promotion posted instead of posting twice. A secret is never posted; personal data only on a private repository,
// when the person allows it; a public repository only when they confirm it. `revoke` ends the link in the hopper and
// leaves GitHub as it is. Each is an event of the user's, never with the text. Part 2: a small text artifact the person
// ticks is scanned as the text is, then committed to the promotion's own branch (`hopper-promotion/<id>`, made from the
// default branch, never the default branch itself) and linked there, so it opens with no hopper sign-in.
import { directKey, type DirectJob } from '../domain/direct-jobs.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import {
  carriedLabels, commitMessage, commitRefusal, promotionBranch, promotionPath, promotionDraftBody, promotionFooter, promotionText, resultSummary, REVOKE_NOTE,
  type CommittedFile, type DraftArtifact, type Promotion, type PromotionDraft, type PromotionRepository, type PromotionRequest, type PromotionTarget, type RepoVisibility,
} from '../domain/promotions.ts';
import type { Artifact, Job, NewEvent } from '../domain/types.ts';
import { PromotionGitHubError, type PromotionGitHub } from './github.ts';
import { cleanText, postRefusal, scanText } from './scan.ts';

/** Why a promotion was not made: `status` as the HTTP edge answers it. */
export class PromotionRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PromotionRefused';
    this.status = status;
  }
}

export interface PromotionsOptions {
  /** The person's own GitHub connection and its login, or why there is none. */
  github(): { api: PromotionGitHub; login: string } | { problem: string };
  directJob(id: string): DirectJob | undefined;
  /** The direct job's newest job. */
  job(directJobId: string): Job | undefined;
  /** The job's artifacts, newest first. */
  artifacts(jobId: string): Artifact[];
  /** An artifact's content, its latest revision: what is committed. */
  content(artifactId: string): Buffer | undefined;
  artifactUrl(id: string): string;
  promotions: PromotionRepository;
  /** The hopper's public URL: the posted links are made only on it. */
  publicUrl(): string | undefined;
  record(event: NewEvent): void;
  now(): string;
}

export interface PreviewRequest { repo?: string; target?: PromotionTarget; includeRequester?: boolean }

export interface Promotions {
  preview(directJobId: string, r: PreviewRequest): Promise<PromotionDraft>;
  promote(directJobId: string, r: PromotionRequest, by: string): Promise<Promotion>;
  revoke(directJobId: string, by: string): { revoked: true; note: string };
}

const ENDED = new Set(['finished', 'failed']);
const sameTarget = (p: Promotion, repo: string, t: PromotionTarget): boolean =>
  p.repo === repo && p.kind === t.kind && (t.kind === 'issue' || p.number === t.number);
const where = (p: Promotion): string => (p.kind === 'issue' ? `${p.repo}#${p.number}` : `a comment on ${p.repo}#${p.number}`);

/** GitHub's failure as a refusal: 502. */
const github = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof PromotionGitHubError) throw new PromotionRefused(502, e.message);
    throw e;
  }
};

export function createPromotions(o: PromotionsOptions): Promotions {
  /** The direct job, its job ended, the person's GitHub, and the repository's facts: what both preview and promote need. */
  const ready = async (id: string, repo: string | undefined) => {
    const d = o.directJob(id);
    if (!d) throw new PromotionRefused(404, `direct job ${id} not found`);
    const job = o.job(id);
    if (!job || !ENDED.has(job.status)) throw new PromotionRefused(409, `direct job ${id} has not ended: promote it once its job finished`);
    const live = o.promotions.live(id);
    const name = repo ?? live?.repo ?? d.repo;
    if (!name) throw new PromotionRefused(400, 'name the repository to promote it to (owner/name)');
    const gh = o.github();
    if ('problem' in gh) throw new PromotionRefused(409, gh.problem);
    const facts = await github(() => gh.api.repo(name));
    if (!facts.hasIssues) throw new PromotionRefused(409, `${name} takes no issues: pick another repository`);
    return { d, job, live, repo: name, gh, visibility: facts.visibility, defaultBranch: facts.defaultBranch };
  };
  const offered = (d: DirectJob, job: Job): DraftArtifact[] => o.artifacts(job.id).map((a) => {
    const no = commitRefusal(a);
    return {
      id: a.id, title: a.title, revision: a.revision, kind: a.kind, url: o.artifactUrl(a.id), ...(a.summary ? { summary: a.summary } : {}),
      commit: no ? { no } : { branch: promotionBranch(d.id), path: promotionPath(d.id, a) },
    };
  });
  const notes = (visibility: RepoVisibility): string[] => [
    ...(visibility === 'public' ? ['The repository is public: anybody can read what is posted. Confirm it to post there.'] : []),
    o.publicUrl() ? 'Artifacts are linked, never attached: opening one needs a hopper sign-in.' : 'The hopper has no public URL: artifacts and the direct job are named by id, with no link.',
    'A small text artifact you tick is committed to the branch hopper-promotion/<direct job>, never the default branch, and linked there: it opens with no hopper sign-in. A revoke leaves the branch.',
    'Left out: the logs, credentials, the authorizations and the audit trail. Check the text for customer data before you confirm.',
    REVOKE_NOTE,
  ];

  return {
    async preview(id, r) {
      const { d, job, live, repo, gh, visibility } = await ready(id, r.repo);
      const target: PromotionTarget = live ? (live.kind === 'issue' ? { kind: 'issue' } : { kind: 'comment', number: live.number }) : r.target ?? { kind: 'issue' };
      const artifacts = offered(d, job);
      const title = cleanText(d.title);
      const body = promotionDraftBody(cleanText(d.brief), (() => { const s = resultSummary(job.result); return s === undefined ? undefined : cleanText(s); })());
      const footer = promotionFooter({ artifacts, directJobId: d.id, ...(o.publicUrl() ? { publicUrl: o.publicUrl()! } : {}), promotedBy: gh.login, ...(r.includeRequester ? { requester: d.submittedBy.person } : {}) });
      return {
        repo, visibility, target, title, body, labels: carriedLabels(d.labels), artifacts, includeRequester: r.includeRequester === true, footer,
        ...(live ? { update: { kind: live.kind, number: live.number, url: live.url } } : {}),
        findings: scanText(`${title}\n${body}\n${footer}`), notes: notes(visibility),
      };
    },

    async promote(id, r, by) {
      const { d, job, live, repo, gh, visibility, defaultBranch } = await ready(id, r.repo);
      if (live && !sameTarget(live, repo, r.target)) throw new PromotionRefused(409, `direct job ${id} is promoted to ${where(live)}: promote it there again to update it, or revoke it first`);
      const own = o.artifacts(job.id);
      const picked = r.artifacts.map((a) => own.find((x) => x.id === a) ?? (() => { throw new PromotionRefused(400, `artifact ${a} is not of this direct job's job`); })());
      const labels = carriedLabels(r.labels);
      const allow = { visibility, ...(r.allowPersonalData ? { allowPersonalData: true } : {}) };
      const commits = (r.commit ?? []).map((cid) => {
        const a = picked.find((x) => x.id === cid);
        if (!a) throw new PromotionRefused(400, `artifact ${cid} is not linked: link an artifact to commit it`);
        const no = commitRefusal(a);
        if (no) throw new PromotionRefused(400, `${a.name}: ${no}`);
        const content = o.content(a.id);
        if (!content) throw new PromotionRefused(409, `${a.name} has no content to commit`);
        const why = postRefusal(scanText(`${a.name}\n${content.toString('utf8')}`), allow);
        if (why) throw new PromotionRefused(422, `${a.name}, to commit: ${why}`);
        return { a, content, file: { branch: promotionBranch(d.id), path: promotionPath(d.id, a) } as CommittedFile };
      });
      const textWith = (committed: ReadonlyMap<string, CommittedFile>): string => promotionText({
        body: r.body, directJobId: d.id, promotedBy: gh.login, ...(o.publicUrl() ? { publicUrl: o.publicUrl()! } : {}),
        ...(r.includeRequester ? { requester: d.submittedBy.person } : {}),
        artifacts: picked.map((a) => ({ id: a.id, title: a.title, revision: a.revision, ...(a.summary ? { summary: a.summary } : {}), ...(committed.has(a.id) ? { committed: committed.get(a.id)! } : {}) })),
      });
      const refusal = postRefusal(scanText(`${r.title}\n${textWith(new Map(commits.map((c) => [c.a.id, c.file])))}`), allow);
      if (refusal) throw new PromotionRefused(422, refusal);
      if (visibility === 'public' && !r.confirmPublic) throw new PromotionRefused(409, `${repo} is public: anybody can read what is posted. Confirm it to post there`);

      const committed = new Map<string, CommittedFile>();
      if (commits.length > 0) {
        await github(async () => {
          await gh.api.branch(repo, promotionBranch(d.id), defaultBranch);
          for (const c of commits) {
            const put = await gh.api.putFile(repo, { ...c.file, message: commitMessage(c.a), content: c.content });
            committed.set(c.a.id, { ...c.file, url: put.url });
          }
        });
      }
      const text = textWith(committed);

      const posted = await github(async (): Promise<Pick<Promotion, 'kind' | 'number' | 'url' | 'commentId'>> => {
        if (live?.kind === 'comment' && live.commentId !== undefined) return { kind: 'comment', number: live.number, commentId: live.commentId, url: (await gh.api.editComment(repo, live.commentId, text)).url };
        if (live?.kind === 'issue') {
          const e = await gh.api.edit(repo, live.number, { title: r.title, body: text });
          if (labels.length > 0) await gh.api.addLabels(repo, live.number, labels);
          return { kind: 'issue', number: e.number, url: e.url };
        }
        if (r.target.kind === 'comment') {
          const n = r.target.number;
          await gh.api.issue(repo, n).catch((e: unknown) => {
            if (e instanceof PromotionGitHubError && e.status === 404) throw new PromotionRefused(409, `${repo} has no issue #${n}: pick an issue that is there`);
            throw e;
          });
          const c = await gh.api.comment(repo, n, text);
          return { kind: 'comment', number: n, commentId: c.id, url: c.url };
        }
        const c = await gh.api.create(repo, { title: r.title, body: text, labels });
        return { kind: 'issue', number: c.number, url: c.url };
      });
      const at = o.now();
      const artifacts = picked.map((a) => ({ id: a.id, title: a.title, revision: a.revision, ...(committed.has(a.id) ? { committed: committed.get(a.id)! } : {}) }));
      const p = live
        ? (() => { const next = { ...live, ...posted, artifacts, updatedAt: at }; o.promotions.update(next); return next; })()
        : o.promotions.add({ directJobId: d.id, repo, ...posted, artifacts, promotedBy: by, promotedAt: at, updatedAt: at });
      o.record({ type: 'direct_job.promoted', jobId: job.id, data: { id: d.id, repo, kind: p.kind, number: p.number, url: p.url, by, artifacts: artifacts.length, update: live !== undefined } });
      return p;
    },

    revoke(id, by) {
      const live = o.promotions.live(id);
      if (!live) throw new PromotionRefused(404, `direct job ${id} has no live promotion`);
      o.promotions.update({ ...live, revokedAt: o.now(), revokedBy: by });
      o.record({ type: 'direct_job.promotion_revoked', data: { id, repo: live.repo, kind: live.kind, number: live.number, by } });
      return { revoked: true, note: REVOKE_NOTE };
    },
  };
}

/**
 * One user's promotions over their store (the user runtime composes it): links only on `publicUrl` — the hopper's public
 * URL, or the remote access URL while it is on.
 */
export const userPromotions = (o: { store: UserStore; clock: Clock; github: PromotionsOptions['github']; artifactUrl(id: string): string; publicUrl(): string | undefined }): Promotions => createPromotions({
  github: o.github, directJob: (id) => o.store.directJobs.get(id), job: (id) => o.store.jobs.getBySourceKey(directKey(id)),
  artifacts: (jobId) => o.store.artifacts.list({ jobId }), content: (id) => o.store.artifacts.content(id), artifactUrl: o.artifactUrl, promotions: o.store.promotions, publicUrl: o.publicUrl,
  record: (e) => { o.store.events.append(e); }, now: () => o.clock.now().toISOString(),
});
