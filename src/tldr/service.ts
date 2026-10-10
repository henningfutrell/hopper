// The TL;DR writer (issue #569, design.md "TL;DR"): a sweep over the open cards — questions, proposals, research
// reports, hand-offs — asks the model for the TL;DR of each long one that has none for its text as it is now, one at a
// time, and stores it with the card (`tldr.written`). A card is never waited on: the TL;DR comes when it comes, and a
// card without one shows the agent's own summary. A text the model failed on is not asked again for the same text.
// With the setting off, nothing is asked.
import type { Clock, UserStore } from '../domain/ports.ts';
import { DEFAULT_TLDR, REVIEW_KINDS, REVIEW_OPEN_STATUSES, type Handoff, type Question, type ReviewItem, type TldrKind, type TldrSettings, type TldrWriter } from '../domain/types.ts';
import { hashOf, isLong, tldrOrSummary, plainText, sourceOf, tldrPrompt } from './text.ts';

export interface TldrsOptions {
  store: UserStore;
  clock: Clock;
  writer: TldrWriter;
  logger: { warn(line: string): void };
  /** How often the sweep runs. */
  sweepMs: number;
  /** Ceiling on one TL;DR; past it, none. */
  timeoutMs: number;
}

export interface Tldrs {
  /** Start the sweep. Once. */
  start(): void;
  stop(): Promise<void>;
  /** One pass now (tests, and the setting turned on). */
  sweep(): Promise<void>;
  /** What a notification of the card leads with now: its TL;DR, else the agent's own summary; undefined: none. */
  tldrOrSummary(kind: TldrKind, card: Question | ReviewItem | Handoff): string | undefined;
}

/** The TL;DR setting now: absent, on. */
export const tldrSettings = (store: Pick<UserStore, 'settings'>): TldrSettings => store.settings.getTldr() ?? DEFAULT_TLDR;

/** An escalation event's `tldr` (issue #569): what a notification of the card leads with now; none for a short text or with the setting off. */
export function tldrData(store: Pick<UserStore, 'settings'>, kind: TldrKind, card: Question | ReviewItem | Handoff): { tldr?: string } {
  const tldr = tldrOrSummary(kind, card, tldrSettings(store));
  return tldr ? { tldr } : {};
}

type Card = { kind: TldrKind; card: Question | ReviewItem | Handoff };

/** Texts the model was asked about and failed on, kept so a sweep does not ask again; the oldest go past this many. */
const FAILED_MAX = 1000;

export function createTldrs(o: TldrsOptions): Tldrs {
  const { store } = o;
  const failed = new Set<string>();
  const abort = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;

  const openCards = (): Card[] => [
    ...store.questions.list({ status: ['open'], order: 'oldest-first' }).map((card) => ({ kind: 'question' as const, card })),
    ...REVIEW_KINDS.flatMap((kind) => store.reviews[kind].list({ status: [...REVIEW_OPEN_STATUSES], order: 'oldest-first' }).map((card) => ({ kind, card }))),
    ...store.handoffs.list({ status: 'open' }).map((card) => ({ kind: 'handoff' as const, card })),
  ];
  const reread = (c: Card): Question | ReviewItem | Handoff | undefined =>
    c.kind === 'question' ? store.questions.get(c.card.id) : c.kind === 'handoff' ? store.handoffs.get(c.card.id) : store.reviews[c.kind].get(c.card.id);
  const save = (c: Card, tldr: NonNullable<Question['tldr']>) => {
    if (c.kind === 'question') store.questions.update(c.card.id, { tldr });
    else if (c.kind === 'handoff') store.handoffs.update(c.card.id, { tldr });
    else store.reviews[c.kind].update(c.card.id, { tldr });
  };

  async function write(c: Card, source: string, of: string): Promise<void> {
    const key = `${c.kind}:${c.card.id}:${of}`;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(o.timeoutMs)]);
    const r = await o.writer(tldrPrompt(c.kind, source), signal).catch((e: unknown) => ({ error: (e as Error).message }));
    const text = 'error' in r ? '' : plainText(r.text);
    if (!text) {
      if (failed.size >= FAILED_MAX) failed.delete(failed.values().next().value!);
      failed.add(key);
      o.logger.warn(`hopper: no TL;DR for ${c.kind} ${c.card.id}: ${'error' in r ? r.error : 'the model answered nothing'}`);
      return;
    }
    store.tx(() => {
      const now = reread(c);
      // Changed, or gone, while the model wrote: the next sweep writes it for the text as it is now.
      if (!now || hashOf(sourceOf(c.kind, now)) !== of) return;
      const model = 'error' in r ? undefined : r.model;
      save(c, { text, of, ...(model ? { model } : {}), at: o.clock.now().toISOString() });
      store.events.append({ type: 'tldr.written', jobId: now.jobId, data: { kind: c.kind, id: now.id, text, ...(model ? { model } : {}) } });
    });
  }

  async function pass(): Promise<void> {
    for (const c of openCards()) {
      if (abort.signal.aborted || !tldrSettings(store).enabled) return;
      const source = sourceOf(c.kind, c.card);
      if (!isLong(source)) continue;
      const of = hashOf(source);
      if (c.card.tldr?.of === of || failed.has(`${c.kind}:${c.card.id}:${of}`)) continue;
      await write(c, source, of);
    }
  }

  const sweep = (): Promise<void> => {
    sweeping ??= pass().catch((e: unknown) => o.logger.warn(`hopper: TL;DR sweep failed: ${(e as Error).message}`)).finally(() => { sweeping = undefined; });
    return sweeping;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void sweep(); }, o.sweepMs);
      void sweep();
    },
    async stop() {
      if (timer) clearInterval(timer);
      abort.abort();
      await sweeping;
    },
    sweep,
    tldrOrSummary: (kind, card) => tldrOrSummary(kind, card, tldrSettings(store)),
  };
}
