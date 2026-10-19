// Settings → hopper.io, the connection's state (issue #2039): one line that says whether this hopper is connected to
// hopper.io now, and when not, why and what to do. Pure.
import type { CloudConnectionView } from './wire.ts';

export function connectionLine(c: CloudConnectionView | undefined): string {
  switch (c?.state) {
    case 'off': return 'Not connected: this hopper is not linked';
    case 'no-pin': return 'Not connected: this version of the hopper has no key for hopper.io yet';
    case 'no-key': return 'Not connected: the link has no key. Rotate the key to make one';
    case 'connecting': return 'Connecting to hopper.io…';
    case 'connected': return `Connected to hopper.io${c.since ? ` since ${new Date(c.since).toLocaleString()}` : ''}`;
    case 'waiting': return `Not connected: ${c.problem ?? 'the connection ended'}.${c.retryAt ? ` Next try ${new Date(c.retryAt).toLocaleTimeString()}` : ''}`;
    case 'revoked': return 'Not connected: hopper.io revoked the key. Rotate the key, then register again';
    default: return 'Not connected';
  }
}
