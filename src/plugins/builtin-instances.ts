// The built-in instances (design.md "Settled in slice 4", "Config documents"): what an absent
// plugins.yaml section means, and what the first boot against an empty store writes as plugins.yaml.
// plugins.yaml is always there after that boot; it is never replaced from here.
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { InstanceSpec } from '../domain/types.ts';
import { PLUGINS } from './plugins-file.ts';
import type { PluginLogger } from './sdk.ts';

/** Every plugins.yaml section the built-in instances fill. */
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
 * The built-in instances. Neither GitHub source runs until plugins.yaml names its `authors` (no
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
 * Make sure the store holds plugins.yaml: on the boot that finds none, write the built-in instances.
 * Where this host is not a machine (`localMachine` false), remove every `local` instance from
 * `machines:` — one an earlier boot of the container wrote (issue #141); every other line is kept.
 */
export function ensurePluginsDocument(o: { documents: ConfigDocuments; answerTimeoutMs: number; localMachine?: boolean; herdrSession?: string; logger: PluginLogger }): EnsureResult {
  const localMachine = o.localMachine ?? true;
  const version = o.documents.version(PLUGINS);
  const text = o.documents.read(PLUGINS);
  if (text !== undefined) return localMachine ? { action: 'kept' } : removeLocalMachines(o.documents, text, version, o.logger);
  const out = new Document({ version: 1, ...builtinInstances(o.answerTimeoutMs, localMachine, o.herdrSession) });
  out.commentBefore = ' hopper plugins.yaml: which plugin instance fills which role (docs/design.md "Phase 5").\n Written by the daemon from the built-in instances.';
  if (!o.documents.write(PLUGINS, out.toString({ lineWidth: 0 }), 'missing')) return { action: 'kept' };
  o.logger.info(`hopper: wrote ${PLUGINS} from the built-in instances. It is the only configuration of every part.`);
  return { action: 'default' };
}

function removeLocalMachines(documents: ConfigDocuments, text: string, version: string, logger: PluginLogger): EnsureResult {
  const doc = parseDocument(text);
  const machines = doc.get('machines', true);
  if (doc.errors.length > 0 || !isSeq(machines)) return { action: 'kept' };
  const removed: string[] = [];
  machines.items = machines.items.filter((m) => {
    if (!isMap(m) || m.get('plugin') !== 'local') return true;
    removed.push(String(m.get('name')));
    return false;
  });
  if (removed.length === 0) return { action: 'kept' };
  if (!documents.write(PLUGINS, doc.toString({ lineWidth: 0 }), version)) return { action: 'kept' };
  for (const name of removed) logger.info(`hopper: removed the machine \`${name}\` from ${PLUGINS}: this host is not a machine (HOPPER_LOCAL_MACHINE=false).`);
  return { action: 'removed-local' };
}
