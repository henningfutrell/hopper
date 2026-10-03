// A real loopback HTTP receiver for webhook deliveries.
import { createServer, type IncomingHttpHeaders } from 'node:http';

export interface Received { headers: IncomingHttpHeaders; body: string }

export interface Receiver {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

export async function startReceiver(status = 200): Promise<Receiver> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
