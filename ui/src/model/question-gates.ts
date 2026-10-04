// The question gates' model (issue #18): the chain a question goes through — answerer, assessor,
// risk rules, the owner — as GET /api/plugins reports it, and the rules-file editor's draft, kept in
// the browser so unsaved edits survive a reload, sent back with the version it was based on.
import type { PluginsReport, RulesFileView } from '../../../src/domain/types.ts';
import { instanceState } from './plugins.ts';

export type GateStage = 'answerer' | 'assessor' | 'risk-rules' | 'human';
type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export interface Gate {
  stage: GateStage;
  /** The instance name; null when no answerer is configured. */
  name: string | null;
  plugin?: string;
  label: string;
  tone: Tone;
  reason?: string;
}

function liveGate(report: PluginsReport, stage: 'answerer' | 'assessor'): Gate {
  const s = report[stage];
  if (!s.instance) return { stage, name: null, label: 'none — straight to the owner', tone: 'muted' };
  const st = instanceState(report, stage, s.instance.name);
  const why = st.reason ?? (st.detection && st.detection.status !== 'available' ? `${st.detection.status}: ${st.detection.reason}` : undefined);
  return { stage, name: s.instance.name, plugin: s.instance.plugin, label: st.label, tone: st.tone, ...(why ? { reason: why } : {}) };
}

/** The gates in the order a question meets them. */
export function gateChain(report: PluginsReport, riskRuleCount: number): Gate[] {
  return [
    liveGate(report, 'answerer'),
    liveGate(report, 'assessor'),
    { stage: 'risk-rules', name: `${riskRuleCount} rules`, label: 'code, cannot be weakened', tone: 'muted' },
    { stage: 'human', name: 'the owner', label: 'last stop', tone: 'muted' },
  ];
}

/** Matches RULES_FILE_MAX_BYTES in src/questions/rules-file.ts; the daemon refuses more (400). */
export const RULES_FILE_MAX_BYTES = 64 * 1024;

/** An unsaved rules-file edit as the browser keeps it: for which file, over which version. */
export interface StoredDraft { path: string; text: string; base: string }

export const DRAFT_KEY = 'jh_rules_draft';

export function readDraft(raw: string | null): StoredDraft | undefined {
  if (!raw) return undefined;
  try {
    const d = JSON.parse(raw) as Partial<StoredDraft>;
    return typeof d.path === 'string' && typeof d.text === 'string' && typeof d.base === 'string' ? { path: d.path, text: d.text, base: d.base } : undefined;
  } catch {
    return undefined;
  }
}

export interface RulesEditor {
  text: string;
  /** The version Save sends: the one the draft was based on. */
  base: string;
  dirty: boolean;
  /** The file changed since the draft began: Save will be refused (409) until Discard. */
  stale: boolean;
  bytes: number;
  tooLarge: boolean;
}

export function rulesEditor(server: RulesFileView, stored: StoredDraft | undefined): RulesEditor {
  const d = stored && stored.path === server.path ? stored : undefined;
  const text = d ? d.text : server.text;
  const base = d ? d.base : server.version;
  const bytes = new TextEncoder().encode(text).length;
  return { text, base, dirty: d !== undefined && (d.text !== server.text || d.base !== server.version), stale: base !== server.version, bytes, tooLarge: bytes > RULES_FILE_MAX_BYTES };
}
