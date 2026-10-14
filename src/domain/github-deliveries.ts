// GitHub deliveries (issue #1079, design.md "GitHub deliveries"): what GitHub sends the hopper over a webhook, and what
// Settings → GitHub webhook shows of them. Pure: what a delivery names, read from its event and payload.

/** Where GitHub (or a relay in front of the hopper) sends its deliveries. */
export const DELIVERY_PATH = '/github/webhook';

/** The events the hopper takes: an issue opened, edited, labelled, assigned, closed or reopened. */
export const DELIVERY_EVENTS = ['issues'] as const;

/** The `issues` actions that can change what intake takes. */
export const ISSUE_ACTIONS = ['opened', 'edited', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'closed', 'reopened'] as const;

/**
 * What a delivery names: the repository (`owner/name`), its issue, and the action. A close or a reopen also names the
 * issue's URL — a work item's source key — and, closed, why (issue #1067, part 3).
 */
export interface DeliveryTarget { repo: string; number?: number; action: string; issue?: { url: string; reason?: string } }

/** The repository and issue an `issues` delivery names; undefined for any other event, an action intake does not read, or a payload with no repository. */
export function deliveryTarget(event: string, payload: unknown): DeliveryTarget | undefined {
  if (!(DELIVERY_EVENTS as readonly string[]).includes(event) || typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as { action?: unknown; issue?: { number?: unknown; html_url?: unknown; state_reason?: unknown }; repository?: { full_name?: unknown } };
  const repo = p.repository?.full_name;
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return undefined;
  if (typeof p.action !== 'string' || !(ISSUE_ACTIONS as readonly string[]).includes(p.action)) return undefined;
  const number = p.issue?.number;
  const url = p.issue?.html_url;
  const reason = p.issue?.state_reason;
  const issue = (p.action === 'closed' || p.action === 'reopened') && typeof url === 'string' && /^https?:\/\/\S+$/.test(url)
    ? { url, ...(p.action === 'closed' && typeof reason === 'string' && reason ? { reason: reason.toLowerCase() } : {}) }
    : undefined;
  return { repo, action: p.action, ...(typeof number === 'number' && Number.isInteger(number) && number > 0 ? { number } : {}), ...(issue ? { issue } : {}) };
}

/** The GitHub webhook secret's metadata: never its value. */
export interface DeliverySecretView { set: boolean; setBy?: string; setAt?: string; last4?: string }

/** Settings → GitHub webhook: where to send, what to send, the secret's metadata, and what came in since the start. */
export interface GitHubDeliveriesView {
  path: string;
  events: string[];
  secret: DeliverySecretView;
  /** Why no secret can be kept now (no master key); absent when one can. */
  problem?: string;
  /** Deliveries taken since the start: an `issues` delivery whose signature held. */
  received: number;
  /** Deliveries refused: no secret could be read, no signature, or a wrong one. */
  refused: number;
  /** Deliveries whose signature held of an event or action the hopper does not read (`ping` among them). */
  ignored: number;
  /** The last delivery taken. */
  last?: { at: string; delivery: string; event: string; action: string; repo: string };
  /** The last delivery refused, and why. */
  lastRefused?: { at: string; why: string };
}
