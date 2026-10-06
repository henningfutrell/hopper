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
 * The built-in instances. A connected account's source reads its own issues once the user connects it
 * (issue #214). The gh source does not run until the plugins config names its `authors` (no default). Secrets come from the environment, named by the options (design.md "Secrets").
 * The herdr-claude instance names no session: every user's jobs run in the supervised `hopper` session (issue #261).
 */
export function builtinInstances(answerTimeoutMs = 180_000, localMachine = true): PluginsDoc {
  // A part that runs on a machine names it (issue #174): this one, as the `local` machine; none where
  // this host is no machine, until one is picked.
  const here = localMachine ? { machine: 'local' } : {};
  const question = { ...here, bin: 'claude', timeoutMs: answerTimeoutMs };
  return {
    queueSorter: { name: 'priority', plugin: 'priority' },
    // Lowest first: level 1 (Opus) answers what it can settle, level 2 (Fable) what level 1
    // escalates; then the owner. Named as levels, never after a model (issue #209).
    escalationLevels: [
      { name: 'level-1', plugin: 'claude-cli', options: { ...question, model: 'opus' } },
      { name: 'level-2', plugin: 'claude-cli', options: { ...question, model: 'fable' } },
    ],
    executors: [
      { name: 'test', plugin: 'test' },
      { name: 'herdr-claude', plugin: 'herdr-claude' },
    ],
    // The GitHub account the user signs in with or connects (issue #214), paused until it is connected. The gh CLI (issue #108), named `github` (jobs and sync state are keyed by it), is
    // paused by `auto` while a GitHub account is connected. The app-as-itself source (`github-app`, an
    // admin's own GitHub App and its private key) is no built-in: an admin adds it where it suits.
    jobSources: [
      { name: 'github-account', plugin: 'github-account' },
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
    ],
    // This machine; attached machines are added beside it (issue #74). None where this host is not
    // a machine (the container, issue #141).
    machines: localMachine ? [{ name: 'local', plugin: 'local', options: { lanes: 4 } }] : [],
    // Claude subscription usage throttles lanes (issue #18); unavailable where claude is not installed.
    usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { ...here, bin: 'claude', intervalSeconds: 600 } }],
    notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine' }],
  };
}

export type EnsureResult = { action: 'kept' | 'default' | 'removed-local' | 'removed-user-session' };

/**
 * Make sure the store holds the plugins config: on the boot that finds none, write the built-in
 * instances. Where this host is not a machine (`localMachine` false), remove every `local` instance
 * from `machines` — one an earlier boot of the container wrote (issue #141). For `userId`, remove the
 * `hopper-<userId>` session an earlier boot wrote on a herdr-claude instance (issue #261); everything else is kept.
 */
export function ensurePluginsConfig(o: { config: ConfigRecords; answerTimeoutMs: number; localMachine?: boolean; userId?: string; logger: PluginLogger }): EnsureResult {
  const localMachine = o.localMachine ?? true;
  const value = o.config.read(PLUGINS);
  if (value !== undefined) {
    const session = o.userId === undefined ? { action: 'kept' as const } : removeUserSession(o.config, value, o.config.version(PLUGINS), o.userId, o.logger);
    if (localMachine) return session;
    const local = removeLocalMachines(o.config, o.config.read(PLUGINS), o.config.version(PLUGINS), o.logger);
    return local.action === 'kept' ? session : local;
  }
  if (!o.config.write(PLUGINS, { version: 1, ...builtinInstances(o.answerTimeoutMs, localMachine) }, 'missing')) return { action: 'kept' };
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

/** The per-user session an earlier boot wrote (`hopper-<id>`, issue #158) is dropped: the instance runs in the plugin's default, `hopper` (issue #261). */
function removeUserSession(config: ConfigRecords, value: unknown, version: string, userId: string, logger: PluginLogger): EnsureResult {
  const executors = (value as { executors?: unknown } | null)?.executors;
  if (!Array.isArray(executors)) return { action: 'kept' };
  const written = `hopper-${userId}`;
  const isWritten = (e: unknown): e is { name: unknown; options: Record<string, unknown> } => typeof e === 'object' && e !== null
    && (e as { plugin?: unknown }).plugin === 'herdr-claude' && (e as { options?: { session?: unknown } }).options?.session === written;
  const fixed = executors.filter(isWritten).map((e) => String(e.name));
  if (fixed.length === 0) return { action: 'kept' };
  const next = executors.map((e) => {
    if (!isWritten(e)) return e;
    const { session: _session, ...options } = e.options;
    const { options: _options, ...rest } = e;
    return Object.keys(options).length > 0 ? { ...rest, options } : rest;
  });
  if (!config.write(PLUGINS, { ...(value as object), executors: next }, version)) return { action: 'kept' };
  for (const name of fixed) logger.info(`hopper: the executor \`${name}\` no longer names the session \`${written}\`; its jobs run in the supervised herdr session \`hopper\`.`);
  return { action: 'removed-user-session' };
}
