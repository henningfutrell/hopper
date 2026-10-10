// Fixed answers (issue #629, design.md "Question pipeline"): before Jev and the levels, a question whose answer the
// facts fix is answered without a model. Two kinds: a permission dialog the allowed dialogs allow — an edit or a read
// of a file inside the job's work tree — is answered with its Yes option; a question a person already answered on the
// same item is answered with that person's answer. The risk rules run over either: a hit goes to the human. Nothing
// here is a model or a setting.
import { posix } from 'node:path';
import type { UserStore } from '../domain/ports.ts';
import type { Job, Question, QuestionAttempt } from '../domain/types.ts';
import type { ToHuman } from './escalation.ts';
import { riskRules } from './risk.ts';

/** The fixed answers' name on a question's trail and as `answeredBy`. */
export const FIXED = 'fixed';

/** What the question is answered with, and why. */
export interface FixedAnswer { answer: string; reason: string }

/** A permission dialog answered Yes when every file it names is inside the job's work tree: its kind and its titles. */
interface AllowedDialog { kind: 'edit' | 'read'; titles: readonly string[] }

/** The allowed dialogs. Anything else Claude asks permission for (a Bash command, a web fetch, …) goes on to Jev. */
export const ALLOWED_DIALOGS: readonly AllowedDialog[] = [
  { kind: 'edit', titles: ['Edit file', 'Create file', 'Write file', 'Overwrite file'] },
  { kind: 'read', titles: ['Read file'] },
];

/** The dialog's question: "Do you want to proceed?", or one naming the file ("… make this edit to app.ts?"). */
const DIALOG_QUESTION = /^Do you want to (?:proceed|make this edit to (\S+)|create (\S+)|overwrite (\S+))\?$/;
/** The line under the title: the path, bare or as the tool call ("Read(/abs/path)"). */
const TOOL_CALL = /^(?:Read|Edit|Write|Create|Update)\((\S+)\)$/;
const YES = /^(\d+)\.\s+Yes$/;
const WINDOWS_ROOT = /^[A-Za-z]:\//;

const trimEnd = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Whether `path` (absolute, or relative to `tree`) is `tree` or under it. A path under `~` never is. */
export function insideWorkTree(path: string, tree: string): boolean {
  if (path.startsWith('~') || tree.startsWith('~')) return false;
  const absolute = path.startsWith('/') || WINDOWS_ROOT.test(path) ? path : `${tree}/${path}`;
  const p = trimEnd(posix.normalize(absolute));
  const t = trimEnd(posix.normalize(tree));
  return p === t || p.startsWith(`${t}/`);
}

/**
 * The Yes answer to a permission dialog the allowed dialogs allow, or undefined. Only a dialog read off the screen
 * (`detectedBy: 'blocked'`), never text the agent wrote; the job must report its work tree.
 */
export function allowedDialog(q: Pick<Question, 'text' | 'detectedBy'>, workTree: string | undefined): FixedAnswer | undefined {
  if (q.detectedBy !== 'blocked' || !workTree) return undefined;
  const lines = q.text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const allowed = ALLOWED_DIALOGS.find((d) => d.titles.includes(lines[0] ?? ''));
  const asks = lines.findIndex((l) => DIALOG_QUESTION.test(l));
  if (!allowed || asks < 2) return undefined;
  const target = lines[1]!;
  const path = TOOL_CALL.exec(target)?.[1] ?? (/^\S+$/.test(target) ? target : undefined);
  if (!path || !insideWorkTree(path, workTree)) return undefined;
  const m = DIALOG_QUESTION.exec(lines[asks]!)!;
  const named = m[1] ?? m[2] ?? m[3];
  if (named !== undefined && named !== posix.basename(path)) return undefined;
  const yes = lines.slice(asks + 1).map((l) => YES.exec(l)?.[1]).find((n) => n !== undefined);
  if (yes === undefined) return undefined;
  return { answer: yes, reason: `allowed dialog: ${allowed.kind} inside the job work tree (${path})` };
}

/** A question's text as compared for reuse: case and spacing aside, a dialog's countdown ("in 1:59") aside. */
export function normalizedQuestion(text: string): string {
  return text.toLowerCase().replace(/\b\d+:\d{2}\b/g, '#').replace(/\s+/g, ' ').trim();
}

/** The most jobs of one item looked at, newest first: the job and the jobs it runs again. */
const MAX_ITEM_JOBS = 20;

/** The jobs of `job`'s item: the job, then each job it runs again (`rerunOf`), newest first. */
function itemJobs(store: Pick<UserStore, 'jobs'>, job: Job): Job[] {
  const out: Job[] = [];
  for (let j: Job | undefined = job; j && out.length < MAX_ITEM_JOBS && !out.some((x) => x.id === j!.id); j = j.rerunOf ? store.jobs.get(j.rerunOf) : undefined) out.push(j);
  return out;
}

/** The answer a person gave to the same question on the same item, the newest, or undefined. */
export function reusedAnswer(store: Pick<UserStore, 'jobs' | 'questions'>, q: Question, job: Job, human: string): FixedAnswer | undefined {
  const text = normalizedQuestion(q.text);
  for (const j of itemJobs(store, job)) {
    const prior = store.questions.list({ jobId: j.id, status: ['answered'] })
      .filter((p) => p.id !== q.id && p.answeredBy === human && p.answer !== undefined && normalizedQuestion(p.text) === text)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (prior) return { answer: prior.answer!, reason: `reused answer: a person answered the same question (${prior.id})` };
  }
  return undefined;
}

/** The fixed answer to `q`, or undefined: an allowed dialog first, then a reused answer. */
export function fixedAnswer(store: Pick<UserStore, 'jobs' | 'questions'>, q: Question, human: string): FixedAnswer | undefined {
  const job = store.jobs.get(q.jobId);
  if (!job) return undefined;
  return allowedDialog(q, job.workTree) ?? reusedAnswer(store, q, job, human);
}

export interface FixedAnswerDeps {
  store: UserStore;
  iso(): string;
  /** The human stage's name: only its answers are reused. */
  human: string;
  /** Inside the tx: send the question to the human, with the reason and why for the person (issue #679); a risk rule keeps it (issue #650). */
  toHuman(q: Question, reason: string, to: ToHuman): void;
  /** Inside the tx that answered it: announce the answer and resume the job. */
  answered(q: Question): void;
}

/** Answer an open question with its fixed answer. True when nothing is left for Jev and the levels. */
export function answerFixed(d: FixedAnswerDeps, id: string): boolean {
  const { store } = d;
  return store.tx((): boolean => {
    const q = store.questions.get(id);
    if (!q || q.status !== 'open') return true;
    const fixed = fixedAnswer(store, q, d.human);
    if (!fixed) return false;
    const at = d.iso();
    const hits = riskRules(`${q.text}\n${fixed.answer}`);
    const attempt: QuestionAttempt = { tier: FIXED, role: 'fixed', startedAt: at, finishedAt: at, answer: fixed.answer, reason: fixed.reason, riskRules: hits, outcome: 'escalated' };
    if (hits.length > 0) {
      store.questions.addAttempt(id, attempt);
      d.toHuman(q, `risk rules: ${hits.join(', ')}`, { reason: 'guard', guards: hits, kept: 'risk' });
      return true;
    }
    store.questions.addAttempt(id, { ...attempt, outcome: 'accepted' });
    d.answered(store.questions.update(id, { status: 'answered', answer: fixed.answer, answeredBy: FIXED }));
    return true;
  });
}
