// hopper-secret (design.md "The vault", issue #558): what a job on a joined machine runs to get a vault
// secret just in time. The client writes a script of that name in its client dir (vault.ts) and the hopper
// gives each job its path as HOPPER_SECRET. It asks the client's socket for one secret, showing the job's proxy
// token (the file HOPPER_TOKEN_FILE names, issue #563), and prints it in the form the tool that runs it wants:
//
//   $HOPPER_SECRET get NAME                the value, as it is
//   $HOPPER_SECRET git NAME [USER] <op>    a git credential helper: answers `get` with the value as the
//                                          password (user x-access-token unless named); `store`, `erase` ignored
//   $HOPPER_SECRET aws NAME                an AWS credential_process: the secret holds the key pair as JSON
//                                          {AccessKeyId, SecretAccessKey[, SessionToken, Expiration]}
//   $HOPPER_SECRET kube NAME               a kubeconfig exec credential plugin: the secret is the token
//   $HOPPER_SECRET aws OPERATION ASSET     a credential_process: an AWS role session the hopper mints for the
//                                          operation on the role (aws-role/<account>/<role>), short-lived (issue #580)
//   $HOPPER_SECRET kube OPERATION ASSET    an exec credential plugin: a Kubernetes token the hopper mints for the
//                                          operation on the cluster or namespace, short-lived, with its expiry
//
// A minted credential is asked again at each run: the tool runs the helper again when the last one expires, and the
// hopper asks Access before each one.
// It holds the value only in memory and writes it only to its standard output, for the tool that ran it.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { isSecretName, SOCKET_VARIABLE, type MintForm, type VaultAsk } from './vault.ts';

const USAGE = 'usage: hopper-secret get NAME | git NAME [USER] get|store|erase | aws NAME | kube NAME | aws OPERATION ASSET | kube OPERATION ASSET';

export type Form = 'get' | 'aws' | 'kube';

/** The value in the form a tool reads it. `env` is the helper's environment (kubectl's KUBERNETES_EXEC_INFO). Throws when the value does not fit. */
export function credentialOutput(form: Form, value: string, env: Record<string, string | undefined> = {}): string {
  if (form === 'get') return value;
  if (form === 'aws') {
    let pair: Record<string, unknown> = {};
    try { pair = JSON.parse(value) as Record<string, unknown>; } catch { /* below */ }
    if (typeof pair.AccessKeyId !== 'string' || typeof pair.SecretAccessKey !== 'string') {
      throw new Error('an aws secret must hold JSON with AccessKeyId and SecretAccessKey (and SessionToken, Expiration when it has them)');
    }
    return JSON.stringify({
      Version: 1, AccessKeyId: pair.AccessKeyId, SecretAccessKey: pair.SecretAccessKey,
      ...(typeof pair.SessionToken === 'string' ? { SessionToken: pair.SessionToken } : {}),
      ...(typeof pair.Expiration === 'string' ? { Expiration: pair.Expiration } : {}),
    });
  }
  let apiVersion = 'client.authentication.k8s.io/v1';
  try {
    const info = JSON.parse(env.KUBERNETES_EXEC_INFO ?? '') as { apiVersion?: unknown };
    if (typeof info.apiVersion === 'string' && info.apiVersion.startsWith('client.authentication.k8s.io/')) apiVersion = info.apiVersion;
  } catch { /* kubectl gave none */ }
  return JSON.stringify({ apiVersion, kind: 'ExecCredential', status: { token: value } });
}

/** A minted credential (the hopper's JSON) in the form a tool reads it, its expiry kept: kubectl and the AWS CLI ask again after it. */
export function mintedOutput(form: 'aws' | 'kube', value: string, env: Record<string, string | undefined> = {}): string {
  if (form === 'aws') return credentialOutput('aws', value);
  let minted: { token?: unknown; expirationTimestamp?: unknown } = {};
  try { minted = JSON.parse(value) as typeof minted; } catch { /* below */ }
  if (typeof minted.token !== 'string' || typeof minted.expirationTimestamp !== 'string') throw new Error('the hopper\'s minted token is not one kubectl can take');
  const out = JSON.parse(credentialOutput('kube', minted.token, env)) as { status: Record<string, string> };
  out.status.expirationTimestamp = minted.expirationTimestamp;
  return JSON.stringify(out);
}

/** Asks the client's socket: a secret by name, or a credential minted. */
function ask(socket: string, request: VaultAsk): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let text = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on('data', (c: string) => { text += c; });
    conn.on('error', (e) => reject(new Error(`the hopper client's vault is not reachable at ${socket}: ${e.message}`)));
    conn.on('end', () => {
      let answer: { value?: unknown; error?: unknown } = {};
      try { answer = JSON.parse(text) as typeof answer; } catch { /* below */ }
      if (typeof answer.value === 'string') resolve(answer.value);
      else reject(new Error(typeof answer.error === 'string' ? answer.error : 'the hopper client gave no answer'));
    });
  });
}

const readStdin = (): Promise<string> => new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c: string) => { text += c; });
  process.stdin.on('end', () => resolve(text));
  process.stdin.on('error', () => resolve(text));
});

async function run(argv: string[]): Promise<string> {
  const [mode, name, ...rest] = argv;
  if (!mode || !name || !['get', 'git', 'aws', 'kube'].includes(mode)) throw new Error(USAGE);
  // `aws|kube OPERATION ASSET`: minted. An asset always has a `/`, a secret's name never.
  const mint = (mode === 'aws' || mode === 'kube') && rest.length === 1 ? { mint: mode as MintForm, operation: name, asset: rest[0]! } : undefined;
  if (!mint && !isSecretName(name)) throw new Error(`${JSON.stringify(name)} is not a vault secret's name`);
  let user = 'x-access-token';
  if (mode === 'git') {
    const op = rest.at(-1);
    if (rest.length === 2) user = rest[0]!;
    if (!op || rest.length > 2) throw new Error(USAGE);
    await readStdin();
    if (op !== 'get') return '';
  } else if (rest.length && !mint) throw new Error(USAGE);
  const file = process.env.HOPPER_TOKEN_FILE;
  if (!file) throw new Error('HOPPER_TOKEN_FILE is not set: a vault secret is given only to a job the hopper runs on this machine');
  let token: string;
  try { token = readFileSync(file, 'utf8').trim(); } catch (e) { throw new Error(`the job's token cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'}): a vault secret is given only to a job the hopper runs on this machine`, { cause: e }); }
  const socket = process.env[SOCKET_VARIABLE];
  if (!socket) throw new Error(`${SOCKET_VARIABLE} is not set: run the hopper-secret the client wrote ($HOPPER_SECRET)`);
  if (mint) return mintedOutput(mint.mint, await ask(socket, { ...mint, token }), process.env);
  const value = await ask(socket, { name, token });
  if (mode === 'git') return `username=${user}\npassword=${value}\n`;
  return credentialOutput(mode as Form, value, process.env);
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((out) => {
    process.stdout.write(out);
  }, (e: unknown) => {
    process.stderr.write(`hopper-secret: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
