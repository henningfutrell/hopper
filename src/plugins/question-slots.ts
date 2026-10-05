// The question roles' slots (design.md "Question pipeline", "Failure"): the answerer (0..1) and the
// assessor (1). Both are live: the host swaps the built instance and the question service looks it
// up per question. An answerer that cannot run is no answerer (questions go to the human); an
// assessor that cannot run is always-escalate (fail safe). The instance is named after
// plugins.yaml whatever the plugin calls itself: that name is the question's stage.
import type { AnswerDraft, AnswerRequest, Answerer, Assessment, Assessor } from '../domain/ports.ts';
import type { Detection, InstanceSpec, QuestionRoleStatus } from '../domain/types.ts';
import alwaysEscalate from './assessor/always-escalate/index.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';

export interface BuiltAnswerer {
  /** null: none configured. */
  spec: InstanceSpec | null;
  /** Absent: none configured, or it cannot run. */
  answerer?: Answerer;
  detection?: Detection;
  /** Why the configured answerer cannot run. */
  fallback?: string;
  plugin: string | null;
}

export interface BuiltAssessor {
  spec: InstanceSpec;
  assessor: Assessor;
  detection: Detection;
  /** Why always-escalate stands in for the configured assessor. */
  fallback?: string;
  plugin: string;
}

export async function buildAnswerer(spec: InstanceSpec | null, deps: SlotDeps): Promise<BuiltAnswerer> {
  if (!spec) return { spec: null, plugin: null };
  const built = await instantiate('answerer', spec, deps);
  if (!built.ok) {
    deps.logger.warn(`hopper: answerer ${spec.name} (${spec.plugin}) unavailable, questions go to the human: ${built.why}`);
    return { spec, detection: built.detection, fallback: built.why, plugin: null };
  }
  const inner = built.instance;
  const answerer: Answerer = {
    name: spec.name,
    ...(inner.model ? { model: inner.model } : {}),
    answer: (req: AnswerRequest, signal: AbortSignal) => inner.answer(req, signal),
  };
  return { spec, answerer, detection: built.detection, plugin: built.plugin };
}

export async function buildAssessor(spec: InstanceSpec, deps: SlotDeps): Promise<BuiltAssessor> {
  const built = await instantiate('assessor', spec, deps);
  if (built.ok) {
    const inner = built.instance;
    const assessor: Assessor = {
      name: spec.name,
      ...(inner.model ? { model: inner.model } : {}),
      assess: (req: AnswerRequest, draft: AnswerDraft, signal: AbortSignal) => inner.assess(req, draft, signal),
    };
    return { spec, assessor, detection: built.detection, plugin: built.plugin };
  }
  const why = built.why;
  deps.logger.warn(`hopper: assessor ${spec.name} (${spec.plugin}) unavailable, every question escalates: ${why}`);
  const assessor: Assessor = {
    name: spec.name,
    async assess(): Promise<Assessment> {
      return { escalate: true, reason: `assessor ${spec.name} unavailable: ${why}` };
    },
  };
  return { spec, assessor, detection: built.detection, fallback: why, plugin: alwaysEscalate.id };
}

export function answererStatus(b: BuiltAnswerer): QuestionRoleStatus {
  return {
    instance: b.spec,
    ...(b.detection ? { detection: b.detection } : {}),
    active: b.plugin,
    fallback: b.fallback !== undefined,
    ...(b.fallback !== undefined ? { reason: b.fallback } : {}),
  };
}

export function assessorStatus(b: BuiltAssessor): QuestionRoleStatus {
  return {
    instance: b.spec, detection: b.detection, active: b.plugin, fallback: b.fallback !== undefined,
    ...(b.fallback !== undefined ? { reason: b.fallback } : {}),
  };
}
