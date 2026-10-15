// Conditional reads of a repository's checks (issue #1250, design.md "Repositories with no checks"): each GET is sent with
// the ETag of the answer kept for it (`If-None-Match`), and GitHub's 304 — which costs no call — is answered with what was
// kept. An answer is kept by its route and parameters, never its token, so a renewed token and a restart keep it: the
// store keeps the set with the read (`RepoChecksRead.etags`). The shared rate limiter keeps its own ETags in memory too;
// when it answers a 304 from its own cache, the answer comes back as a 200 with the same ETag and is kept here the same way.
// A 404 or 403 has no ETag (a release branch the repository does not have, branch protection only an admin sees): it is
// kept as refused, and answered again with no call while the `anchor` answer — the repository itself, asked first — is
// unchanged. A new branch or a new permission changes the repository's answer, and then each refusal is asked again.
import type { KeptAnswer } from '../domain/repo-checks.ts';
import { statusOf } from '../sources/github/http/http.ts';

/** The part of `@octokit/request` a conditional read uses. */
export type Get = (route: string, params: Record<string, unknown>) => Promise<{ data: unknown; headers: Record<string, unknown> }>;

export interface ConditionalAnswers {
  /** GET `route`: what GitHub answers, or what was kept when it answers 304. Any other refusal throws. */
  get<T>(req: Get, route: string, params: Record<string, unknown>): Promise<T>;
  keep(key: string, answer: KeptAnswer): void;
  /** The answers of this read: an answer not asked again is dropped. */
  kept(): Record<string, KeptAnswer>;
}

/** A refusal kept from a read before, answered again with no call. */
class KeptRefusal extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub answered ${status} (kept from the read before)`);
    this.status = status;
  }
}

const KEPT_REFUSALS = [403, 404];

const keyOf = (route: string, params: Record<string, unknown>): string => {
  const { headers: _headers, ...rest } = params;
  return `${route} ${JSON.stringify(rest)}`;
};

export function conditionalAnswers(before: Record<string, KeptAnswer> = {}, anchor?: string): ConditionalAnswers {
  const next: Record<string, KeptAnswer> = {};
  const keep = (key: string, answer: KeptAnswer) => { next[key] = answer; };
  let unchanged = false;
  return {
    keep,
    kept: () => ({ ...next }),
    async get<T>(req: Get, route: string, params: Record<string, unknown>): Promise<T> {
      const key = keyOf(route, params);
      const was = before[key];
      if (was?.refused !== undefined && unchanged) { keep(key, was); throw new KeptRefusal(was.refused); }
      const etag = was?.refused === undefined ? was?.etag : undefined;
      const headers = { ...(params.headers as Record<string, unknown> | undefined), ...(etag ? { 'if-none-match': etag } : {}) };
      try {
        const r = await req(route, { ...params, headers });
        if (typeof r.headers.etag === 'string') keep(key, { etag: r.headers.etag, data: r.data });
        if (route === anchor) unchanged = etag !== undefined && r.headers.etag === etag;
        return r.data as T;
      } catch (err) {
        const status = statusOf(err);
        if (status === 304 && was && etag) {
          keep(key, was);
          if (route === anchor) unchanged = true;
          return was.data as T;
        }
        if (KEPT_REFUSALS.includes(status ?? 0)) keep(key, { etag: '', data: null, refused: status! });
        throw err;
      }
    },
  };
}
