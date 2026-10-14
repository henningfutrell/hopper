// The stack against the compose file of this version (issue #697, design.md "Self-update"): a container hopper compares the
// stack it runs in with the compose file its own image ships with — each service that must run (no profile, or a profile
// COMPOSE_PROFILES turns on; not a one-shot), the settings the file gives the hopper's container, and the version of the
// vault in its own container. An update that recreated the hopper service alone on an old compose.yaml leaves exactly
// these gaps. Each is named with what it turns off; the one fix is the update's compose commands (issue #970).
import { parse } from 'yaml';
import type { StackProbe } from '../domain/ports.ts';

export type { StackProbe };
import type { InstallKind, StackDrift, StackGap } from '../domain/types.ts';
import { readInstallInfo } from './install.ts';
import { readShippedCompose } from './shipped-compose.ts';
import { PUBLISHED_IMAGE, updateCommands, updateLines } from './update-commands.ts';

interface ComposeService {
  profiles?: unknown;
  restart?: unknown;
  environment?: unknown;
}

/** What does not work while a service is missing, for the services the hopper needs. */
const OFF: Record<string, string> = {
  openfga: 'Access checks: every credential a job asks for is denied, and settings that need them (the TypeSafe API key) cannot be saved',
  'hopper-vault': 'the vault: secrets cannot be read, set or given to jobs',
  kms: 'the vault\'s KMS: secrets sealed under its data key cannot be opened',
  vault: 'secrets kept in the HashiCorp Vault vault backend',
  tunnel: 'remote access: the ngrok tunnel set in Settings → Remote access does not start',
  cloudflared: 'remote access: the Cloudflare tunnel set in Settings → Remote access does not start',
  solr: 'search: jobs cannot be searched until Solr runs; the index catches up by itself then',
};

/** A service restarted only when it fails runs once and exits (openfga-migrate): no name on the network once it is done. */
const ONE_SHOT = 'on-failure';

const short = (commit: string): string => commit.slice(0, 7);

function servicesOf(compose: string): Record<string, ComposeService> {
  const s = (parse(compose) as { services?: unknown } | null)?.services;
  return s && typeof s === 'object' ? (s as Record<string, ComposeService>) : {};
}

/** The names a service's `environment` sets, from compose's map or list form. */
function envNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item).split('=')[0]!).filter(Boolean);
  return raw && typeof raw === 'object' ? Object.keys(raw) : [];
}

/** The services of `compose` that must run now: the hopper excepted, each with no profile or one COMPOSE_PROFILES turns on. */
function mustRun(services: Record<string, ComposeService>, profilesOn: Set<string>): string[] {
  return Object.entries(services).filter(([name, s]) => {
    if (name === 'hopper' || s?.restart === ONE_SHOT) return false;
    const profiles = Array.isArray(s?.profiles) ? s.profiles.map(String) : [];
    return profiles.length === 0 || profiles.some((p) => profilesOn.has(p));
  }).map(([name]) => name);
}

/**
 * How the stack differs from `compose`, the compose file of this version. `env` is the hopper's own environment (compose
 * passes .env into it, COMPOSE_PROFILES too); `commit`, the hopper's. Unchecked, with the reason, unless it is an image.
 */
export async function checkStack(o: { kind: InstallKind | undefined; compose: string | undefined; commit: string | undefined; env: Record<string, string | undefined>; probe: StackProbe }): Promise<StackDrift> {
  if (o.kind !== 'image') return { state: 'unchecked', reason: 'not a container install: the stack is the one the person runs', gaps: [] };
  if (o.compose === undefined) return { state: 'unchecked', reason: 'this build ships no compose file to compare with', gaps: [] };
  const services = servicesOf(o.compose);
  const profilesOn = new Set((o.env.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim()).filter(Boolean));
  const gaps: StackGap[] = [];
  const running = new Set<string>();
  for (const name of mustRun(services, profilesOn)) {
    if (await o.probe.resolves(name)) { running.add(name); continue; }
    gaps.push({ kind: 'service', name, what: `the service ${name} is not running in this stack`, ...(OFF[name] ? { off: OFF[name] } : {}) });
  }
  const missing = envNames(services.hopper?.environment).filter((k) => o.env[k] === undefined);
  if (missing.length) {
    gaps.push({ kind: 'setting', name: missing.join(', '), what: `the hopper's container lacks settings the compose file of this version gives it: it was started from an older compose.yaml` });
  }
  if (running.has('hopper-vault') && o.commit) {
    const vault = await o.probe.vaultCommit();
    if (vault === null) gaps.push({ kind: 'version', name: 'hopper-vault', what: 'hopper-vault does not say its version: it runs an older image than the hopper' });
    else if (vault !== o.commit) gaps.push({ kind: 'version', name: 'hopper-vault', what: `hopper-vault runs ${short(vault)}, the hopper ${short(o.commit)}` });
  }
  return { state: 'checked', gaps };
}

/**
 * The drift check of this hopper (the composition root's): the compose file `appDir` ships with against the stack, and the
 * image the fix names — HOPPER_IMAGE the hopper was started with, else the published image of install.json's branch.
 */
export function createStackDrift(o: { appDir: string; env: Record<string, string | undefined>; probe: StackProbe }): () => Promise<StackDrift> {
  return async () => {
    const { known } = readInstallInfo(o.appDir);
    const shipped = readShippedCompose(o.appDir);
    const drift = await checkStack({ kind: known.kind, compose: shipped.ok ? shipped.shipped.compose : undefined, commit: known.commit, env: o.env, probe: o.probe });
    const image = o.env.HOPPER_IMAGE || (known.branch ? `${PUBLISHED_IMAGE}:${known.branch}` : undefined);
    return drift.gaps.length && image ? { ...drift, image } : drift;
  };
}

/** The drift check, run once now: a drifted stack is logged at start, with the fix. */
export function startStackDrift(o: Parameters<typeof createStackDrift>[0] & { logger: { warn(line: string): void } }): () => Promise<StackDrift> {
  const check = createStackDrift(o);
  void check().then((d) => { const line = driftLine(d); if (line) o.logger.warn(line); }, (e: Error) => o.logger.warn(`hopper: the stack was not compared with its compose file: ${e.message}`));
  return check;
}

/** The log line of a drifted stack; undefined when nothing differs. */
export const driftLine = (d: StackDrift): string | undefined => (d.gaps.length === 0 ? undefined
  : `hopper: the stack differs from the compose file of this version: ${d.gaps.map((g) => g.what).join('; ')}. Fix: update the whole stack (docs/deploy.md "Update")${d.image ? `: ${updateLines(updateCommands('podman', d.image)).join(' ; ')}` : ''}`);
