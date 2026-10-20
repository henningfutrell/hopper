// Direct queries in the UI (issue #2184, design.md "Direct queries"), pure: the ask form's draft, why it cannot be sent
// yet, the request it sends to POST /ui/api/direct-queries with a new request id, and how a query reads back — where it
// stands and whether it can be cancelled. A direct query is a direct job with a `query`: the Direct jobs view leaves it out.
import type { Tone } from './jobs-view.ts';
import type { DirectJobView, DirectQueryState, DirectQueryView } from './wire.ts';

/** What the form keeps: every field as typed. Repositories and clusters split at commas and lines. */
export interface DirectQueryDraft { question: string; callback: string; repos: string; clusters: string }

export const emptyQueryDraft = (): DirectQueryDraft => ({ question: '', callback: '', repos: '', clusters: '' });

const REPO = /^[^/\s]+\/[^/\s]+$/;
const words = (text: string): string[] => [...new Set(text.split(/[,\n]/).map((w) => w.trim()).filter((w) => w !== ''))];

/** Why the draft cannot be sent yet; undefined: it can. The daemon checks again. */
export function queryDraftProblem(d: DirectQueryDraft): string | undefined {
  if (d.question.trim() === '') return 'Ask a question';
  if (!words(d.repos).every((r) => REPO.test(r))) return 'Give each repository as owner/name';
  return undefined;
}

/** The request an ask sends: always look only, and the callback only when given. */
export function directQueryRequest(d: DirectQueryDraft, requestId: string) {
  const callback = d.callback.trim();
  return { requestId, question: d.question.trim(), mode: 'look' as const, ...(callback ? { callback } : {}), repos: words(d.repos), clusters: words(d.clusters) };
}

/** A new request id for one ask. `crypto.getRandomValues`, not `randomUUID`: a LAN page over plain HTTP has no secure context. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ui-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const STATE: Record<DirectQueryState, { label: string; tone: Tone }> = {
  accepted: { label: 'accepted', tone: 'muted' }, running: { label: 'running', tone: 'busy' }, waiting: { label: 'waits on a question', tone: 'question' },
  answered: { label: 'answered', tone: 'ok' }, failed: { label: 'failed', tone: 'bad' }, cancelled: { label: 'cancelled', tone: 'muted' },
};

/** Where the query stands, as its badge shows it. */
export const queryStateOf = (q: DirectQueryView): { label: string; tone: Tone } => STATE[q.state];

/** Whether its job can be cancelled: it has one, and it is not at an end. */
export const canCancelQuery = (q: DirectQueryView): boolean => q.job !== undefined && (q.state === 'accepted' || q.state === 'running' || q.state === 'waiting');

/** The direct jobs that are no direct query: the Direct jobs view lists only these. */
export const onlyDirectJobs = (list: readonly DirectJobView[]): DirectJobView[] => list.filter((d) => d.query === undefined);
