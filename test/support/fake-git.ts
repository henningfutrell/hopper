// GitHub's git over HTTP for the fake GitHub (issue #652): the bare repositories `<root>/<owner>/<name>.git`, served by
// git's own `git-http-backend` (CGI). A read without credentials is answered as for a public repository; a push needs a
// token the forge accepts, as the password of Basic auth. Each request is recorded with its auth.
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeRequest } from './fake-forges.ts';

const GIT_PATH = /^\/([^/]+\/[^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** One git request answered by `git-http-backend` (CGI) over the bare repositories under `root`. */
function gitBackend(root: string, req: IncomingMessage, res: ServerResponse, u: URL, repo: string, rest: string, user: string | undefined): void {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${repo}.git/${rest}`,
    QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '',
    ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
    ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
    ...(user ? { REMOTE_USER: user } : {}),
  };
  const cgi = spawn('/usr/lib/git-core/git-http-backend', [], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  cgi.stdout.on('data', (chunk: Buffer) => {
    if (started) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    started = true;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
      const i = line.indexOf(':');
      const name = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (name === 'status') status = Number(value.split(' ')[0]);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  cgi.on('close', () => { if (!started) res.writeHead(500); res.end(); });
}

/** Answers `req` when it is a git request: true. `tokens` are the tokens the forge accepts, by token → login. */
export function serveGit(root: string, tokens: Map<string, string>, req: IncomingMessage, res: ServerResponse, u: URL, record: (r: ForgeRequest) => void): boolean {
  const git = GIT_PATH.exec(u.pathname);
  if (!git) return false;
  const auth = req.headers.authorization ?? '';
  record({ method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body: {}, auth });
  const basic = /^basic\s+(\S+)$/i.exec(auth)?.[1];
  const password = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':') : undefined;
  const user = password !== undefined ? tokens.get(password) : undefined;
  const pushing = u.pathname.endsWith('/git-receive-pack') || u.searchParams.get('service') === 'git-receive-pack';
  if ((password !== undefined && !user) || (pushing && !user)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"', 'content-type': 'text/plain' });
    res.end('Invalid username or token.');
    return true;
  }
  gitBackend(root, req, res, u, git[1]!, git[2]!, user);
  return true;
}
