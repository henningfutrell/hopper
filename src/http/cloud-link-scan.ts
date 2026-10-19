// The cloud link's outgoing secret scan (issue #2039 part 2, docs/hopper-io-security.md R4): before the instance sends a
// message to hopper.io, it looks for a secret in it — the patterns the hopper masks everywhere (src/secrets/mask.ts:
// GitHub, Claude and API tokens, 32-byte keys, private keys, cloud keys) and the values of the secrets the link holds — and
// drops a message that holds one. The public halves of the cloud link key look like a 32-byte key, so the ones the
// hello names are taken out first: they are the only key material that may go. Pure.
import { maskSecrets } from '../secrets/mask.ts';

/** Whether `text` holds a secret: a pattern of one, outside `publicKeys`, or any value of `held`. */
export function outgoingSecret(text: string, o: { publicKeys: readonly string[]; held: readonly string[] }): boolean {
  if (o.held.some((h) => h.length > 0 && text.includes(h))) return true;
  const scanned = o.publicKeys.filter((k) => k.length > 0).reduce((t, k) => t.split(k).join('[public half]'), text);
  return maskSecrets(scanned) !== scanned;
}
