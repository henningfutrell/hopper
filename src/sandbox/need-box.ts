// A need step's box (issue #1007, design.md "Need steps"): one command of a job's run in a one-shot box of a
// template that covers the job's needs — the template's image with its tools, under the sandbox flags, as a read-only
// check box runs (check.ts) —, with the credentials the vault minted for that step only. The job keeps its own machine
// and its own work; only the step that needs the account or the cluster runs here.
//
// The credentials come in the box's environment, never in the script: the script writes each into its file under the
// box's home (umask 077) and takes it out of the environment before the command runs. One AWS role: its session is also
// the AWS CLI's own variables. Every AWS role is a profile named for its asset (`aws --profile <account>-<role>`), the
// first one AWS_PROFILE; every cluster or namespace a kubeconfig context named for its asset, the first one current.
// The step's files — the inputs (a tar) and, for a step that applies an infra plan, the plan's saved file — are copied
// into the box once it runs, before the command: the inputs extracted into the work directory, the plan file under
// `$HOME/.hopper-need`, then a mark that they are all there, which the script waits for. A runtime with no copy (one on a
// machine of the user's) takes them in the environment instead, as a small tar in base64: at most 64 KiB. A need box
// holds no proxy token, so the apply wrapper in it reads the plan file there (HOPPER_PLAN_FILE) and fetches nothing.
// The outputs (paths relative to the step's work directory) come back as a tar in base64 after a mark at the end of the
// box's output, which the job's log never shows. The box ends with the command's exit code; the box and its home volume
// are removed after it. It starts only on a home volume it made itself (issue #1371): never one of an earlier box.
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { BoxTool, ContainerRuntime, TemplateLimits } from '../domain/sandboxes.ts';
import { HOME } from './flags.ts';
import { boxImage } from './box-image.ts';
import { boxLimits } from './params.ts';
import { filesTar } from './socket-http.ts';

import { NEED_LABEL, staleHome, USER_LABEL } from './owned.ts';

export { NEED_LABEL };
/** The most a step's files may hold in the box's environment, when its runtime takes no copy. */
export const NEED_BOX_ENV_FILES_MAX_BYTES = 64 * 1024;
/** The most a step's outputs tar may hold: it comes back in the box's output. */
export const NEED_BOX_OUTPUTS_MAX_BYTES = 16 * 1024 * 1024;
/** How often the box's output is read while the step runs, to stream it to the job. */
export const NEED_POLL_MS = 1000;
/** Where the step's command runs in the box, its inputs extracted and its outputs taken from. */
export const NEED_WORK_DIR = '$HOME/work';
/** Where the box keeps the step's files, under its home: the plan file, and the inputs that came in the environment. */
const FILES_DIR = '.hopper-need';
/** How long the script waits for its copied files, in seconds: a copy may take as long (src/sandbox/exec.ts). */
const FILES_WAIT_S = 600;
const OUTPUTS_MARK = 'HOPPER-STEP-OUTPUTS';
const END_MARK = 'HOPPER-STEP-END';

/** One need's minted credential, as the need box takes it. */
export interface NeedCredential { profile: OperationProfile; minted: Minted; reach: MintReach }

/** A profile's or context's name for an asset: its name, `/` as `-`. */
export const credentialName = (p: OperationProfile): string => p.asset.name.replaceAll('/', '-');

/**
 * The step's files: the inputs, a tar on this machine, extracted into the work directory; and the saved plan file of the
 * plan the step applies, as the hopper keeps it.
 */
export interface NeedFiles { inputs?: string; plan?: Buffer }

/** The box's environment: the command, the outputs, the plan the step applies, and the credentials' files and variables. */
export function needEnv(s: { command: string; outputs: readonly string[]; plan?: string; credentials: readonly NeedCredential[] }): Record<string, string> {
  const aws = s.credentials.filter((c): c is NeedCredential & { minted: Extract<Minted, { kind: 'aws' }>; reach: Extract<MintReach, { kind: 'aws' }> } => c.minted.kind === 'aws' && c.reach.kind === 'aws');
  const kube = s.credentials.filter((c): c is NeedCredential & { minted: Extract<Minted, { kind: 'kube' }>; reach: Extract<MintReach, { kind: 'kube' }> } => c.minted.kind === 'kube' && c.reach.kind === 'kube');
  const env: Record<string, string> = { HOPPER_STEP_COMMAND: s.command, HOPPER_STEP_OUTPUTS: s.outputs.join('\n') };
  if (s.plan) env.HOPPER_PLAN = s.plan;
  if (aws.length > 0) {
    env.HOPPER_STEP_AWS_CREDENTIALS = aws.map((c) => `[${credentialName(c.profile)}]\naws_access_key_id = ${c.minted.AccessKeyId}\naws_secret_access_key = ${c.minted.SecretAccessKey}\naws_session_token = ${c.minted.SessionToken}\n`).join('\n');
    env.HOPPER_STEP_AWS_CONFIG = aws.map((c) => `[profile ${credentialName(c.profile)}]\nregion = ${c.reach.region}\n${c.reach.stsEndpoint ? `sts_endpoint_url = ${c.reach.stsEndpoint}\n` : ''}`).join('\n');
    env.AWS_PROFILE = credentialName(aws[0]!.profile);
    env.AWS_REGION = env.AWS_DEFAULT_REGION = aws[0]!.reach.region;
    if (aws.length === 1) {
      const [c] = aws;
      Object.assign(env, { AWS_ACCESS_KEY_ID: c!.minted.AccessKeyId, AWS_SECRET_ACCESS_KEY: c!.minted.SecretAccessKey, AWS_SESSION_TOKEN: c!.minted.SessionToken });
      if (c!.reach.stsEndpoint) env.AWS_ENDPOINT_URL_STS = c!.reach.stsEndpoint;
    }
  }
  if (kube.length > 0) {
    const named = kube.map((c) => ({ name: credentialName(c.profile), c }));
    env.HOPPER_STEP_KUBECONFIG = JSON.stringify({
      apiVersion: 'v1', kind: 'Config', 'current-context': named[0]!.name,
      clusters: named.map(({ name, c }) => ({ name, cluster: { server: c.reach.server, ...(c.reach.certificateAuthorityData ? { 'certificate-authority-data': c.reach.certificateAuthorityData } : {}) } })),
      users: named.map(({ name, c }) => ({ name, user: { token: c.minted.token } })),
      contexts: named.map(({ name, c }) => ({ name, context: { cluster: name, user: name, ...(c.profile.asset.kind === 'namespace' ? { namespace: c.profile.asset.name.split('/')[1] } : {}) } })),
    });
  }
  return env;
}

/** Every credential's secret values: masked in the log the job reads. */
export const needSecrets = (credentials: readonly NeedCredential[]): string[] =>
  credentials.flatMap((c) => (c.minted.kind === 'aws' ? [c.minted.SecretAccessKey, c.minted.SessionToken, c.minted.AccessKeyId] : [c.minted.token]));

/**
 * The script the need box runs: its files waited for (copied) or extracted (in the environment); the credentials into
 * files, out of the environment; the command in the work directory; then the outputs, after the mark. Its exit code is
 * the command's.
 */
export const NEED_BOX_SCRIPT = `umask 077
files="$HOME/${FILES_DIR}"
mkdir -p "$files" "${NEED_WORK_DIR}" || exit 125
case \${HOPPER_STEP_FILES:-} in
  '') ;;
  copy)
    n=0
    while [ ! -e "$files/.ready" ]; do
      n=$((n + 1))
      [ "$n" -le ${FILES_WAIT_S} ] || { echo 'hopper-step: the inputs did not come into the box'; exit 125; }
      sleep 1
    done ;;
  *) printf '%s' "$HOPPER_STEP_FILES" | base64 -d | tar -xf - -C "$HOME" || { echo 'hopper-step: the inputs could not be extracted'; exit 125; } ;;
esac
unset HOPPER_STEP_FILES
if [ -n "\${HOPPER_STEP_AWS_CREDENTIALS:-}" ]; then
  mkdir -p "$HOME/.aws" && printf '%s\\n' "$HOPPER_STEP_AWS_CREDENTIALS" > "$HOME/.aws/credentials" && printf '%s\\n' "$HOPPER_STEP_AWS_CONFIG" > "$HOME/.aws/config" || exit 125
  export AWS_SHARED_CREDENTIALS_FILE="$HOME/.aws/credentials" AWS_CONFIG_FILE="$HOME/.aws/config"
fi
if [ -n "\${HOPPER_STEP_KUBECONFIG:-}" ]; then
  mkdir -p "$HOME/.kube" && printf '%s' "$HOPPER_STEP_KUBECONFIG" > "$HOME/.kube/config" || exit 125
  export KUBECONFIG="$HOME/.kube/config"
fi
unset HOPPER_STEP_AWS_CREDENTIALS HOPPER_STEP_AWS_CONFIG HOPPER_STEP_KUBECONFIG
cd "${NEED_WORK_DIR}" || exit 125
if [ -f "$files/inputs.tar" ]; then
  tar -xf "$files/inputs.tar" || { echo 'hopper-step: the inputs could not be extracted'; exit 125; }
  rm -f "$files/inputs.tar"
fi
[ ! -f "$files/plan" ] || export HOPPER_PLAN_FILE="$files/plan"
umask 022
command=$HOPPER_STEP_COMMAND; outputs=$HOPPER_STEP_OUTPUTS
unset HOPPER_STEP_COMMAND HOPPER_STEP_OUTPUTS
sh -c "$command"
code=$?
cd "${NEED_WORK_DIR}" || exit "$code"
if [ -n "$outputs" ]; then
  set --
  while IFS= read -r o; do [ -n "$o" ] && set -- "$@" "$o"; done <<HOPPER_OUTPUTS
$outputs
HOPPER_OUTPUTS
  printf '\\n${OUTPUTS_MARK}\\n'
  tar -cf - -- "$@" 2>"$HOME/.tar-errors" | base64
  printf '${END_MARK}\\n'
  cat "$HOME/.tar-errors" 2>/dev/null
fi
exit "$code"`;

/** Where the outputs' mark begins, with the line end before it (`\r\n` on the box's terminal); -1: not there. */
const markAt = (text: string): number => /\r?\nHOPPER-STEP-OUTPUTS/.exec(text)?.index ?? -1;

/** The box's output split: what the job reads, and the outputs tar when there was one. */
export function splitOutput(text: string): { log: string; outputs?: Buffer; problem?: string } {
  const at = markAt(text);
  if (at === -1) return { log: text };
  const rest = text.slice(text.indexOf(OUTPUTS_MARK, at) + OUTPUTS_MARK.length);
  const end = rest.indexOf(END_MARK);
  if (end === -1) return { log: text.slice(0, at), problem: 'the outputs did not all come back' };
  const outputs = Buffer.from(rest.slice(0, end).replace(/\s+/g, ''), 'base64');
  const after = rest.slice(end + END_MARK.length).replace(/^\r?\n/, '');
  if (outputs.length > NEED_BOX_OUTPUTS_MAX_BYTES) return { log: text.slice(0, at) + after, problem: `the outputs hold more than ${NEED_BOX_OUTPUTS_MAX_BYTES / (1024 * 1024)} MiB` };
  return { log: text.slice(0, at) + after, outputs };
}

/** The part of the box's output so far that the job may read now: never the outputs, and never a tail that may begin the mark. */
export function shownSoFar(text: string): string {
  const at = markAt(text);
  if (at !== -1) return text.slice(0, at);
  const marks = [`\r\n${OUTPUTS_MARK}`, `\n${OUTPUTS_MARK}`];
  for (let n = Math.min(marks[0]!.length - 1, text.length); n > 0; n--) {
    const tail = text.slice(text.length - n);
    if (marks.some((m) => m.startsWith(tail))) return text.slice(0, text.length - n);
  }
  return text;
}

export interface NeedBox {
  name: string;
  userId: string;
  instanceId: string;
  network: string;
  /**
   * The template's image, its tools, whether it is read-only (its terraform runs through the read-only wrapper), and its
   * limits: the box runs with their defaults (issue #1349).
   */
  template: { image: string; tools?: readonly BoxTool[]; readOnly?: boolean; limits?: TemplateLimits };
  env: Record<string, string>;
  /** Where its credentials reach (issue #849): a read-only box's egress proxy allows their hosts. */
  reaches?: readonly MintReach[];
  timeoutMs: number;
  /** The step's own directory on this machine: the tars of its files are written there. */
  dir: string;
  files?: NeedFiles;
}

/** The tar of the step's files as the box's home takes it: the files' directory, the work directory, the plan file. */
const homeTar = (o: { plan?: Buffer; inputs?: Buffer }): Buffer => filesTar([
  { name: `${FILES_DIR}/`, mode: 0o700 }, { name: 'work/', mode: 0o700 },
  ...(o.plan ? [{ name: `${FILES_DIR}/plan`, data: o.plan, mode: 0o600 }] : []),
  ...(o.inputs ? [{ name: `${FILES_DIR}/inputs.tar`, data: o.inputs, mode: 0o600 }] : []),
]);

/**
 * What a need box came to: the command's exit code, its outputs tar, and the hopper's problem, if any; `stopped`, the
 * hopper stopped it: it ran past its time limit, or the job stopped waiting for it (issue #1371).
 */
export interface NeedBoxResult { exit: number; outputs?: Buffer; problem?: string; stopped?: 'timed-out' | 'cancelled' }

/** How long past the step's time limit the runtime's own wait may take: the hopper's timer ends the step first. */
const WAIT_GRACE_MS = 5000;

/**
 * Runs one need box to its end: its output to `log` as it comes, at most every `pollMs`. `signal` stops it (the job's
 * request gone). Never rejects: a failure of its own is `problem`, exit 125. The box and its volume are removed after it.
 */
export async function runNeedBox(runtime: ContainerRuntime, box: NeedBox, io: { log(chunk: string): void; signal: AbortSignal; pollMs?: number }): Promise<NeedBoxResult> {
  const labels = { [NEED_LABEL]: box.instanceId, [USER_LABEL]: box.userId };
  const volume = `${box.name}-home`;
  let id = '';
  let limit: ReturnType<typeof setTimeout> | undefined;
  let madeHome = false;
  let shown = 0;
  let output = '';
  const show = (text: string): void => {
    const now = shownSoFar(text);
    if (now.length > shown) { io.log(now.slice(shown)); shown = now.length; }
  };
  const files = box.files ?? {};
  const inputsBytes = files.inputs ? statSync(files.inputs).size : 0;
  const planBytes = files.plan?.length ?? 0;
  const copyIn = inputsBytes + planBytes > 0 ? runtime.copyIn?.bind(runtime) : undefined;
  let env = box.env;
  if (copyIn) env = { ...env, HOPPER_STEP_FILES: 'copy' };
  else if (inputsBytes + planBytes > 0) {
    if (inputsBytes + planBytes > NEED_BOX_ENV_FILES_MAX_BYTES) {
      return { exit: 125, problem: `the inputs and the plan file hold ${Math.ceil((inputsBytes + planBytes) / 1024)} KiB: a need box on a machine of the user's takes at most ${NEED_BOX_ENV_FILES_MAX_BYTES / 1024} KiB; one beside the hopper takes more` };
    }
    const inputs = files.inputs && inputsBytes > 0 ? readFileSync(files.inputs) : undefined;
    env = { ...env, HOPPER_STEP_FILES: homeTar({ ...(files.plan ? { plan: files.plan } : {}), ...(inputs ? { inputs } : {}) }).toString('base64') };
  }
  const home = join(box.dir, 'need-home.tar'), ready = join(box.dir, 'need-ready.tar');
  try {
    const { image, user } = await boxImage(runtime, box.template.image, box.template.tools ? [...box.template.tools] : undefined, box.template.readOnly);
    if (!(await runtime.createVolume(volume, labels))) throw staleHome(volume);
    madeHome = true;
    id = await runtime.create({ name: box.name, image, network: box.network, volume, labels, user, env, limits: boxLimits(box.template.limits), script: NEED_BOX_SCRIPT });
    if (io.signal.aborted) return { exit: 125, problem: 'stopped before it started', stopped: 'cancelled' };
    await runtime.start(id);
    if (copyIn) {
      // Copied as the box's user, once it runs; the mark last, so the script never reads a file half there.
      writeFileSync(home, homeTar(files.plan ? { plan: files.plan } : {}), { mode: 0o600 });
      await copyIn(id, HOME, home);
      if (files.inputs && inputsBytes > 0) await copyIn(id, `${HOME}/work`, files.inputs);
      writeFileSync(ready, filesTar([{ name: `${FILES_DIR}/.ready`, data: '', mode: 0o600 }]), { mode: 0o600 });
      await copyIn(id, HOME, ready);
    }
    let ended = false;
    // The hopper's own timer holds the time limit (issue #1371): a runtime's wait that hangs past it ends the step all the same.
    const exited = runtime.wait(id, box.timeoutMs + WAIT_GRACE_MS).finally(() => { ended = true; });
    const stopped = new Promise<'stopped'>((resolve) => { io.signal.addEventListener('abort', () => resolve('stopped'), { once: true }); });
    const timedOut = new Promise<'timed-out'>((resolve) => { limit = setTimeout(() => resolve('timed-out'), box.timeoutMs); });
    const poll = (async () => {
      while (!ended && !io.signal.aborted) {
        await new Promise((r) => setTimeout(r, io.pollMs ?? NEED_POLL_MS));
        if (ended || io.signal.aborted) return;
        output = await runtime.logs(id).catch(() => output);
        show(output);
      }
    })();
    const first = await Promise.race([exited.then((exit) => ({ exit }), (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })), stopped, timedOut]);
    clearTimeout(limit);
    if (first === 'stopped' || first === 'timed-out') {
      ended = true;
      await runtime.stop(id).catch(() => undefined);
      await poll.catch(() => undefined);
      return first === 'stopped'
        ? { exit: 125, problem: 'the job stopped waiting for it', stopped: 'cancelled' }
        : { exit: 125, problem: `the need box did not end in ${box.timeoutMs / 1000} s`, stopped: 'timed-out' };
    }
    await poll.catch(() => undefined);
    if ('error' in first) {
      await runtime.stop(id).catch(() => undefined);
      output = await runtime.logs(id).catch(() => output);
      show(output);
      return { exit: 125, problem: `the need box did not end: ${first.error}` };
    }
    output = await runtime.logs(id).catch(() => output);
    show(output);
    const split = splitOutput(output);
    // What the box wrote after the outputs (a missing output's tar error) goes to the job too.
    const tail = split.log.slice(shownSoFar(output).length);
    if (tail) io.log(tail);
    return { exit: first.exit, ...(split.outputs ? { outputs: split.outputs } : {}), ...(split.problem ? { problem: split.problem } : {}) };
  } catch (e) {
    return { exit: 125, problem: `the need box did not run: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(limit);
    rmSync(home, { force: true });
    rmSync(ready, { force: true });
    if (id) await runtime.remove(id).catch(() => {});
    if (madeHome) await runtime.removeVolume(volume).catch(() => {});
  }
}
