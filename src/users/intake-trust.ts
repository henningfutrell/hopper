// A user's intake trust (issue #652, design.md "Trusted origin and request cards"): whether a GitHub login is one of the
// user's trusted actors — Access decides, the actors named in Settings → Intake (else the connected login) told at each
// check —, the text a person approved for an item, and a person's approval of a request card, kept as the item's snapshot.
// No Access (OpenFGA not set up) trusts nobody: every issue is then a request card.
import type { AccessAnswer } from '../domain/access.ts';
import { NO_INTAKE_ACCESS, type IntakeTrust } from '../domain/intake.ts';
import { APPROVED_BY_A_PERSON, textHash } from '../domain/item-snapshots.ts';
import { trustedActors } from '../domain/intake-origin.ts';
import type { UserStore } from '../domain/store.ts';

/** Access's check of one login against the user's trusted actors; absent: OpenFGA is not set up. */
export type DecideIntakeActor = (login: string, actors: readonly string[]) => Promise<AccessAnswer>;

/** Every key this hopper assigned to the user (Sources, Assign to me), from its own events. */
function assignedKeys(store: UserStore): Set<string> {
  const keys = store.events.between(['source.issues_assigned'], '1970-01-01T00:00:00.000Z').flatMap((e) => (Array.isArray(e.data.keys) ? e.data.keys as string[] : []));
  return new Set(keys);
}

export function storeIntakeTrust(store: UserStore, decide: DecideIntakeActor | undefined): IntakeTrust {
  return {
    async trusted(logins, connected) {
      const actors = trustedActors(store.settings.getIntakeActors(), connected);
      const answers = new Map<string, AccessAnswer>();
      for (const login of new Set(logins.map((l) => l.toLowerCase()))) answers.set(login, decide ? await decide(login, actors) : NO_INTAKE_ACCESS);
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
            actors: request.actors.map((a) => ({ role: a.role, ...(a.login ? { login: a.login } : {}), ...(a.app ? { app: a.app } : {}), trusted: a.trusted })),
          },
        });
      });
    },
    assignedHere: (key) => assignedKeys(store).has(key),
  };
}
