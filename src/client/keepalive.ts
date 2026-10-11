// The link's keepalive (design.md "Link-lost hold", issue #752): both ends of a machine's link send an HTTP/2 PING on
// it every few seconds. A PING not answered in time means the link is dead or half-open (the network went away and no
// FIN came): the end that sent it drops the link at once, instead of finding out only when a call times out. The hopper
// then holds a running job (the link is down); the client dials in again.
// Imports nothing of hopper: it is one of the client's files.
import { performServerHandshake, type Http2Session, type ServerHttp2Session } from 'node:http2';
import type { Duplex } from 'node:stream';

/** How often each end PINGs the other, and how long it waits for the answer before it drops the link. */
export interface PingTiming { everyMs: number; timeoutMs: number }

export const PING_TIMING: PingTiming = { everyMs: 5000, timeoutMs: 10000 };

/** PINGs on `session` until it closes; `drop` is called once, when a PING is not answered in time or fails. */
export function keepAlive(session: Http2Session, drop: () => void, t: PingTiming = PING_TIMING): void {
  let waiting: NodeJS.Timeout | undefined;
  let dropped = false;
  const stop = (): void => { clearInterval(every); clearTimeout(waiting); };
  const lost = (): void => {
    if (dropped) return;
    dropped = true;
    stop();
    drop();
  };
  const every = setInterval(() => {
    if (waiting || session.destroyed) return;
    waiting = setTimeout(lost, t.timeoutMs);
    waiting.unref();
    try {
      session.ping((err) => {
        clearTimeout(waiting);
        waiting = undefined;
        if (err && !session.destroyed) lost();
      });
    } catch {
      lost();
    }
  }, t.everyMs);
  every.unref();
  session.once('close', stop);
}

/** The client's end of its link: HTTP/2 served on `socket`, kept alive; `drop` when the hopper stops answering PINGs. */
export function serveLink(socket: Duplex, drop: () => void, t?: PingTiming): ServerHttp2Session {
  const session = performServerHandshake(socket);
  keepAlive(session, drop, t);
  return session;
}
