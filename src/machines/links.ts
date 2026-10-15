// The links of the machines dialled in to this hopper (design.md "Joining a machine", issue #308): one
// socket per machine key per user, the one its client dialled in on (src/http/client-link.ts). A client
// that dials in again replaces its old link; a link that ends is forgotten. A machine that said it leaves (issue #1284,
// `POST /client/leave`) is **leaving** until it dials in again: no new job is placed on it. What goes down a link is the
// hopper's HTTP/2 calls (src/executors/client.ts); this only keeps the sockets.
import type { Duplex } from 'node:stream';

export interface MachineLinks {
  /**
   * A machine's new link: an older one of the same machine is closed. `url`: the hopper's URL as the machine
   * dialled it — what its jobs reach the hopper at (the GitHub proxy, issue #563).
   */
  accept(user: string, key: string, socket: Duplex, url?: string): void;
  /** The machine's link now; undefined while it is not dialled in. */
  link(user: string, key: string): Duplex | undefined;
  /** The hopper's URL as the machine last dialled it; undefined: it has not dialled in since this daemon started. */
  urlOf(user: string, key: string): string | undefined;
  /** When the machine last dialled in (ms since the epoch); 0: never since this daemon started. */
  dialledAt(user: string, key: string): number;
  /** The machine said it leaves (issue #1284): leaving until it dials in again. */
  leave(user: string, key: string): void;
  /** Whether the machine is leaving: it said so, and has not dialled in since. */
  leaving(user: string, key: string): boolean;
  /** Closes every link (the daemon stops). */
  closeAll(): void;
}

export function createMachineLinks(): MachineLinks {
  const links = new Map<string, Duplex>();
  const at = new Map<string, number>();
  const urls = new Map<string, string>();
  const left = new Set<string>();
  const id = (user: string, key: string): string => `${user}\0${key}`;
  return {
    accept(user, key, socket, url) {
      const k = id(user, key);
      const old = links.get(k);
      links.set(k, socket);
      at.set(k, Date.now());
      left.delete(k);
      if (url) urls.set(k, url);
      old?.destroy();
      socket.once('close', () => { if (links.get(k) === socket) links.delete(k); });
      // The upgraded socket is half-open: a client that hangs up ends it, and nothing else closes this end (issue #708).
      socket.once('end', () => socket.destroy());
    },
    link: (user, key) => links.get(id(user, key)),
    dialledAt: (user, key) => at.get(id(user, key)) ?? 0,
    urlOf: (user, key) => urls.get(id(user, key)),
    leave: (user, key) => { left.add(id(user, key)); },
    leaving: (user, key) => left.has(id(user, key)),
    closeAll() {
      for (const s of links.values()) s.destroy();
      links.clear();
    },
  };
}
