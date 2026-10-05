// Test webhook receiver: verifies, dedupes, logs. Not part of the daemon.
// node scripts/webhook-subscriber.ts --port 4795 --secret <s> --log <file>
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { verify } from '../src/webhooks/index.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4795' },
    secret: { type: 'string' },
    log: { type: 'string', default: 'webhook-deliveries.jsonl' },
  },
});
const secret = values.secret;
if (!secret) {
  console.error('usage: webhook-subscriber.ts --port 4795 --secret <s> --log <file>');
  process.exit(2);
}
const logPath = values.log as string;
const seen = new Set<string>();

function header(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const timestamp = header(req.headers['x-hopper-timestamp']);
    const delivery = header(req.headers['x-hopper-delivery']);
    const event = header(req.headers['x-hopper-event']);
    const signature = header(req.headers['x-hopper-signature']);
    const signatureValid = verify(secret, timestamp, raw, signature);
    if (!signatureValid) {
      console.log(`delivery ${delivery || '?'} ${event || '?'} REJECTED bad signature`);
      res.writeHead(401).end();
      return;
    }
    if (seen.has(delivery)) {
      console.log(`delivery ${delivery} ${event} duplicate, ignored`);
      res.writeHead(200).end();
      return;
    }
    seen.add(delivery);
    let seq: number | undefined;
    let type: string | undefined;
    try {
      const body = JSON.parse(raw) as { seq?: number; type?: string };
      seq = body.seq;
      type = body.type;
    } catch {
      // body is signed but not JSON; log it with no seq/type
    }
    const line = { at: new Date().toISOString(), delivery, event, seq, type, signatureValid };
    appendFileSync(logPath, JSON.stringify(line) + '\n');
    console.log(`delivery ${delivery} ${event} seq=${seq ?? '-'} signature ok`);
    res.writeHead(200).end();
  });
});

server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`webhook-subscriber listening on 127.0.0.1:${values.port}, log ${logPath}`);
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
