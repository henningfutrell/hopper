// The route to a database a bastion forwards to (issue #2231, design.md "Database reads"): a port on 127.0.0.1 that lives for
// one read, each connection to it joined to one relay connection of the job's bastion. The database clients connect as
// they do to any host, and their TLS passes through as bytes. The relay is asked once before the port opens, so a bastion
// that does not run is said at once, not found later as a lost connection. Whoever reaches the port reaches only what the
// job's own relay reaches, and needs the database's login.
import { createServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** One connection to a bastion target (the relay), or why there is none and the HTTP status that says so. */
export type DatabaseConnect = (target: string) => Promise<Duplex | { status: number; no: string }>;

export interface DatabaseRoute {
  port: number;
  /** What the relay refused after the port opened: a database client says only that its connection ended. */
  problem(): string | undefined;
  /** Closes the port and everything open through it. */
  close(): void;
}

export async function openDatabaseRoute(target: string, connect: DatabaseConnect): Promise<DatabaseRoute | { status: number; no: string }> {
  const asked = await connect(target);
  if ('no' in asked) return asked;
  let first: Duplex | undefined = asked;
  let problem: string | undefined;
  const open = new Set<Socket | Duplex>([asked]);
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('error', () => socket.destroy()).once('close', () => open.delete(socket));
    socket.pause();
    const pipe = first ?? connect(target);
    first = undefined;
    void Promise.resolve(pipe).then((p) => {
      if ('no' in p) { problem = p.no; socket.destroy(); return; }
      if (!server.listening || socket.destroyed) { p.destroy(); return; }
      open.add(p);
      p.on('error', () => socket.destroy()).once('close', () => { open.delete(p); socket.destroy(); });
      socket.once('close', () => p.destroy());
      socket.pipe(p);
      p.pipe(socket);
      socket.resume();
    }, (e: unknown) => { problem = e instanceof Error ? e.message : String(e); socket.destroy(); });
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return {
    port: (server.address() as { port: number }).port,
    problem: () => problem,
    close() {
      server.close();
      for (const s of open) s.destroy();
    },
  };
}
