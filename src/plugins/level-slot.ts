// The escalation-level role's slot (design.md "Question pipeline", "Failure"): 0..n instances,
// lowest first, live — the host rebuilds them when the plugins config changes and the question service
// looks them up per question. A level that cannot run stays in its place and escalates every
// question it gets (fail safe: a broken level never answers, and never hides the levels above it).
// The instance is named after the plugins config whatever the plugin calls itself: that name is the
// question's stage.
import type { AnswerRequest, EscalationLevel, LevelReply, ReviewReply, ReviewRequest } from '../domain/ports.ts';
import type { Detection, InstanceSpec, InstanceStatus } from '../domain/types.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';

export interface BuiltLevel {
  spec: InstanceSpec;
  level: EscalationLevel;
  detection: Detection;
  /** null: it cannot run (`reason`), and escalates every question. */
  plugin: string | null;
  reason?: string;
}

export async function buildLevel(spec: InstanceSpec, deps: SlotDeps): Promise<BuiltLevel> {
  const built = await instantiate('escalation-level', spec, deps);
  if (built.ok) {
    const inner = built.instance;
    const level: EscalationLevel = {
      name: spec.name,
      ...(inner.model ? { model: inner.model } : {}),
      answer: (req: AnswerRequest, signal: AbortSignal) => inner.answer(req, signal),
      // A plugin that cannot review (issue #537): every proposal it gets escalates.
      review: (req: ReviewRequest, signal: AbortSignal) => (inner.review ? inner.review(req, signal) : Promise.resolve({ error: `${spec.plugin} cannot review proposals` })),
    };
    return { spec, level, detection: built.detection, plugin: built.plugin };
  }
  const why = built.why;
  deps.logger.warn(`hopper: escalation level ${spec.name} (${spec.plugin}) unavailable, it escalates every question: ${why}`);
  const level: EscalationLevel = {
    name: spec.name,
    async answer(): Promise<LevelReply> {
      return { escalate: true, reason: `unavailable: ${why}` };
    },
    async review(): Promise<ReviewReply> {
      return { verdict: 'escalate', notes: `unavailable: ${why}` };
    },
  };
  return { spec, level, detection: built.detection, plugin: null, reason: why };
}

export function levelStatus(b: BuiltLevel): InstanceStatus {
  return { instance: b.spec, detection: b.detection, active: b.plugin, ...(b.reason !== undefined ? { reason: b.reason } : {}) };
}
