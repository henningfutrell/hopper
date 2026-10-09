// A machine joining a hopper (design.md "Joining a machine", issue #308): `node main.ts join <hopper
// URL>#<join code>`, what the Add machine line runs. The machine makes its link key (link.ts) — the
// private half never leaves its client dir — and presents the one-time join code and its public half
// once, at `POST /client/join`. The hopper records the key on a new client target named after the
// machine and answers its own public half; the machine keeps both in its client dir, and dials in from
// then on (dial.ts). A machine whose client dir already holds a link key joins with that key.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOIN_PATH, isPublicKey, mintLinkKey, parseJoinLine, publicKeyOf } from './link.ts';

/** What a joined machine keeps (`link.json`): where the hopper is, whose machine it is, and the two public halves. */
export interface Link {
  url: string;
  user: string;
  /** The machine's name when it joined; the hopper knows it by its key, so a rename there changes nothing here. */
  machine: string;
  /** This machine's machine key: the public half of its link key. */
  key: string;
  /** The hopper's public half: the client token is derived from it. */
  hopperKey: string;
}

/** The private half of the machine's link key, in its client dir (mode 600). */
export const linkKeyFile = (dir: string): string => join(dir, 'link-key.pem');
const linkFile = (dir: string): string => join(dir, 'link.json');

function write(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The machine's link key: the one its client dir holds, else one minted now and kept there. */
function ownKey(dir: string): { privateKey: string; publicKey: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = linkKeyFile(dir);
  if (existsSync(file)) {
    const privateKey = readFileSync(file, 'utf8');
    return { privateKey, publicKey: publicKeyOf(privateKey) };
  }
  const key = mintLinkKey();
  write(file, key.privateKey);
  return key;
}

/** The link a client dir holds. Throws when the machine never joined. */
export function readLink(dir: string): Link {
  const file = linkFile(dir);
  if (!existsSync(file)) throw new Error(`this machine has not joined a hopper (no ${file}): run the line Add machine shows`);
  return JSON.parse(readFileSync(file, 'utf8')) as Link;
}

/** Whether a client dir holds a link. */
export const hasLink = (dir: string): boolean => existsSync(linkFile(dir));

/** Joins the hopper the line names, under `name` (the hopper may give another when it is taken). Resolves the link, kept in `dir`. */
export async function joinHopper(o: { line: string; name: string; dir: string }): Promise<Link> {
  const { url, code } = parseJoinLine(o.line);
  const key = ownKey(o.dir);
  let res: Response;
  try {
    res = await fetch(new URL(JOIN_PATH, url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, key: key.publicKey, name: o.name }),
    });
  } catch (e) {
    throw new Error(`could not reach the hopper at ${url}: ${(e as Error).message}`, { cause: e });
  }
  const text = await res.text();
  let body: { user?: unknown; machine?: unknown; hopperKey?: unknown; error?: unknown } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`the hopper at ${url} refused the join (${res.status}): ${typeof body.error === 'string' ? body.error : text.slice(0, 200)}`);
  if (typeof body.user !== 'string' || typeof body.machine !== 'string' || !isPublicKey(body.hopperKey)) {
    throw new Error(`the hopper at ${url} answered the join without its user, machine and key`);
  }
  const link: Link = { url, user: body.user, machine: body.machine, key: key.publicKey, hopperKey: body.hopperKey };
  write(linkFile(o.dir), `${JSON.stringify(link, null, 2)}\n`);
  return link;
}
