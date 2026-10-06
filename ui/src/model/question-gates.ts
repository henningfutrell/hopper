// The question gates' model (issues #18, #134): the chain a question goes through — the escalation
// levels lowest first, the risk rules, the owner — as GET /api/plugins reports it, and the rules
// editor's draft, kept in the browser so unsaved edits survive a reload, sent back with the version
// it was based on.
import type { PluginsReport, RulesView } from '../../../src/domain/types.ts';
import { instanceState } from './plugins.ts';

export type GateStage = 'level' | 'risk-rules' | 'human';
type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export interface Gate {
  stage: GateStage;
  /** The level's instance name; null for the gate that says there are no levels. */
  name: string | null;
  plugin?: string;
  label: string;
  tone: Tone;
  reason?: string;
}

/** The gates in the order a question meets them. */
export function gateChain(report: PluginsReport, riskRuleCount: number): Gate[] {
  const levels: Gate[] = report.escalationLevels.map(({ instance }) => {
    const st = instanceState(report, 'escalation-level', instance.name);
    const why = st.reason ?? (st.detection && st.detection.status !== 'available' ? `${st.detection.status}: ${st.detection.reason}` : undefined);
    const label = st.label === 'cannot run' ? 'cannot run — escalates' : st.label;
    return { stage: 'level', name: instance.name, plugin: instance.plugin, label, tone: st.tone, ...(why ? { reason: why } : {}) };
  });
  return [
    ...(levels.length ? levels : [{ stage: 'level' as const, name: null, label: 'none — straight to the owner', tone: 'muted' as const }]),
    { stage: 'risk-rules', name: `${riskRuleCount} rules`, label: 'code, cannot be weakened', tone: 'muted' },
    { stage: 'human', name: 'Owner', label: 'last stop', tone: 'muted' },
  ];
}

/** Matches RULES_MAX_BYTES in src/questions/rules.ts; the daemon refuses more (400). */
export const RULES_MAX_BYTES = 64 * 1024;

/** An unsaved rules edit as the browser keeps it, over which version. */
export interface StoredDraft { text: string; base: string }

export const DRAFT_KEY = 'jh_rules_draft';

export function readDraft(raw: string | null): StoredDraft | undefined {
  if (!raw) return undefined;
  try {
    const d = JSON.parse(raw) as Partial<StoredDraft>;
    return typeof d.text === 'string' && typeof d.base === 'string' ? { text: d.text, base: d.base } : undefined;
  } catch {
    return undefined;
  }
}

export interface RulesEditor {
  text: string;
  /** The version Save sends: the one the draft was based on. */
  base: string;
  dirty: boolean;
  /** The rules changed since the draft began: Save will be refused (409) until Discard. */
  stale: boolean;
  bytes: number;
  tooLarge: boolean;
}

export function rulesEditor(server: RulesView, stored: StoredDraft | undefined): RulesEditor {
  const d = stored;
  const text = d ? d.text : server.text;
  const base = d ? d.base : server.version;
  const bytes = new TextEncoder().encode(text).length;
  return { text, base, dirty: d !== undefined && (d.text !== server.text || d.base !== server.version), stale: base !== server.version, bytes, tooLarge: bytes > RULES_MAX_BYTES };
}
