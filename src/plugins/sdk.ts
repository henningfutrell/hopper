// The plugin SDK: every type a plugin is written against (design.md "Plugin contract").
// Out-of-tree plugins import it type-only as `job-hopper/plugin` (package.json `exports`), which
// type stripping erases, so a plugin needs nothing of job-hopper at runtime. Types only here.
import type { z } from 'zod';
import type { AnswerDraft, AnswerRequest, Answerer, Assessment, Assessor, Clock, Router } from '../domain/ports.ts';
import type { Advice, AdviceAction, Detection, Job, Question, QuestionAttempt, Role, RouterMode } from '../domain/types.ts';

export type {
  Advice, AdviceAction, AnswerDraft, AnswerRequest, Answerer, Assessment, Assessor, Clock, Detection, Job, Question,
  QuestionAttempt, Role, Router, RouterMode,
};

/** What `detect` may use. Cheap; never a paid model call; never runs a GUI binary. */
export interface DetectionKit {
  /** Absolute path of an executable on PATH (or the path itself if absolute and executable). */
  which(bin: string): Promise<string | undefined>;
  /** First line of `bin args` stdout (default `--version`), or undefined on failure or after 5 s. CLIs only. */
  version(bin: string, args?: string[]): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  /** Whether `python -c "import <module>"` succeeds. */
  pythonImports(python: string, module: string): Promise<boolean>;
  env(name: string): string | undefined;
}

export interface PluginLogger {
  info(line: string): void;
  warn(line: string): void;
}

/** Given to every plugin's `create`. */
export interface PluginContext {
  clock: Clock;
  logger: PluginLogger;
  /** job-hopper's data dir (next to its database). */
  dataDir: string;
  /** This plugin's own scratch dir (`<dataDir>/plugin-data/<id>`), created before `create`. */
  scratchDir: string;
}

/**
 * What each role's `create` returns. The core names the instance after plugins.yaml (`name` is
 * overridden), validates every answerer draft and assessor result, and fails closed on them.
 */
export interface RoleInstance {
  router: Router;
  answerer: Answerer;
  assessor: Assessor;
}

/** What each role adds to the context. The router passes job-hopper's router mode on (Jev reads it). */
export interface RoleContext {
  router: { routerMode(): RouterMode };
  answerer: object;
  assessor: object;
}

/** The zod the core passes to `options` — authors need not import zod. */
export type Zod = typeof z;

/**
 * One plugin: one ES module whose default export is this. `O` is the validated options type;
 * with `satisfies PluginDefinition<'router'>` it is inferred loosely (`any`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- options are whatever the plugin's own schema says
export interface PluginDefinition<R extends Role = Role, O = any> {
  /** Unique; a custom id equal to a built-in id is refused. Lowercase, digits, dashes. */
  id: string;
  role: R;
  /** One line for /api/plugins and the UI. */
  describe: string;
  /** Options schema built from the core's zod. Absent → no options. Validated before detect and create. */
  options?: (z: Zod) => z.ZodType<O>;
  /** Can it run here, with these options? */
  detect(sys: DetectionKit, options: O): Promise<Detection>;
  create(ctx: PluginContext & RoleContext[R], options: O): RoleInstance[R] | Promise<RoleInstance[R]>;
}
