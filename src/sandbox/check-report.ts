// The read-only check's report (issue #715; design.md "A read-only infra box", part 4). Each check that ends becomes an
// HTML page: the template, its needs, a bar of the probes that passed and failed, and each probe — what it tried on which
// asset, what it expected, what it did, its exit code and the end of its output. The hopper keeps it as an artifact of the
// job that asked for the template (`Template.askedBy`): one artifact per template, and each later check (scheduled, or
// a person's) is a new revision of it. A template no job asked for gets none. The page runs no script and loads nothing:
// every text a probe wrote is escaped.
import { isRefusal, type UserArtifacts } from '../artifacts/service.ts';
import { failedProbes, type ProbeResult, type ReadOnlyCheck } from '../domain/read-only-check.ts';
import type { Job } from '../domain/types.ts';
import type { Template } from '../domain/vault.ts';

/** Who makes and revises the report: the artifact's `revisedBy`. */
export const REPORT_BY = 'read-only check';

/** A check's report, as an artifact takes it. */
export interface CheckReport { name: string; title: string; summary: string; note: string; content: Buffer }

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text: string): string => text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]!);
const probes = (n: number): string => `${n} probe${n === 1 ? '' : 's'}`;

/** The one line that says how the check ended. */
function summaryOf(check: ReadOnlyCheck): string {
  if (check.state === 'passed') return `passed: ${probes(check.probes.length)}, every write refused, every read worked`;
  if (check.state === 'running') return 'runs now';
  const failed = failedProbes(check);
  const parts = [
    ...(check.probes.length > 0 ? [`${failed.length} of ${probes(check.probes.length)} failed${failed.length ? ` (${failed.join('; ')})` : ''}`] : []),
    ...(check.problem ? [check.problem] : []),
  ];
  return `failed: ${parts.join('; ') || 'no probe ran'}`;
}

/** A bar of the probes that passed and failed: what the page draws. */
function bar(check: ReadOnlyCheck): string {
  const n = check.probes.length;
  const ok = check.probes.filter((p) => p.passed).length;
  const w = n === 0 ? 0 : Math.round((ok / n) * 600);
  return `<svg viewBox="0 0 600 24" width="100%" height="24" preserveAspectRatio="none" role="img" aria-label="${ok} of ${n} probes passed">`
    + `<rect width="600" height="24" fill="${n === 0 ? '#888' : '#c62828'}"/><rect width="${w}" height="24" fill="#2e7d32"/></svg>`;
}

const row = (p: ProbeResult): string => `<tr class="${p.passed ? 'ok' : 'bad'}"><td>${p.passed ? 'pass' : p.outcome === 'not-run' ? 'NOT RUN' : 'FAIL'}</td><td>${escape(p.id)}</td><td>${escape(p.asset)}</td>`
  + `<td>${p.expect}</td><td>${p.outcome}</td><td>${p.exit ?? 'did not run'}</td><td><pre>${escape(p.output)}</pre></td></tr>`;

/** The report of one ended check of the template. Pure. */
export function checkReport(t: Template, check: ReadOnlyCheck): CheckReport {
  const title = `Read-only check: ${t.name}`;
  const summary = summaryOf(check);
  const needs = (t.profiles ?? []).map((p) => `<li>${escape(`${p.operation} on ${p.asset.kind} ${p.asset.name}`)}</li>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; color: #222; background: #fff; }
table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; } tr.bad td:first-child { color: #c62828; font-weight: bold; }
tr.ok td:first-child { color: #2e7d32; }
@media (prefers-color-scheme: dark) { body { color: #eee; background: #121212; } th, td { border-color: #333; } }
</style></head><body>
<h1>${escape(title)}</h1>
<p><strong>${escape(summary)}</strong></p>
${bar(check)}
<p>Checked at ${escape(check.at)}, template version ${escape(check.version)}. Each write must be refused, each read must work.</p>
<h2>Needs</h2><ul>${needs}</ul>
<h2>Probes</h2>
<table><thead><tr><th>Result</th><th>Probe</th><th>Asset</th><th>Expected</th><th>Outcome</th><th>Exit</th><th>Output (end)</th></tr></thead>
<tbody>${check.probes.map(row).join('\n')}</tbody></table>
</body></html>
`;
  return { name: `read-only-check-${t.name}.html`, title, summary, note: `${check.state}, ${check.at}`, content: Buffer.from(html, 'utf8') };
}

/** Where a user's report goes: their artifacts, and their jobs, for the job that asked for the template. */
export interface ReportUser { artifacts: Pick<UserArtifacts, 'put' | 'list'>; jobs: { get(id: string): Job | undefined } }

/**
 * Keeps the check's report as an artifact of the job that asked for the template, a new revision of the one it has: its
 * id. Undefined: no job asked for it. Throws when it cannot be kept (the job is gone, the user's artifacts are full).
 */
export function keepReport(u: ReportUser, t: Template, check: ReadOnlyCheck): string | undefined {
  if (!t.askedBy) return undefined;
  const job = u.jobs.get(t.askedBy);
  if (!job) throw new Error(`the job that asked for it, ${t.askedBy}, is not on this hopper`);
  const r = checkReport(t, check);
  const before = u.artifacts.list({ jobId: job.id }).find((a) => a.name === r.name);
  const done = u.artifacts.put(job, { name: r.name, title: r.title, summary: r.summary, type: 'html', note: r.note, content: r.content, ...(before ? { to: before.id } : { separate: true }) }, REPORT_BY);
  if (isRefusal(done)) throw new Error(done.no);
  return done.id;
}
