// The failure profile (issue #509): counts and a daily trend per signature, and breakdowns by machine, repo and
// executor, over the assessed failures of the last `days` days (UTC). Pure.
import type { FailureProfile, FailureRecord, ProfileCount, SignatureStat } from '../domain/types.ts';

const DAY_MS = 86_400_000;
const TOP = 20;

const dayOf = (iso: string): string => iso.slice(0, 10);

function counts(keys: (string | undefined)[]): ProfileCount[] {
  const m = new Map<string, number>();
  for (const k of keys) if (k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function profileOf(records: readonly FailureRecord[], now: string, o: { days: number; generalThreshold: number }): FailureProfile {
  const last = Date.parse(`${dayOf(now)}T00:00:00.000Z`);
  const days = Array.from({ length: o.days }, (_, i) => dayOf(new Date(last - (o.days - 1 - i) * DAY_MS).toISOString()));
  const index = new Map(days.map((d, i) => [d, i]));
  const inWindow = records.filter((r) => index.has(dayOf(r.at)));
  const bySignature = new Map<string, FailureRecord[]>();
  for (const r of inWindow) bySignature.set(r.signature, [...(bySignature.get(r.signature) ?? []), r]);
  const signatures: SignatureStat[] = [...bySignature].map(([signature, rs]) => {
    const trend = days.map(() => 0);
    for (const r of rs) trend[index.get(dayOf(r.at))!]! += 1;
    const jobs = new Set(rs.map((r) => r.jobId)).size;
    const newest = rs.reduce((a, b) => (b.at > a.at ? b : a));
    return {
      signature, name: rs.find((r) => r.causeName)?.causeName ?? newest.normalised, cls: newest.cls, count: rs.length, jobs,
      machines: new Set(rs.map((r) => r.evidence.machineId).filter((m) => m !== undefined)).size,
      lastAt: newest.at, general: jobs >= o.generalThreshold, trend,
    };
  }).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, TOP);
  const total = days.map(() => 0);
  for (const r of inWindow) total[index.get(dayOf(r.at))!]! += 1;
  return {
    days: days.map((day, i) => ({ day, count: total[i]! })),
    signatures,
    byMachine: counts(inWindow.map((r) => r.evidence.machineId)),
    byRepo: counts(inWindow.map((r) => r.evidence.repo)),
    byExecutor: counts(inWindow.map((r) => r.evidence.executor)),
  };
}
