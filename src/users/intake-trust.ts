// A user's intake trust (issue #652, design.md "Trusted origin and request cards"): whether a GitHub login is one of the
// user's trusted actors — Access decides, the actors named in Settings → Intake by GitHub user id (issue #930; else the
// connected login) told at each check by the login each account has now —, the text a person approved for an item, and
// a person's approval of a request card, kept as the item's snapshot, and a person's decline of one (issue #1035), kept
// as its event until GitHub took its writes (issue #1710).
// No Access (OpenFGA not set up) trusts nobody: every issue is then a request card.
import type { AccessAnswer } from '../domain/access.ts';
import { NO_INTAKE_ACCESS, type IntakeTrust } from '../domain/intake.ts';
import { APPROVED_BY_A_PERSON, textHash } from '../domain/item-snapshots.ts';
import { toldFor, trustedActors, type IntakeRequest } from '../domain/intake-origin.ts';
import { DEFAULT_INTAKE_AUTO_APPROVAL } from '../domain/intake-auto-approve.ts';
import { DEFAULT_INTAKE_DECLINE } from '../domain/intake-decline.ts';
import type { UserStore } from '../domain/store.ts';

/** Access's check of one login against the user's trusted actors; absent: OpenFGA is not set up. */
export type DecideIntakeActor = (login: string, actors: readonly string[]) => Promise<AccessAnswer>;

/** Every key this hopper assigned to the user (Sources, Assign to me; Take into Intake, issue #1176), from its own events. */
function assignedKeys(store: UserStore): Set<string> {
  const keys = store.events.between(['source.issues_assigned', 'source.issue_taken_in'], '1970-01-01T00:00:00.000Z')
    .flatMap((e) => (Array.isArray(e.data.keys) ? e.data.keys as string[] : typeof e.data.key === 'string' ? [e.data.key] : []));
  return new Set(keys);
}

/** The acts of a request, as its approval events name them. */
const actsOf = (request: IntakeRequest) => request.actors.map((a) => ({ role: a.role, ...(a.login ? { login: a.login } : {}), ...(a.app ? { app: a.app } : {}), trusted: a.trusted }));

export function storeIntakeTrust(store: UserStore, decide: DecideIntakeActor | undefined): IntakeTrust {
  return {
    async trusted(acts, connected) {
      // The connected account the source reads (issue #1448: the first, or a further one), by its login.
      const account = store.connectedAccounts.keys().map((k) => store.connectedAccounts.get(k)).find((a) => a?.account.toLowerCase() === connected.toLowerCase());
      const id = account && /^\d+$/.test(account.subject) ? Number(account.subject) : undefined;
      const actors = trustedActors(store.settings.getIntakeActors(), { login: connected, ...(id !== undefined ? { id } : {}) });
      const answers = new Map<string, AccessAnswer>();
      for (const act of acts) {
        const login = act.login.toLowerCase();
        if (!answers.has(login)) answers.set(login, decide ? await decide(login, toldFor(actors, act)) : NO_INTAKE_ACCESS);
      }
      return answers;
    },
    approvedText(key) {
      const s = store.itemSnapshots.get(key);
      return s && APPROVED_BY_A_PERSON.includes(s.reason) ? { title: s.title, body: s.body } : undefined;
    },
    approve(source, key, text, request, acting) {
      store.tx(() => {
        store.itemSnapshots.put({ key, ...text, hash: textHash(text), recordedAt: new Date().toISOString(), reason: 'approved' });
        store.events.append({
          type: 'source.request_approved',
          data: {
            source, key, hash: request.hash, author: request.author, ...acting,
            actors: actsOf(request),
          },
        });
      });
    },
    autoApproval: () => store.settings.getIntakeAutoApproval() ?? DEFAULT_INTAKE_AUTO_APPROVAL,
    autoApprove(source, key, text, request, approval) {
      store.tx(() => {
        store.itemSnapshots.put({ key, ...text, hash: textHash(text), recordedAt: new Date().toISOString(), reason: 'approved' });
        store.events.append({
          type: 'source.request_auto_approved',
          data: { source, key, hash: request.hash, author: request.author, rule: approval.rule, actor: approval.actor, actors: actsOf(request) },
        });
      });
    },
    approvedComments(key, comments) {
      const s = store.itemSnapshots.get(key);
      if (!s || s.reason !== 'approved') return;
      const text = { title: s.title, body: s.body, comments };
      store.itemSnapshots.put({ ...s, ...text, hash: textHash(text) });
    },
    declined(key, hash) {
      const mine = store.events.between(['source.request_declined', 'source.request_decline_written'], '1970-01-01T00:00:00.000Z')
        .filter((e) => e.data.key === key && e.data.hash === hash);
      const at = mine.findLastIndex((e) => e.type === 'source.request_declined');
      if (at < 0) return false;
      // A decline with a choice (issue #1710) holds until GitHub took its writes: then the issue's labels and state say it.
      return mine[at]!.data.choice === undefined || !mine.slice(at + 1).some((e) => e.type === 'source.request_decline_written');
    },
    decline(source, key, request, acting, choice) {
      store.events.append({ type: 'source.request_declined', data: { source, key, hash: request.hash, author: request.author, ...acting, ...(choice ? { choice } : {}) } });
    },
    declineDefaults: () => store.settings.getIntakeDecline() ?? DEFAULT_INTAKE_DECLINE,
    assignedHere: (key) => assignedKeys(store).has(key),
    takenIn: (key) => store.events.between(['source.issue_taken_in'], '1970-01-01T00:00:00.000Z').some((e) => e.data.key === key),
    originPending: (key) => store.jobs.getBySourceKey(key)?.originPending === true,
  };
}
