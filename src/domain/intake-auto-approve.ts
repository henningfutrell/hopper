// Auto-approval at intake (issue #1268, design.md "Auto-approval"): a request card the user's own act or setting already
// asks for is approved by the hopper, recorded as an approval (`source.request_auto_approved`, which rule, which actor),
// and taken at the next sync, so the user is not the bottleneck for work they asked for. The rules, in order:
// - `reopened`: a reopened card (issue #1126) a trusted actor, or a listed app, reopened;
// - `author`: a trusted actor wrote the issue, whoever labelled or assigned it;
// - `app`: a listed app or bot wrote it — an app acting for the user;
// - `high-label`: the issue has `hopper:high`, and a trusted actor or a listed app added it.
// A guard keeps the card waiting whatever the rules say: a job filed it, the trusted actors cannot be checked, its text
// changed since a person approved it, someone who is no trusted actor and no listed app edited its title or body, or a
// person took it into Intake (issue #1176), which asks for a request card.
// On by default; an admin turns it off, or lists the apps, in Settings → Intake. Pure.
import { isBotLogin, type OriginActor } from './intake-origin.ts';

export interface IntakeAutoApproval {
  /** The hopper approves the request cards a rule matches. */
  on: boolean;
  /** The apps and bots trusted to act for the user, by their slug, lowercased, with no `[bot]`. */
  apps: string[];
}

export const DEFAULT_INTAKE_AUTO_APPROVAL: IntakeAutoApproval = { on: true, apps: [] };

export const AUTO_APPROVE_RULES = ['reopened', 'author', 'app', 'high-label'] as const;
export type AutoApproveRule = typeof AUTO_APPROVE_RULES[number];

/** Why the hopper approved a request card: the rule that matched, and who did the act it matched on. */
export interface AutoApproval { rule: AutoApproveRule; actor: string }

/** The label that marks an issue as high priority, and, by a trusted actor, as approved (`high-label`). */
export const LABEL_HIGH = 'hopper:high';

/** What the rules read of one request card: each act, and whether a trusted actor did it (`OriginActor.trusted`). */
export interface AutoApproveFacts {
  /** Who wrote, labelled and assigned it; none for a reopened card. */
  actors: OriginActor[];
  /** Who added `hopper:high`, when the issue has it. */
  high?: OriginActor;
  /** A reopened card: who reopened the issue; absent when its events do not say. */
  reopened?: OriginActor;
  reopenedCard: boolean;
  /** Who edited its title or body, one per edit. */
  editors: OriginActor[];
  /** Its title and body are a text a person approved before: an edit before that approval does not count. */
  textApproved: boolean;
  /** Why it must wait whatever the rules say; empty: no guard holds. */
  guards: string[];
}

/** An app's slug as the list keeps it: lowercased, with no `[bot]`. */
export const appSlug = (app: string): string => app.trim().toLowerCase().replace(/\[bot\]$/, '');

/** A slug GitHub could name: letters, digits and hyphens, at most 39 of them, as the list takes it. */
export const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

const listed = (a: OriginActor, apps: readonly string[]): boolean => {
  const app = a.app ?? (a.login && isBotLogin(a.login) ? a.login : undefined);
  return app !== undefined && apps.includes(appSlug(app));
};

/** The act counts for the user: a trusted actor did it, or a listed app. */
const counts = (a: OriginActor | undefined, apps: readonly string[]): a is OriginActor => a !== undefined && (a.trusted || listed(a, apps));

const nameOf = (a: OriginActor): string => a.app ?? a.login ?? '';

/** The rule that approves the card, or undefined: it waits for a person. */
export function autoApproval(f: AutoApproveFacts, s: IntakeAutoApproval): AutoApproval | undefined {
  if (!s.on || f.guards.length > 0) return undefined;
  if (!f.textApproved && f.editors.some((e) => !counts(e, s.apps))) return undefined;
  if (f.reopenedCard) return counts(f.reopened, s.apps) ? { rule: 'reopened', actor: nameOf(f.reopened) } : undefined;
  const author = f.actors.find((a) => a.role === 'author');
  if (author?.trusted && !author.app) return { rule: 'author', actor: nameOf(author) };
  if (author && listed(author, s.apps)) return { rule: 'app', actor: nameOf(author) };
  if (counts(f.high, s.apps)) return { rule: 'high-label', actor: nameOf(f.high) };
  return undefined;
}

const RULE_TEXT: Record<AutoApproveRule, string> = {
  reopened: 'reopened by', author: 'written by', app: 'written by the trusted app', 'high-label': `labelled ${LABEL_HIGH} by`,
};

/** The reason a card the hopper approved shows until the next sync takes it. */
export const autoApprovedReason = (a: AutoApproval): string => `approved by the hopper: ${RULE_TEXT[a.rule]} ${a.actor}; taken at the next sync`;
