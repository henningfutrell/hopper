// The hopper client's dial-in (design.md "Joining a machine", issue #308): one outbound HTTP/1.1 upgrade
// to the hopper's own URL — the URL it joined at — signed with the client token (signature.ts
// signConnect). Answered 101, the socket is the link: the client serves HTTP/2 on it (server.ts), and
// the hopper sends its signed calls down it. Nothing listens on this machine; whatever reaches the
// hopper's UI reaches this route. A reverse proxy in front must pass the upgrade on.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { CONNECT_PATH, LINK_PROTOCOL, MACHINE_KEY_HEADER, USER_HEADER } from './link.ts';
import { signConnect } from './signature.ts';

export interface DialOptions {
  /** The hopper's URL, as this machine reaches it. */
  url: string;
  /** The user whose machine this is, and its machine key (the public half of its link key). */
  user: string;
  key: string;
  /** The client token, derived from this machine's link key and the hopper's public half. */
  token: () => string;
}

/** Dials once: resolves the link's socket, or rejects with what the hopper answered. */
export const dialIn = (o: DialOptions) => (): Promise<Duplex> => new Promise((resolve, reject) => {
  const u = new URL(CONNECT_PATH, o.url);
  const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = request(u, {
    method: 'GET',
    headers: {
      connection: 'Upgrade', upgrade: LINK_PROTOCOL,
      [USER_HEADER]: o.user, [MACHINE_KEY_HEADER]: o.key, 'x-hopper-signature': signConnect(o.token(), o.user, o.key),
    },
  });
  req.setTimeout(15000, () => req.destroy(new Error(`no answer from ${u.origin} within 15 s`)));
  req.on('upgrade', (_res, socket, head) => {
    req.setTimeout(0);
    socket.setTimeout(0);
    if (head.length) socket.unshift(head);
    resolve(socket);
  });
  req.on('response', (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => { if (text.length < 500) text += c; });
    res.on('end', () => reject(new Error(`${u.origin} refused the link (${res.statusCode}): ${text.slice(0, 300)}`)));
  });
  req.on('error', reject);
  req.end();
});
