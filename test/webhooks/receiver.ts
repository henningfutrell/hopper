// A real loopback HTTP receiver that records requests and answers from a script.
import { createServer, type IncomingHttpHeaders } from 'node:http';

export interface Received { headers: IncomingHttpHeaders; body: string }
export type Responder = (n: number, res: import('node:http').ServerResponse) => void;

export interface Receiver {
  url: string;
  received: Received[];
  maxActive(): number;
  close(): Promise<void>;
}

export async function startReceiver(respond: Responder): Promise<Receiver> {
  const received: Received[] = [];
  let active = 0;
  let max = 0;
  const server = createServer((req, res) => {
    active++;
    max = Math.max(max, active);
    res.on('close', () => active--);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      respond(received.length, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/hook`,
    received,
    maxActive: () => max,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
