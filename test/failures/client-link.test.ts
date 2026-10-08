// hopper's own client errors as known causes (issue #517). A job on a client target fails with the error
// `src/executors/client.ts` throws when the machine is not dialled in, or its link closes before the answer: those
// are the machine-offline and link-closed causes, never "no known cause". The messages are the ones the real
// transport throws — through a real HTTP/2 link the far end drops, and every ClientError template in its source —
// so a reworded message fails here instead of falling through to a person.
import { readFileSync } from 'node:fs';
import { createServer as createH2Server } from 'node:http2';
import { createServer, connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { clientHerdr } from '../../src/executors/client.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { signatureOf } from '../../src/failures/signature.ts';

const TOKEN = 'a'.repeat(64);
const causeOf = (error: string): string | undefined => matchCause(error, signatureOf(error).signature, [])?.id;
const errorOf = (p: Promise<unknown>): Promise<string> => p.then(() => { throw new Error('the call answered'); }, (e: Error) => e.message);

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

/** A link whose far end takes the HTTP/2 session, then drops the socket when the call arrives. */
async function droppingLink(): Promise<Socket> {
  const h2 = createH2Server();
  let far: Socket | undefined;
  const server = createServer((s) => { far = s; h2.emit('connection', s); });
  h2.on('stream', () => far?.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const link = connect((server.address() as { port: number }).port, '127.0.0.1');
  await new Promise((r) => link.once('connect', r));
  stops.push(() => { link.destroy(); server.close(); });
  return link;
}

describe('the client errors a job fails with', () => {
  it('not dialled in: the machine is offline', async () => {
    const message = await errorOf(clientHerdr({ machine: 'lab', link: () => undefined, token: () => TOKEN }, ['status'], 1000));
    expect(message).toBe('client lab is not dialled in');
    expect(causeOf(message)).toBe('machine-offline');
    // As the herdr executor reports it.
    expect(causeOf(`herdr: ${message}`)).toBe('machine-offline');
  });

  it('its link closed before the answer: the link closed, run again', async () => {
    const link = await droppingLink();
    const message = await errorOf(clientHerdr({ machine: 'lab', link: () => link, token: () => TOKEN }, ['status'], 1000));
    expect(message).toMatch(/link closed/);
    expect(causeOf(message)).toBe('link-closed');
    expect(causeOf(`herdr: ${message}`)).toBe('link-closed');
  });
});

describe('every ClientError the transport can throw', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/executors/client.ts', import.meta.url)), 'utf8');
  const templates = [...source.matchAll(/new ClientError\(`([^`]+)`\)/g)].map((m) => m[1]!);
  /** A template with its machine named and every other value a stand-in. */
  const render = (t: string): string => t.replace(/\$\{t\.machine\}/g, 'lab').replace(/\$\{[^}]+\}/g, '7');
  /**
   * Its known cause, by template: a machine that is gone or a link that closed is a known cause; the rest are the
   * client's or the hopper's own refusals (a token, a signature, a status), whose text decides. A new template
   * fails until it is placed here.
   */
  const EXPECTED: Record<string, string | 'its text'> = {
    'client ${t.machine} is not dialled in': 'machine-offline',
    'client ${t.machine}: no answer: its link closed': 'link-closed',
    'client ${t.machine}: no answer within ${timeoutMs + 5000} ms, or its link closed': 'link-closed',
    'client ${t.machine}: ${e.message}': 'its text',
    'client ${t.machine}: ${(e as Error).message}': 'its text',
    'client ${t.machine}: no release in its answer': 'its text',
    'client ${t.machine} refused the hopper (401): ${text.slice(0, 200)}': 'its text',
    'client ${t.machine}: the answer on its link did not prove itself (no valid client signature)': 'its text',
    'client ${t.machine}: ${status} ${text.slice(0, 200)}': 'its text',
    'client ${t.machine}: answer is not JSON': 'its text',
  };

  it('each one is placed', () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) expect(Object.keys(EXPECTED), `a new ClientError: place it in EXPECTED with its cause: ${t}`).toContain(t);
  });

  it.each(Object.entries(EXPECTED).filter(([, c]) => c !== 'its text'))('%s → %s', (t, cause) => {
    expect(templates).toContain(t);
    expect(causeOf(render(t))).toBe(cause);
    expect(causeOf(`herdr: ${render(t)}`)).toBe(cause);
  });
});
