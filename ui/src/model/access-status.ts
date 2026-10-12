// Access checks unavailable (issue #696), pure: OpenFGA is a required service, and a change that needs it (the TypeSafe
// API key) fails with a 503 while it is not set up or not reached. Why it is down, as the banner and the form say it;
// the save error a person reads; and where the fix is written.
import type { AccessStatus } from './wire.ts';

/** What GET /api/access/status answers. */
export type AccessStatusView = Pick<AccessStatus, 'state' | 'why'>;

/** The fix, in the deployment guide: the `openfga` service in compose.yaml. */
export const ACCESS_DOCS_URL = 'https://github.com/henningfutrell/hopper/blob/dev/docs/deploy.md#access-openfga';

/** What the daemon's 503 starts with when OpenFGA cannot be asked (src/domain/access.ts ACCESS_UNAVAILABLE). */
const UNAVAILABLE = 'access checks are unavailable';

export const ACCESS_SAVE_FAILED = 'Couldn\'t save: hopper\'s access service (OpenFGA) isn\'t running. Your other settings are unchanged.';

/** Why access checks cannot be made now; undefined while OpenFGA is connected, or before the state is read. */
export function accessDown(s: AccessStatusView | null): string | undefined {
  if (!s || s.state === 'connected') return undefined;
  return s.why ?? (s.state === 'not-configured' ? 'OpenFGA is not set up' : 'OpenFGA is not reachable');
}

/** A failed save's message for a person: an Access outage says nothing else changed; any other error as it is. */
export const saveError = (message: string): string => (message.startsWith(UNAVAILABLE) ? ACCESS_SAVE_FAILED : message);
