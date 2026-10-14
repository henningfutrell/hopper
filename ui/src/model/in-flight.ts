// In flight (issues #1113, #1164): the ledger's one count and its parts, in the words the header's badge and the
// dashboard's card both show.
import type { InFlight } from '@/model/wire';

/** The parts in words: `2 running · 1 on its own command · 2 pull requests in checks or the merge`. */
export function inFlightParts(f: InFlight): string {
  return `${f.running} running · ${f.ownCommand} on its own command · ${f.pullRequests} ${f.pullRequests === 1 ? 'pull request' : 'pull requests'} in checks or the merge`;
}
