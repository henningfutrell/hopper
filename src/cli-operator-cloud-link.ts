// The cloud link key from the command line (issue #2039, docs/hopper-io-security.md R4): `hopper cloud-link show` prints
// the link and its connection to hopper.io (GET /api/cloud-link); `rotate-key` and `revoke-key` post to the routes
// Settings → hopper.io posts to. The private half never leaves the hopper.
import { usage, type Call } from './cli-operator-call.ts';

export const CLOUD_LINK_USAGE = `  hopper cloud-link show                             the link to hopper.io, its key's public half and its connection now
  hopper cloud-link rotate-key                       a new cloud link key; the old one works until the new one connected
  hopper cloud-link revoke-key                       drop the cloud link key: no connection to hopper.io until rotate-key`;

export function cloudLinkCall(args: string[]): Call {
  const [verb, ...extra] = args;
  if (extra.length === 0 && verb === 'show') return { role: 'admin', path: '/api/cloud-link' };
  if (extra.length === 0 && (verb === 'rotate-key' || verb === 'revoke-key')) return { role: 'admin', path: `/ui/api/cloud-link/${verb}`, body: async () => ({}) };
  throw usage('cloud-link show|rotate-key|revoke-key');
}
