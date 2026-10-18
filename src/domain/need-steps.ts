// The need steps kept (issue #1524, issue #1568; design.md "Need steps", "Sagas: work that survives a stop"): each need
// step and box step a job asks for, kept in the database from the ask to its result, so that it does not live in the
// job's request or in one hopper's memory. The job asks with a key of its own: the same ask sent again is the same step,
// never a second one. A `need-step` saga runs it; its log, its result and its outputs are read from here by the job,
// from any host, after a restart too.
import type { OperationProfile } from './access.ts';
import type { BoxTool, TemplateLimits } from './sandboxes.ts';
import type { StepResult } from './windows-steps.ts';

/** The template a step runs in, as it was when the job asked: what its need box is made of. */
/** The template a step runs in, as it was when the step was asked for; `egress`: its approved egress hosts (issue #1875). */
export interface NeedStepTemplate { name: string; image: string; tools?: BoxTool[]; egress?: string[]; readOnly?: true; limits?: TemplateLimits }

export interface NeedStep {
  id: string;
  userId: string;
  jobId: string;
  /** The job's key for the ask: one step per job and key. */
  key: string;
  /** The saga that runs it, once it is begun. */
  saga?: string;
  /** The need box's container name (`hopper-need-…`): the vault's mints for the step are bound to it. */
  box: string;
  template: NeedStepTemplate;
  /** What the step is minted: each profile, for this step only. */
  needs: OperationProfile[];
  command: string;
  timeoutSeconds: number;
  outputs: string[];
  /** The approved infra plan the step applies. */
  plan?: string;
  /** A box step's vault secrets, by name (issue #1875): those its template gives, read for the step after the job's vault grant. */
  secrets?: string[];
  inputsBytes: number;
  createdAt: string;
  /** Its result, once it ended: it ran, it was refused, cancelled, or a hopper stopped while it ran. */
  result?: StepResult;
  endedAt?: string;
}

/** The need steps, in the instance's `need_steps` table. */
export interface NeedStepRepository {
  /** Keeps a new step with its inputs; a step of the same job and key kept already is answered instead, unchanged. */
  add(step: NeedStep, inputs: Buffer): NeedStep;
  get(id: string): NeedStep | undefined;
  /** Names the saga that runs the step. */
  sagaIs(id: string, saga: string): void;
  /** The inputs the job sent; undefined: none, or the step ended. */
  inputs(id: string): Buffer | undefined;
  /** Adds to the step's log, until it holds NEED_STEP_LOG_MAX characters. */
  appendLog(id: string, text: string): void;
  /** The log from character `from`, and where the next read starts. */
  log(id: string, from: number): { text: string; next: number };
  /**
   * The step ended: its result and its outputs are kept, its inputs dropped. Only a step not ended yet: whether this end
   * is the one kept.
   */
  end(id: string, result: StepResult, at: string, outputs?: Buffer): boolean;
  outputs(id: string): Buffer | undefined;
  /** Removes the steps that ended before `before`. */
  sweep(before: string): void;
}

/** The most of a step's log the database keeps: more is cut, and the log says so. */
export const NEED_STEP_LOG_MAX = 4 * 1024 * 1024;

/** A job's key for an ask: 8 to 64 letters, digits, `-` or `_`. */
export const NEED_STEP_KEY = /^[A-Za-z0-9_-]{8,64}$/;
