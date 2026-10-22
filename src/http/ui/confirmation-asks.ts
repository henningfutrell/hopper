// A person confirms what an agent asks (issue #909, design.md "A person confirms what an agent asks"): an API token's
// approval of a high-risk plan or a write profile is not done; it is a confirmation ask, kept as an event — which the
// notifiers and webhook subscriptions that take it send on —, at most once an hour for an item, and shown on the item
// while it waits. A person approves the item in the UI: that is the confirmation.
import type { FastifyReply } from 'fastify';
import { askedRecently, ASK_QUIET_MINUTES, ASK_SHOWN_HOURS, latestAsks, waitingWords, type AskedBy, type ConfirmationAsk, type ConfirmationKind } from '../../domain/confirmation-asks.ts';
import type { UserStore } from '../../domain/ports.ts';

const ASKED = 'approval.confirmation_asked';
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** Whether the request is an API token's: an agent's, whose approval of such an item a person confirms. */
export const byApiToken = (s: { kind?: string }): boolean => s.kind === 'api';

/** Who asks: the API token's label (its grant's), or none. */
export const askerOf = (s: { label?: string }): string => s.label ?? 'an API token';

/** Asks a person, unless the item was asked for within the quiet time; answers 202 with what waits. */
export function askPerson(store: Pick<UserStore, 'events'>, reply: FastifyReply, ask: ConfirmationAsk, jobId?: string): { waiting: string } {
  const last = latestAsks(store.events.between([ASKED], ago(ASK_QUIET_MINUTES * 60_000)), ask.kind).get(ask.ref);
  if (!askedRecently(last, new Date())) store.events.append({ type: ASKED, ...(jobId !== undefined ? { jobId } : {}), data: ask });
  reply.code(202);
  return { waiting: waitingWords(ask) };
}

/** The latest ask of each item of `kind` shown now, by its ref. */
export const shownAsks = (store: Pick<UserStore, 'events'>, kind: ConfirmationKind): Map<string, AskedBy> =>
  latestAsks(store.events.between([ASKED], ago(ASK_SHOWN_HOURS * 3_600_000)), kind);

/** As `shownAsks`, read off the event loop (issue #2392). */
export const shownAsksRead = async (store: Pick<UserStore, 'reads'>, kind: ConfirmationKind): Promise<Map<string, AskedBy>> =>
  latestAsks(await store.reads.eventsBetween([ASKED], ago(ASK_SHOWN_HOURS * 3_600_000)), kind);
