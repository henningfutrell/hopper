// Comment on the job's issue as the job-hopper app, using the per-job token file.
// hopper-comment "text"   or   echo text | hopper-comment
import { readFileSync } from 'node:fs';

const MAX_BODY = 60_000;
const NOTE = '\n(truncated)';

class Refusal extends Error {}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Refusal(`${name} is not set`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readToken(path: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Refusal(`cannot read token file: ${(e as Error).message}`);
      if (Date.now() >= deadline) throw new Refusal(`token file did not appear within ${waitMs} ms`);
      await sleep(100);
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function truncate(body: string): string {
  return body.length <= MAX_BODY ? body : body.slice(0, MAX_BODY - NOTE.length) + NOTE;
}

async function main(): Promise<string> {
  const file = need('HOPPER_TOKEN_FILE');
  const repo = need('HOPPER_REPO');
  const issue = need('HOPPER_ISSUE_NUMBER');
  const marker = need('HOPPER_COMMENT_MARKER');
  const api = (process.env.HOPPER_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const waitMs = Number(process.env.HOPPER_TOKEN_WAIT_MS ?? 30_000);

  const args = process.argv.slice(2);
  const text = args.length > 0 ? args.join(' ') : await readStdin();

  let t: { token?: unknown; expiresAt?: unknown; repo?: unknown; issue?: unknown };
  try {
    t = JSON.parse(await readToken(file, waitMs));
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal('token file is not valid JSON');
  }
  if (typeof t.token !== 'string' || typeof t.expiresAt !== 'string') throw new Refusal('token file is malformed');
  if (!(Date.parse(t.expiresAt) > Date.now())) throw new Refusal(`token expired at ${t.expiresAt}`);
  if (t.repo !== repo) throw new Refusal(`token repo ${String(t.repo)} differs from HOPPER_REPO ${repo}`);
  if (String(t.issue) !== issue) throw new Refusal(`token issue ${String(t.issue)} differs from HOPPER_ISSUE_NUMBER ${issue}`);

  const res = await fetch(`${api}/repos/${repo}/issues/${issue}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${t.token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'job-hopper-hopper-comment',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body: truncate(`${marker}\n${text}`) }),
  });
  if (!res.ok) throw new Refusal(`GitHub answered ${res.status}`);
  const json = (await res.json()) as { html_url?: unknown };
  if (typeof json.html_url !== 'string') throw new Refusal('GitHub reply carried no html_url');
  return json.html_url;
}

try {
  console.log(await main());
} catch (e) {
  const msg = e instanceof Refusal ? e.message : `failed: ${(e as Error).message}`;
  console.error(`hopper-comment: ${msg}`);
  process.exit(1);
}
