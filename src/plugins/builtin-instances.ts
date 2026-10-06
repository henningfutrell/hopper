// The built-in instances (design.md "Settled in slice 4", "Config in the database"): what an absent
// section of the plugins config means, and what the first boot against an empty store writes as it.
// The plugins config is always there after that boot; it is never replaced from here.
import type { ConfigRecords } from '../domain/ports.ts';
import type { InstanceSpec } from '../domain/types.ts';
import { PLUGINS } from './plugins-config.ts';
import type { PluginLogger } from './sdk.ts';

/** Every section of the plugins config the built-in instances fill. */
export interface PluginsDoc {
  queueSorter: InstanceSpec;
  escalationLevels: InstanceSpec[];
  executors: InstanceSpec[];
  jobSources: InstanceSpec[];
  machines: InstanceSpec[];
  usageSources: InstanceSpec[];
  notifiers: InstanceSpec[];
}

/**
 * The built-in instances. Neither GitHub source runs until the plugins config names its `authors` (no
 * default); the App also needs its `appId` and key. Secrets come from the environment, named by the options (design.md "Secrets").
 * `herdrSession`: a user's own herdr session (issue #158), named on the herdr-claude instance; absent: the plugin's default.
 */
export function builtinInstances(answerTimeoutMs = 180_000, localMachine = true, herdrSession?: string): PluginsDoc {
  // A part that runs on a machine names it (issue #174): this one, as the `local` machine; none where
  // this host is no machine, until one is picked.
  const here = localMachine ? { machine: 'local' } : {};
  const question = { ...here, bin: 'claude', timeoutMs: answerTimeoutMs };
  return {
    queueSorter: { name: 'priority', plugin: 'priority' },
    // Lowest first: Opus answers what it can settle, Fable what Opus escalates; then the owner.
    escalationLevels: [
      { name: 'opus', plugin: 'claude-cli', options: { ...question, model: 'opus' } },
      { name: 'fable', plugin: 'claude-cli', options: { ...question, model: 'fable' } },
    ],
    executors: [
      { name: 'test', plugin: 'test' },
      { name: 'herdr-claude', plugin: 'herdr-claude', ...(herdrSession ? { options: { session: herdrSession } } : {}) },
    ],
    // The names stay `github` and `github-app`: jobs and sync state are keyed by them. The gh CLI is
    // the default (issue #108): `auto` pauses it once this install's own GitHub App key is set.
    jobSources: [
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
      { name: 'github-app', plugin: 'github-app' },
    ],
    // This machine; attached machines are added beside it (issue #74). None where this host is not
    // a machine (the container, issue #141).
    machines: localMachine ? [{ name: 'local', plugin: 'local', options: { lanes: 4 } }] : [],
    // Claude subscription usage throttles lanes (issue #18); unavailable where claude is not installed.
    usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { ...here, bin: 'claude', intervalSeconds: 600 } }],
    notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine' }],
  };
}

export type EnsureResult = { action: 'kept' | 'default' | 'removed-local' };

/**
 * Make sure the store holds the plugins config: on the boot that finds none, write the built-in
 * instances. Where this host is not a machine (`localMachine` false), remove every `local` instance
 * from `machines` — one an earlier boot of the container wrote (issue #141); everything else is kept.
 */
export function ensurePluginsConfig(o: { config: ConfigRecords; answerTimeoutMs: number; localMachine?: boolean; herdrSession?: string; logger: PluginLogger }): EnsureResult {
  const localMachine = o.localMachine ?? true;
  const version = o.config.version(PLUGINS);
  const value = o.config.read(PLUGINS);
  if (value !== undefined) return localMachine ? { action: 'kept' } : removeLocalMachines(o.config, value, version, o.logger);
  if (!o.config.write(PLUGINS, { version: 1, ...builtinInstances(o.answerTimeoutMs, localMachine, o.herdrSession) }, 'missing')) return { action: 'kept' };
  o.logger.info('hopper: wrote the plugins config from the built-in instances. It is the only configuration of every part; edit it in the UI.');
  return { action: 'default' };
}

function removeLocalMachines(config: ConfigRecords, value: unknown, version: string, logger: PluginLogger): EnsureResult {
  const machines = (value as { machines?: unknown } | null)?.machines;
  if (!Array.isArray(machines)) return { action: 'kept' };
  const isLocal = (m: unknown): m is { name: unknown } => typeof m === 'object' && m !== null && (m as { plugin?: unknown }).plugin === 'local';
  const removed = machines.filter(isLocal).map((m) => String(m.name));
  if (removed.length === 0) return { action: 'kept' };
  if (!config.write(PLUGINS, { ...(value as object), machines: machines.filter((m) => !isLocal(m)) }, version)) return { action: 'kept' };
  for (const name of removed) logger.info(`hopper: removed the machine \`${name}\` from the plugins config: this host is not a machine (HOPPER_LOCAL_MACHINE=false).`);
  return { action: 'removed-local' };
}
