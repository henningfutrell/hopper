// The built-in instances (design.md "Settled in slice 4", "Config documents"): what an absent
// plugins.yaml section means, and what the first boot against an empty store writes as plugins.yaml.
// plugins.yaml is always there after that boot; it is never replaced from here.
import { Document } from 'yaml';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { InstanceSpec } from '../domain/types.ts';
import { PLUGINS } from './plugins-file.ts';
import type { PluginLogger } from './sdk.ts';

/** Every plugins.yaml section the built-in instances fill. */
export interface PluginsDoc {
  queueSorter: InstanceSpec;
  answerer: InstanceSpec;
  assessor: InstanceSpec;
  executors: InstanceSpec[];
  jobSources: InstanceSpec[];
  machines: InstanceSpec;
  usageSources: InstanceSpec[];
  notifiers: InstanceSpec[];
}

/**
 * The built-in instances. Neither GitHub source runs until plugins.yaml names its `authors` (no
 * default); the App also needs its `appId` and key. Secrets come from the environment, named by the options (design.md "Secrets").
 */
export function builtinInstances(answerTimeoutMs = 180_000): PluginsDoc {
  const question = { bin: 'claude', timeoutMs: answerTimeoutMs };
  return {
    queueSorter: { name: 'priority', plugin: 'priority' },
    answerer: { name: 'opus', plugin: 'claude-cli', options: { ...question, model: 'opus' } },
    assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { ...question, model: 'fable' } },
    executors: [
      { name: 'test', plugin: 'test' },
      { name: 'herdr-claude', plugin: 'herdr-claude' },
    ],
    // The names stay `github` and `github-app`: jobs and sync state are keyed by them. The gh CLI is
    // the default (issue #108): `auto` pauses it once this install's own GitHub App key is set.
    jobSources: [
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
      { name: 'github-app', plugin: 'github-app' },
    ],
    machines: { name: 'local', plugin: 'local', options: { lanes: 4 } },
    // Claude subscription usage throttles lanes (issue #18); unavailable where claude is not installed.
    usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: 'claude', intervalSeconds: 600 } }],
    notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine' }],
  };
}

export type EnsureResult = { action: 'kept' | 'default' };

/** Make sure the store holds plugins.yaml: on the boot that finds none, write the built-in instances. */
export function ensurePluginsDocument(o: { documents: ConfigDocuments; answerTimeoutMs: number; logger: PluginLogger }): EnsureResult {
  if (o.documents.read(PLUGINS) !== undefined) return { action: 'kept' };
  const out = new Document({ version: 1, ...builtinInstances(o.answerTimeoutMs) });
  out.commentBefore = ' job-hopper plugins.yaml: which plugin instance fills which role (docs/design.md "Phase 5").\n Written by the daemon from the built-in instances.';
  if (!o.documents.write(PLUGINS, out.toString({ lineWidth: 0 }), 'missing')) return { action: 'kept' };
  o.logger.info(`job-hopper: wrote ${PLUGINS} from the built-in instances. It is the only configuration of every part.`);
  return { action: 'default' };
}
