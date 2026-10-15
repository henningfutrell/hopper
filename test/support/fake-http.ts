// The fake forges' HTTP plumbing (test/support/fake-forges.ts): a request's body, JSON or a form, and a JSON answer.
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text }; }
}

/** `etag`: the answer's ETag (issue #1250). */
export const send = (res: ServerResponse, status: number, body: unknown, etag?: string) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(etag !== undefined ? { etag } : {}) });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
