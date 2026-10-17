// hopper.io's config (issue #463, docs/cloud-hosting-identity.md): everything from the runtime, nothing in a file of
// its own. hopper.io signs in through a GitHub App of its own (decision 1), with no permissions; its client id and
// its client secret come from the runtime — the secret as the variable or the mounted file `<name>_FILE` names, as an
// instance's secrets do (src/secrets/runtime.ts). A missing or wrong value stops the service at start.
import { runtimeSecrets } from '../src/secrets/runtime.ts';

export interface CloudConfig {
  /** The Postgres hopper.io keeps its accounts in. */
  databaseUrl: string;
  /** Where people reach hopper.io: the origin the GitHub callback and the sign-out check use. */
  publicUrl: string;
  /** GitHub's web origin: https://github.com, or a GitHub Enterprise's (a test's fake). */
  githubUrl: string;
  /** The hosted GitHub App's public client id. */
  clientId: string;
  /** The hosted GitHub App's client secret: the web flow's code exchange needs it. */
  clientSecret: string;
  host: string;
  port: number;
  /** Behind a reverse proxy: take the client's address from X-Forwarded-For (the sign-in limit counts per address). */
  trustProxy: boolean;
}

export const VARIABLES = {
  databaseUrl: 'HOPPER_IO_DATABASE_URL',
  publicUrl: 'HOPPER_IO_PUBLIC_URL',
  githubUrl: 'HOPPER_IO_GITHUB_URL',
  clientId: 'HOPPER_IO_GITHUB_CLIENT_ID',
  clientSecret: 'HOPPER_IO_GITHUB_CLIENT_SECRET',
  host: 'HOPPER_IO_HOST',
  port: 'HOPPER_IO_PORT',
  trustProxy: 'HOPPER_IO_TRUST_PROXY',
} as const;

const DEFAULT_PORT = 8080;

export function cloudConfig(env: Record<string, string | undefined>): CloudConfig {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const databaseUrl = need(VARIABLES.databaseUrl);
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error(`${VARIABLES.databaseUrl} must be postgres://user:password@host:port/database`);
  const publicUrl = origin(need(VARIABLES.publicUrl), VARIABLES.publicUrl);
  const clientSecret = runtimeSecrets(env)(VARIABLES.clientSecret);
  if (!clientSecret) throw new Error(`${VARIABLES.clientSecret} (or ${VARIABLES.clientSecret}_FILE) is not set`);
  const port = Number(env[VARIABLES.port] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${VARIABLES.port} must be a port number`);
  return {
    databaseUrl, publicUrl, clientSecret, port,
    githubUrl: origin(env[VARIABLES.githubUrl]?.trim() || 'https://github.com', VARIABLES.githubUrl),
    clientId: need(VARIABLES.clientId),
    host: env[VARIABLES.host]?.trim() || '127.0.0.1',
    trustProxy: ['1', 'true'].includes(env[VARIABLES.trustProxy]?.trim() ?? ''),
  };
}

/** `raw` as an origin, no path: https, or http on loopback only (a local run, a test). */
function origin(raw: string, name: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`${name} must be https (http only on loopback)`);
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${name} must be an origin, with no path`);
  return u.origin;
}
