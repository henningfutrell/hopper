// The scan of a promotion's text (issue #946, design.md "Promote to GitHub"): before anything is posted, the text is
// searched for secrets — GitHub tokens, keys, private keys, cloud and API keys (src/secrets/mask.ts) — and for personal
// data: email addresses, phone numbers in international form, IP addresses, private host names and home directories. The
// preview starts from text cleaned of both; a person who puts some back sees it refused, or, for personal data on a
// private repository, posts it only when they say so. Pure.
import type { RepoVisibility, ScanFinding } from '../domain/promotions.ts';
import { maskAddresses, maskSecrets } from '../secrets/mask.ts';

const EMAIL = /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** A phone number in international form: `+`, a country code, then at least six more digits in groups. */
const PHONE = /(?<![\w+])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?!\w)/g;

const maskPersonal = (text: string): string =>
  maskAddresses(text.replace(EMAIL, '[email, masked]').replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone, masked]' : m)));

/** The text with secrets and personal data masked: where a preview starts from. */
export const cleanText = (text: string): string => maskPersonal(maskSecrets(text));

/** What the text holds that must not go to GitHub as it is. */
export function scanText(text: string): ScanFinding[] {
  const found: ScanFinding[] = [];
  if (maskSecrets(text) !== text) found.push({ kind: 'secret', what: 'a secret: a token or a key' });
  if (maskPersonal(text) !== text) found.push({ kind: 'personal', what: 'personal data: an email address, a phone number, an IP address, a private host name or a home directory' });
  return found;
}

/**
 * Why the findings stop a post; undefined: they do not. A secret always stops it. Personal data stops it on a public
 * repository, and on any other unless the person allowed it.
 */
export function postRefusal(found: readonly ScanFinding[], o: { visibility: RepoVisibility; allowPersonalData?: boolean }): string | undefined {
  if (found.some((f) => f.kind === 'secret')) return 'the text holds a secret: a token or a key. Remove it: a secret is never posted';
  if (!found.some((f) => f.kind === 'personal')) return undefined;
  if (o.visibility === 'public') return 'the text holds personal data, and the repository is public: remove it';
  return o.allowPersonalData ? undefined : 'the text holds personal data: remove it, or allow it for this private repository';
}
