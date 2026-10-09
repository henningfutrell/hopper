// Issue #542: the discovery script, run for real against stand-in aws and kubectl on the PATH. It reads the PATH and
// its executables, the known tools' versions, every AWS profile's identity and its simulated reach, every kubectl
// context and what `auth can-i` says there, and the credential sources present — names only: a secret in a
// credentials file or a variable never leaves the machine. Every aws and kubectl call it makes is a read.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AWS_ADMIN_ACTIONS, AWS_WRITE_ACTIONS, KUBE_CHECKS, discoverArgv } from '../../src/client/discover.ts';
import { readDiscovery } from '../../src/blast-radius/read.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SECRET = 'wJalrXUtnFEMI-not-a-real-secret';

const AWS = `#!/bin/sh
printf '%s\\n' "aws $*" >> "$LOG"
p=""; if [ "$1" = "--profile" ]; then p=$2; shift 2; fi
case "$1 $2" in
  "--version ") echo "aws-cli/2.17.0 Python/3.12"; exit 0;;
  "configure list-profiles") printf 'dev\\nprod\\n'; exit 0;;
  "configure get") echo us-east-1; exit 0;;
  "sts get-caller-identity")
    case $p in
      dev) printf '111111111111\\tarn:aws:sts::111111111111:assumed-role/dev-role/s\\n';;
      prod) printf '222222222222\\tarn:aws:sts::222222222222:assumed-role/prod-role/s\\n';;
      *) echo "Unable to locate credentials" >&2; exit 255;;
    esac; exit 0;;
  "iam simulate-principal-policy")
    case $p in
      dev) [ "$4" = "arn:aws:iam::111111111111:role/dev-role" ] || { echo "wrong arn $4" >&2; exit 2; }
           shift 5; for a in "$@"; do [ "$a" = "--query" ] && break; d=implicitDeny; [ "$a" = s3:PutObject ] && d=allowed; printf '%s\\t%s\\n' "$a" "$d"; done; exit 0;;
      *) echo "An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation" >&2; exit 254;;
    esac;;
esac
echo "unexpected: $*" >&2; exit 3
`;

const KUBECTL = `#!/bin/sh
printf '%s\\n' "kubectl $*" >> "$LOG"
case "$*" in
  "version --client") echo "Client Version: v1.31.0";;
  "config current-context") echo dev;;
  "config get-contexts -o name") printf 'dev\\n';;
  "config view --minify --context dev -o jsonpath={..namespace}") printf apps;;
  "config view --minify --context dev -o jsonpath={.contexts[0].context.cluster}") printf dev-cluster;;
  "--context dev auth can-i create deployments --all-namespaces --request-timeout=5s") echo yes;;
  "--context dev auth can-i "*) echo no; exit 1;;
  *) echo "unexpected: $*" >&2; exit 3;;
esac
`;

function machineWithTools(): { env: NodeJS.ProcessEnv; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'discover-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(join(home, '.aws'), { recursive: true });
  mkdirSync(join(home, '.kube'), { recursive: true });
  writeFileSync(join(home, '.aws', 'credentials'), `[dev]\naws_secret_access_key = ${SECRET}\n`);
  writeFileSync(join(home, '.kube', 'config'), 'apiVersion: v1\n');
  for (const [name, body] of [['aws', AWS], ['kubectl', KUBECTL]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  return { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LOG: log, AWS_SECRET_ACCESS_KEY: SECRET, TF_TOKEN_app_terraform_io: SECRET }, log };
}

describe('the discovery script', () => {
  it('finds the tools, the identities and their reach, the contexts and the credential sources — names only', () => {
    const { env, log } = machineWithTools();
    const [file, ...args] = discoverArgv();
    const out = execFileSync(file!, args, { env, encoding: 'utf8', timeout: 60000 });
    expect(out).not.toContain(SECRET);
    const facts = readDiscovery(out)!;
    expect(facts).toBeDefined();
    expect(facts.path[0]).toMatch(/\/bin$/);
    expect(facts.bins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'aws' }), expect.objectContaining({ name: 'kubectl' })]));
    expect(facts.versions).toMatchObject({ aws: 'aws-cli/2.17.0 Python/3.12', kubectl: 'Client Version: v1.31.0' });
    expect(facts.aws).toEqual([
      { profile: '(environment)', error: 'Unable to locate credentials' },
      {
        profile: 'dev', account: '111111111111', arn: 'arn:aws:sts::111111111111:assumed-role/dev-role/s', region: 'us-east-1',
        simulated: AWS_WRITE_ACTIONS.map((action) => ({ action, decision: action === 's3:PutObject' ? 'allowed' : 'implicitDeny' })),
      },
      {
        profile: 'prod', account: '222222222222', arn: 'arn:aws:sts::222222222222:assumed-role/prod-role/s', region: 'us-east-1',
        simulationError: 'An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation',
      },
    ]);
    expect(facts.kube).toEqual([{
      name: 'dev', cluster: 'dev-cluster', namespace: 'apps', current: true,
      can: KUBE_CHECKS.map((check) => ({ check, answer: check === 'create deployments' ? 'yes' : 'no' })),
    }]);
    expect(facts.credentials.env).toEqual(['AWS_SECRET_ACCESS_KEY', 'TF_TOKEN_app_terraform_io']);
    expect(facts.credentials.files).toEqual(['aws-credentials', 'kubeconfig']);

    // Every call a read: versions, config reads, identity, simulation, can-i.
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const read = /^(aws (--profile \S+ )?(--version|configure (list-profiles|get region)|sts get-caller-identity|iam simulate-principal-policy)|kubectl (version --client|config (current-context|get-contexts|view)|--context \S+ auth can-i))( |$)/;
    expect(calls.filter((c) => !read.test(c))).toEqual([]);
  });

  it('the admin actions are among the write actions it simulates', () => {
    expect(AWS_WRITE_ACTIONS).toEqual(expect.arrayContaining([...AWS_ADMIN_ACTIONS]));
  });

  it('a machine with none of the tools: the PATH, and nothing reached', () => {
    const root = mkdtempSync(join(tmpdir(), 'discover-'));
    dirs.push(root);
    const [file, ...args] = discoverArgv();
    const out = execFileSync(file!, args, { env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8' });
    expect(readDiscovery(out)).toMatchObject({ aws: [], kube: [], versions: {}, credentials: { env: [], files: [] } });
  });

  it('an output that did not finish reads as nothing', () => {
    expect(readDiscovery('hopper-path /usr/bin\n')).toBeUndefined();
  });
});
