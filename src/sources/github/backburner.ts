// Since when, and by whom, each issue is on the backburner (issue #808): the newest `labeled` event of `hopper:backburner`.
// Read once per issue while the label stays, so a sync reads only the issues new to the backburner; an issue taken off
// it is forgotten, so putting it back reads it again. Events that cannot be read leave it without, and are read next sync.
import type { BackburnerSince, IntakeOutcome } from '../../domain/intake.ts';
import type { GitHubApi } from './api.ts';
import { LABEL_BACKBURNER } from './labels.ts';

export type BackburnerReader = (outcomes: IntakeOutcome[]) => Promise<IntakeOutcome[]>;

async function sinceOf(api: GitHubApi, x: IntakeOutcome): Promise<BackburnerSince | undefined> {
  const number = Number(/\/issues\/(\d+)$/.exec(x.key)?.[1]);
  if (!x.repo || !Number.isInteger(number)) return {};
  try {
    const labelled = (await api.issueEvents(x.repo, number))
      .filter((e) => e.event === 'labeled' && e.label === LABEL_BACKBURNER).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    return labelled ? { since: labelled.at, ...(labelled.actor ? { by: labelled.actor } : {}) } : {};
  } catch (err) {
    console.warn(`hopper: the events of ${x.key} could not be read: ${(err as Error).message}`);
    return undefined;
  }
}

/** A reader that keeps what it read across syncs, for one source. */
export function backburnerReader(api: GitHubApi): BackburnerReader {
  const known = new Map<string, BackburnerSince>();
  return async (outcomes) => {
    const on = outcomes.filter((x) => x.group === 'backburner');
    const keys = new Set(on.map((x) => x.key));
    for (const key of [...known.keys()]) if (!keys.has(key)) known.delete(key);
    for (const x of on) {
      if (known.has(x.key)) continue;
      const since = await sinceOf(api, x);
      if (since) known.set(x.key, since);
    }
    return outcomes.map((x) => { const b = known.get(x.key); return b ? { ...x, backburner: { ...b } } : x; });
  };
}
