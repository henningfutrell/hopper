// The engine's passes on one host (issues #1627, #1662, design.md "Several hoppers on one database"): each pass over every
// job or machine of the user, on a timer or a tick, runs only on the host that holds its sweep lease. On one host alone
// every lease is held. A host that takes a lease another host held runs the pass's catch-up, when it has one (`taken`).
import { soleLease, type SweepLease } from '../domain/leases.ts';

/** Each pass and the name of its lease (the user's own: the runtime prefixes the user's id). */
export const PASS_LEASES = {
  /** The machine sweep (issue #410); its catch-up sweeps every machine. */
  sweep: 'engine-sweep',
  /** The cleanups a record says are due (issue #1570), done at the start and again by a host that takes the lease. */
  cleanups: 'cleanups',
  /** Auto-park (issue #650). */
  autoPark: 'auto-park',
  /** The signed-out move (issue #1211). */
  signedOutMove: 'signed-out-move',
  /** The busy-machine move (issue #1977). */
  busyMove: 'busy-move',
  /** The checkpoint pass (issue #921); a park's or a missed heartbeat's checkpoint is the run's own, on its host. */
  checkpoints: 'checkpoints',
  /** The read of each waiting job's pane: an answer typed there, its own command, its pane lost (issues #376, #1037, #1508). */
  paneAnswers: 'pane-answers',
  /** The router's advice for each queued job not advised yet; a job queued here is still advised here at once. */
  classifier: 'classifier',
  /** Each machine's discovery (issue #542). */
  discovery: 'discovery',
  /** The delivery ledger pass (issue #2554 part 6). */
  deliveryLedger: 'delivery-ledger',
  /** The kept-track pass (issue #2775). */
  keptTracks: 'kept-tracks',
  /** The grade pass (issue #2845). */
  grades: 'grades',
  /** The completion review pass (issue #2846). */
  completionReviews: 'completion-reviews',
  /** The wakes a stop lost (issue #1571). */
  missedWakes: 'missed-wakes',
} as const;

export type Pass = keyof typeof PASS_LEASES;

export interface PassLeases {
  /** Takes or renews the pass's lease: whether this host runs the pass now, and whether it took the lease just now. */
  hold(pass: Pass): { held: boolean; taken: boolean };
  /** Whether this host runs the pass now. */
  held(pass: Pass): boolean;
}

export function createPassLeases(lease?: (name: string) => SweepLease): PassLeases {
  const leases = new Map(Object.entries(PASS_LEASES).map(([pass, name]) => [pass as Pass, lease ? lease(name) : soleLease()]));
  const hold = (pass: Pass): { held: boolean; taken: boolean } => leases.get(pass)!.hold();
  return { hold, held: (pass) => hold(pass).held };
}
