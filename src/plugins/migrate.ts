// plugins.yaml is always there (design.md "Settled in slice 4"). On a boot that finds none, the
// daemon builds it from what configured the parts before: sources.yaml (folded into
// `jobSources[].options`, comments kept) and the part-choosing env vars removed in slice 4, read
// here one last time. With neither, the same builder gives the built-in instances. The file is
// written mode 600 without ever replacing one (link, not rename), then sources.yaml becomes
// sources.yaml.migrated. The host's built-in instances for an absent section come from here too —
// so a plugins.yaml written before a section existed (slice 5's `notifiers`) gets that section's
// built-in instances, never nothing.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Document, isMap, parseDocument, type Node } from 'yaml';
import { z } from 'zod';
import type { InstanceSpec } from '../domain/types.ts';
import { expandHome } from './expand-home.ts';
import type { PluginLogger } from './sdk.ts';

const int = (min: number) => z.coerce.number().int().min(min);
const executorList = z.string().transform((s, ctx) => {
  const names = [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
  if (names.length === 0) ctx.addIssue({ code: 'custom', message: 'name at least one executor' });
  return names;
});

/** The removed variables, with the rules and defaults they had in src/config.ts before slice 4 (GROKBOT: slice 5). */
const LEGACY = z.object({
  JOB_HOPPER_EXECUTORS: executorList.default(['test', 'herdr-claude']),
  JOB_HOPPER_HERDR_BIN: z.string().min(1).default('herdr'),
  JOB_HOPPER_HERDR_SESSION: z.string().min(1).refine((s) => s !== 'default', 'must not be the default herdr session').default('job-hopper'),
  JOB_HOPPER_HERDR_POLL_MS: int(1).default(1000),
  JOB_HOPPER_CLAUDE_BIN: z.string().min(1).default('claude'),
  JOB_HOPPER_CLAUDE_ARGS: z.string().transform((s) => s.split(/\s+/).filter(Boolean)).default(['--dangerously-skip-permissions']),
  JOB_HOPPER_CLAUDE_CWD: z.string().min(1).default('~/workbench/app-workflows'),
  JOB_HOPPER_TRUST_WORKDIR: z.enum(['true', 'false']).transform((v) => v === 'true').default(true),
  JOB_HOPPER_IDLE_QUESTION_MS: int(1).default(20000),
  JOB_HOPPER_ANSWER_MODEL_A: z.string().min(1).default('opus'),
  JOB_HOPPER_ANSWER_MODEL_B: z.string().min(1).default('fable'),
  JOB_HOPPER_LOCAL_LANES: int(0).default(4),
  JOB_HOPPER_GH_BIN: z.string().min(1).default('gh'),
  JOB_HOPPER_GITHUB_API: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, '')).optional(),
  JOB_HOPPER_SOURCES_FILE: z.string().min(1).transform(expandHome).optional(),
  JOB_HOPPER_GROKBOT_WEBHOOK_FILE: z.string().min(1).optional(),
});
type Legacy = z.output<typeof LEGACY>;

/** Every plugins.yaml section the builder writes. */
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

type Block = Record<string, unknown>;

/**
 * The sections from the legacy settings and sources.yaml's two blocks (undefined: no block).
 * `configDir`: plugins.yaml's dir (the Grok Bot env file's default home); `sourcesDir`: sources.yaml's.
 */
function buildDoc(e: Legacy, answerTimeoutMs: number, configDir: string, sourcesDir: string, blocks: { github?: Block; githubApp?: Block }): PluginsDoc {
  const question = { bin: e.JOB_HOPPER_CLAUDE_BIN, timeoutMs: answerTimeoutMs };
  const app = blocks.githubApp;
  const appFile = typeof app?.appFile === 'string' ? app.appFile : join(sourcesDir, 'github-app.json');
  return {
    queueSorter: { name: 'priority', plugin: 'priority' },
    answerer: { name: 'opus', plugin: 'claude-cli', options: { ...question, model: e.JOB_HOPPER_ANSWER_MODEL_A } },
    assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { ...question, model: e.JOB_HOPPER_ANSWER_MODEL_B } },
    executors: e.JOB_HOPPER_EXECUTORS.map((name) => (name === 'herdr-claude' ? {
      name, plugin: name, options: {
        bin: e.JOB_HOPPER_HERDR_BIN, claudeBin: e.JOB_HOPPER_CLAUDE_BIN, session: e.JOB_HOPPER_HERDR_SESSION, args: e.JOB_HOPPER_CLAUDE_ARGS,
        cwd: e.JOB_HOPPER_CLAUDE_CWD, trustWorkdir: e.JOB_HOPPER_TRUST_WORKDIR, pollMs: e.JOB_HOPPER_HERDR_POLL_MS,
        idleQuestionMs: e.JOB_HOPPER_IDLE_QUESTION_MS,
      },
    } : { name, plugin: name })),
    // The names stay `github` and `github-app`: jobs and sync state are keyed by them. No `github:`
    // block meant no gh source; the gh source paused for the app file only while the app was on.
    jobSources: [
      { name: 'github', plugin: 'github-gh', options: {
        ...(blocks.github ?? { enabled: false }), bin: e.JOB_HOPPER_GH_BIN, appFile: app?.enabled === false ? null : appFile,
      } },
      { name: 'github-app', plugin: 'github-app', options: {
        ...app, appFile, ...(e.JOB_HOPPER_GITHUB_API ? { apiUrl: e.JOB_HOPPER_GITHUB_API } : {}),
      } },
    ],
    machines: { name: 'local', plugin: 'local', options: { lanes: e.JOB_HOPPER_LOCAL_LANES } },
    usageSources: [],
    notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: e.JOB_HOPPER_GROKBOT_WEBHOOK_FILE ?? join(configDir, 'grokbot-webhook.env') } }],
  };
}

/** The built-in instances: what a boot with nothing to migrate writes, and what an absent section means. */
export function builtinInstances(configDir: string, answerTimeoutMs = 180_000): PluginsDoc {
  return buildDoc(LEGACY.parse({}), answerTimeoutMs, configDir, configDir, {});
}

function legacyOf(env: Record<string, string>): Legacy {
  const known = Object.fromEntries(Object.entries(env).filter(([k]) => k in LEGACY.shape));
  const r = LEGACY.safeParse(known);
  if (!r.success) throw new Error(`cannot write plugins.yaml from the env: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** sources.yaml as a YAML document (comments kept), or undefined when there is none. Throws when it does not parse. */
function readSources(path: string): Document | undefined {
  if (!existsSync(path)) return undefined;
  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`cannot fold ${path} into plugins.yaml: ${doc.errors[0]!.message}; fix or remove it`);
  if (!isMap(doc.contents)) throw new Error(`cannot fold ${path} into plugins.yaml: not a mapping; fix or remove it`);
  return doc;
}

/** sources.yaml keys no option carries any more: `progressCommentSeconds` (no progress comment since 2026-10-03). */
const DROPPED_KEYS = ['progressCommentSeconds'];

/**
 * A block of sources.yaml: its plain value, and its node (to keep its comments), without the
 * dropped keys. Throws when it is not a mapping.
 */
function blockOf(doc: Document | undefined, key: string, path: string): { value?: Block; node?: Node } {
  const node = doc?.get(key, true) as Node | undefined;
  if (node === undefined || node === null) return {};
  if (!isMap(node)) throw new Error(`cannot fold ${path} into plugins.yaml: ${key} is not a mapping; fix or remove it`);
  for (const k of DROPPED_KEYS) node.delete(k);
  return { value: node.toJSON() as Block, node };
}

/** The document to write: the built sections, with sources.yaml's own nodes as the job sources' options. */
function render(doc: PluginsDoc, nodes: (Node | undefined)[], origin: string): string {
  const out = new Document({ version: 1, ...doc });
  out.commentBefore = ` job-hopper plugins.yaml: which plugin instance fills which role (docs/design.md "Phase 5").\n Written by the daemon from ${origin}.`;
  nodes.forEach((node, i) => {
    if (!node || !isMap(node)) return;
    const options = doc.jobSources[i]!.options!;
    for (const [k, v] of Object.entries(options)) if (!node.has(k)) node.set(k, v);
    out.setIn(['jobSources', i, 'options'], node);
  });
  return out.toString({ lineWidth: 0 });
}

/** Write `text` to `path` mode 600, failing (never replacing) if `path` exists meanwhile. */
function writeNew(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
}

export type EnsureResult = { action: 'kept' } | { action: 'migrated' | 'default'; renamed: string[] };

/**
 * Make sure plugins.yaml exists. `env`: the JOB_HOPPER_* variables the config no longer reads;
 * `answerTimeoutMs`: the question stage ceiling, the claude plugins' timeout before slice 4.
 * Throws, writing nothing, when sources.yaml does not parse or a removed variable is invalid.
 */
export function ensurePluginsFile(o: { pluginsFile: string; env: Record<string, string>; answerTimeoutMs: number; logger: PluginLogger }): EnsureResult {
  if (existsSync(o.pluginsFile)) return { action: 'kept' };
  const legacy = legacyOf(o.env);
  const sourcesFile = legacy.JOB_HOPPER_SOURCES_FILE ?? join(dirname(o.pluginsFile), 'sources.yaml');
  const sources = readSources(sourcesFile);
  const github = blockOf(sources, 'github', sourcesFile);
  const githubApp = blockOf(sources, 'githubApp', sourcesFile);
  const doc = buildDoc(legacy, o.answerTimeoutMs, dirname(o.pluginsFile), dirname(sourcesFile), { ...(github.value ? { github: github.value } : {}), ...(githubApp.value ? { githubApp: githubApp.value } : {}) });
  const fromEnv = Object.keys(o.env).filter((k) => k in LEGACY.shape);
  const migrated = sources !== undefined || fromEnv.length > 0;
  const origin = migrated ? [sources ? sourcesFile : '', fromEnv.length ? `the env (${fromEnv.sort().join(', ')})` : ''].filter(Boolean).join(' and ') : 'the built-in defaults';
  writeNew(o.pluginsFile, render(doc, [github.node, githubApp.node], origin));
  const renamed: string[] = [];
  if (sources) {
    const target = existsSync(`${sourcesFile}.migrated`) ? `${sourcesFile}.migrated-${Date.now()}` : `${sourcesFile}.migrated`;
    renameSync(sourcesFile, target);
    renamed.push(target);
  }
  (migrated ? o.logger.warn : o.logger.info)(`job-hopper: wrote ${o.pluginsFile} (mode 600) from ${origin}${renamed.length ? `; ${sourcesFile} renamed ${renamed[0]}` : ''}. It is now the only configuration of every part.`);
  return { action: migrated ? 'migrated' : 'default', renamed };
}
