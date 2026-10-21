// The real-cloud acceptance run (issue #866, docs/cloud-acceptance.md): an outside tester proves the sandbox module with
// real aws, kubectl, helm and terraform, in their own environment, with their own credentials. Nothing of ours is used:
// the tester's hopper, the tester's minting credentials in the tester's vault. One command drives the hopper through its
// operator CLI (each command prints JSON): it reads the vault, mint-tests each asset, asks for a template in plain words
// as a person writes them, waits for its approval (the read policy's or a person's) and for its read-only check — a box
// of the template on the hopper's own container runtime that runs one read per tool and the write probes, each of which
// must be refused (src/sandbox/probes.ts) —, and writes the result as `report.json` and `report.md`, masked: no account,
// role, cluster, namespace, workspace, key, token or address of the tester. The tester files `report.md` with the issue
// form `cloud-acceptance`; `collect` reads the reports back and sums them up per tool.
//
//   node scripts/cloud-acceptance.ts run [--aws-role <account>/<role>] [--cluster <name>] [--namespace <cluster>/<ns>]
//                                        [--terraform-workspace <name>] [--hopper "<command>"] [--out <dir>] [--wait <seconds>]
//   node scripts/cloud-acceptance.ts collect <file>...
//
// --hopper is the operator CLI, split on spaces (default `hopper`; a compose install: "podman compose exec -T hopper
// hopper"). --out is where the report goes (default ./cloud-acceptance). --wait is how long to wait for the approval and
// for the check (default 1800). `collect` takes report.json files, and the output of `gh issue list --label
// cloud-acceptance --state all --json number,url,body`. Exit 0 when the run passed, 1 when not, 2 on a bad call.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PROBES } from '../src/sandbox/probes.ts';
import { maskAddresses, maskSecret, maskSecrets } from '../src/secrets/mask.ts';
import type { ReadOnlyCheck } from '../src/domain/read-only-check.ts';

/** What the run names, as the tester's vault mints for it. */
export interface Assets { awsRole?: string; cluster?: string; namespace?: string; workspace?: string }

export type Status = 'passed' | 'failed' | 'skipped';
export interface Step { id: string; tool?: Tool; title: string; status: Status; detail: string }
export const TOOLS = ['aws', 'kubectl', 'helm', 'terraform'] as const;
export type Tool = typeof TOOLS[number];

export interface Report {
  kind: 'hopper-cloud-acceptance';
  version: 1;
  at: string;
  /** Whether each asset kind was named: never the asset. */
  named: { awsRole: boolean; cluster: boolean; namespace: boolean; workspace: boolean };
  steps: Step[];
  /** Each tool: passed when its read passed and each of its writes was refused, failed when one did not, skipped when no probe of it ran. */
  tools: Record<Tool, Status>;
  passed: boolean;
}

/** One operator CLI command's end. */
export interface Answer { status: number | null; stdout: string; stderr: string }

export const ISSUE_FORM = 'https://github.com/henningfutrell/hopper/issues/new?template=cloud-acceptance.yml';
const FENCE = '```json hopper-cloud-acceptance';

/** The needs in plain words, one line each, as a person writes them (src/skills/needs-in-words.ts reads them). Reads only. */
export function needsInWords(a: Assets): string {
  const lines: string[] = [];
  if (a.awsRole) lines.push(`aws sts get-caller-identity on role ${a.awsRole}`);
  if (a.cluster) lines.push(`kubectl get namespaces and helm list on cluster ${a.cluster}`);
  if (a.namespace) lines.push(`kubectl get pods in namespace ${a.namespace}`);
  if (a.workspace) lines.push(`terraform plan in workspace ${a.workspace}`);
  return lines.join('\n');
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with the tester's assets, keys, tokens, addresses, emails and host name masked. */
export function maskText(text: string, a: Assets): string {
  let out = text;
  const [account, role] = a.awsRole?.split('/') ?? [];
  const [nsCluster, ns] = a.namespace?.split('/') ?? [];
  if (account && role) out = out.replace(new RegExp(`\\b${escape(account)}/${escape(role)}\\b`, 'g'), '<account>/<role>').replace(new RegExp(`role/${escape(role)}\\b`, 'g'), 'role/<role>');
  if (nsCluster && ns) out = out.replace(new RegExp(`\\b${escape(nsCluster)}/${escape(ns)}\\b`, 'g'), '<cluster>/<namespace>');
  for (const [name, mask] of [[a.workspace, '<workspace>'], [a.cluster, '<cluster>'], [nsCluster, '<cluster>']] as const) {
    if (name) out = out.replace(new RegExp(`\\b${escape(name)}\\b`, 'g'), mask);
  }
  out = out.replace(/\b\d{12}\b/g, '<account>').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
  return maskAddresses(maskSecrets(maskSecret(out, hostname(), 'host')));
}

const TOOL_OF = new Map(PROBES.map((p) => [p.id, p.tool as Tool]));
const TITLE_OF = new Map(PROBES.map((p) => [p.id, p.title]));
const COVER: Record<Tool, string> = {
  aws: 'name an AWS role with --aws-role <account>/<role>',
  kubectl: 'name a cluster with --cluster <name> or a namespace with --namespace <cluster>/<ns>',
  helm: 'name a cluster with --cluster <name> or a namespace with --namespace <cluster>/<ns>',
  terraform: 'name a terraform workspace with --terraform-workspace <name>',
};

interface TemplateSeen { name: string; savedAt: string; check?: ReadOnlyCheck; approval?: unknown; pending?: { secrets: string[]; image: boolean; profiles: unknown[] } }

/** The run. Throws only on a bad call (no asset named); every other failure is a failed step. */
export async function run(o: {
  hopper: (args: string[]) => Answer; assets: Assets; waitMs: number; pollMs: number;
  now: () => Date; sleep: (ms: number) => Promise<void>; say: (text: string) => void;
}): Promise<Report> {
  const a = o.assets;
  if (!a.awsRole && !a.cluster && !a.namespace && !a.workspace) throw new Error('name what the run reads: --aws-role <account>/<role>, --cluster <name>, --namespace <cluster>/<ns> or --terraform-workspace <name>');
  if (a.workspace && !a.awsRole) throw new Error('--terraform-workspace needs --aws-role: terraform\'s probes run with the read session of the AWS role');
  const steps: Step[] = [];
  const mask = (t: string) => maskText(t, a).slice(-1500);
  const add = (id: string, title: string, status: Status, detail: string, tool?: Tool) => {
    steps.push({ id, title, status, detail: mask(detail), ...(tool ? { tool } : {}) });
    o.say(`${status.padEnd(7)} ${title}`);
    return status === 'passed';
  };
  const call = (args: string[]): { ok: true; value: unknown } | { ok: false; why: string } => {
    const r = o.hopper(args);
    if (r.status !== 0) return { ok: false, why: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
    try {
      return { ok: true, value: JSON.parse(r.stdout) };
    } catch {
      return { ok: false, why: `not JSON: ${r.stdout.slice(0, 200)}` };
    }
  };
  const skipRest = (from: string) => {
    for (const [id, title] of LATER.slice(LATER.findIndex(([i]) => i === from))) add(id, title, 'skipped', 'an earlier step failed');
  };

  const vault = call(['vault']);
  if (!add('hopper.reach', 'the hopper answers its operator CLI', vault.ok ? 'passed' : 'failed', vault.ok ? '' : vault.why)) {
    skipRest('template.request');
    return report(o.now(), a, steps);
  }

  const secrets = ((vault as { value: { secrets?: { mints?: { kind: string; name: string } }[] } }).value.secrets ?? []);
  const mints = (kind: string, name: string) => secrets.some((s) => s.mints?.kind === kind && s.mints.name === name);
  const account = a.awsRole?.split('/')[0];
  const cluster = a.cluster ?? a.namespace?.split('/')[0];
  if (account) add('vault.minting.aws', 'a minting credential mints for the AWS account', mints('aws-account', account) ? 'passed' : 'failed', mints('aws-account', account) ? '' : `no vault secret mints for aws-account/${account}: hopper vault set <name> --mints aws-account/${account}`);
  if (cluster) add('vault.minting.cluster', 'a minting credential mints for the cluster', mints('cluster', cluster) ? 'passed' : 'failed', mints('cluster', cluster) ? '' : `no vault secret mints for cluster/${cluster}: hopper vault set <name> --mints cluster/${cluster}`);
  if (a.awsRole) {
    const t = call(['vault', 'mint-test', `aws-role/${a.awsRole}`]);
    add('vault.mint-test.aws', 'the vault mints a read session, and STS says who it is', t.ok ? 'passed' : 'failed', t.ok ? JSON.stringify((t.value as { identity?: unknown }).identity ?? {}) : t.why, 'aws');
  }
  if (cluster) {
    const t = call(['vault', 'mint-test', `cluster/${cluster}`]);
    add('vault.mint-test.cluster', 'the vault mints a read token, and the cluster says who it is', t.ok ? 'passed' : 'failed', t.ok ? JSON.stringify((t.value as { user?: unknown }).user ?? {}) : t.why, 'kubectl');
  }

  const asked = call(['template', 'request', '--needs', needsInWords(a)]);
  const name = asked.ok ? (asked.value as { template?: string }).template : undefined;
  if (!add('template.request', 'the hopper makes a template from the needs in plain words', name ? 'passed' : 'failed', asked.ok ? (asked.value as { text?: string }).text ?? '' : asked.why)) {
    skipRest('template.approved');
    return report(o.now(), a, steps);
  }

  const seen = (): TemplateSeen | string => {
    const l = call(['template', 'list']);
    if (!l.ok) return l.why;
    return (l.value as TemplateSeen[]).find((t) => t.name === name) ?? `the template ${name} is gone`;
  };
  const approved = (t: TemplateSeen) => t.approval !== undefined && t.pending !== undefined && !t.pending.image && t.pending.secrets.length === 0 && t.pending.profiles.length === 0;
  const until = o.now().getTime() + o.waitMs;
  // The report is of this run: a check that ended before it is dropped, and the check pass runs a new one.
  let t = seen();
  if (typeof t !== 'string' && t.check && t.check.state !== 'running') {
    call(['template', 'check', name!]);
    t = seen();
  }
  let told = false;
  while (typeof t === 'string' || !approved(t)) {
    if (typeof t !== 'string' && !told) {
      o.say(`the template ${name} waits for a person: approve it with hopper template approve ${name} (or Vault)`);
      told = true;
    }
    if (o.now().getTime() >= until) break;
    await o.sleep(o.pollMs);
    t = seen();
  }
  if (!add('template.approved', 'the template is approved', typeof t !== 'string' && approved(t) ? 'passed' : 'failed', typeof t === 'string' ? t : approved(t) ? `by ${String((t.approval as { by?: string }).by ?? 'a person')}` : 'not approved before --wait ran out')) {
    skipRest('check.ended');
    return report(o.now(), a, steps);
  }

  const ended = (x: TemplateSeen | string): x is TemplateSeen & { check: ReadOnlyCheck } =>
    typeof x !== 'string' && x.check !== undefined && x.check.version === x.savedAt && x.check.state !== 'running';
  while (!ended(t) && o.now().getTime() < until) {
    await o.sleep(o.pollMs);
    t = seen();
  }
  if (!ended(t)) {
    add('check.ended', 'the read-only check ran in a box of the template', 'failed', typeof t === 'string' ? t : 'the check did not end before --wait ran out');
    return report(o.now(), a, steps);
  }
  const check = t.check;
  add('check.ended', 'the read-only check ran in a box of the template', check.probes.length > 0 ? 'passed' : 'failed', check.problem ?? `${check.state}, ${check.probes.length} probes`);
  for (const p of check.probes) {
    const tool = TOOL_OF.get(p.id);
    const what = `${p.expect === 'allowed' ? 'read' : 'write refused'}: ${TITLE_OF.get(p.id) ?? p.id}`;
    add(`probe.${p.id}`, what, p.outcome === 'skipped' ? 'skipped' : p.passed ? 'passed' : 'failed',
      `${p.outcome}${p.exit === undefined ? '' : `, exit ${p.exit}`}${p.output ? `: ${p.output}` : ''}${p.note ? ` (${p.note})` : ''}`, tool);
  }
  return report(o.now(), a, steps);
}

/** The steps after each one that can stop the run, in order: skipped when it stops. */
const LATER: [string, string][] = [
  ['template.request', 'the hopper makes a template from the needs in plain words'],
  ['template.approved', 'the template is approved'],
  ['check.ended', 'the read-only check ran in a box of the template'],
];

function report(at: Date, a: Assets, steps: Step[]): Report {
  const tools = {} as Record<Tool, Status>;
  for (const tool of TOOLS) {
    const probes = steps.filter((s) => s.tool === tool && s.id.startsWith('probe.') && s.status !== 'skipped');
    tools[tool] = probes.length === 0 ? 'skipped' : probes.every((s) => s.status === 'passed') ? 'passed' : 'failed';
    if (tools[tool] === 'skipped') steps.push({ id: `tool.${tool}`, tool, title: `${tool}: no probe ran`, status: 'skipped', detail: `to cover it, ${COVER[tool]}` });
  }
  return {
    kind: 'hopper-cloud-acceptance', version: 1, at: at.toISOString(),
    named: { awsRole: !!a.awsRole, cluster: !!a.cluster, namespace: !!a.namespace, workspace: !!a.workspace },
    steps, tools, passed: steps.every((s) => s.status !== 'failed'),
  };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 300);

/** The report as Markdown, for the issue form: a summary, each step, and the report itself as JSON for `collect`. */
export function markdown(r: Report): string {
  return [
    `## Cloud acceptance run: ${r.passed ? 'passed' : 'failed'}`,
    '',
    `Run at ${r.at}.`,
    '',
    '| Tool | Result |', '|---|---|',
    ...TOOLS.map((t) => `| ${t} | ${r.tools[t]} |`),
    '',
    '| Step | Result | Detail |', '|---|---|---|',
    ...r.steps.map((s) => `| ${cell(s.title)} | ${s.status} | ${cell(s.detail)} |`),
    '',
    FENCE,
    JSON.stringify(r, null, 2),
    '```',
    '',
  ].join('\n');
}

/** The reports in a text: a report.json, a report.md or an issue body. */
function reportsIn(text: string): Report[] {
  const found: Report[] = [];
  const take = (v: unknown) => {
    if ((v as Report | null)?.kind === 'hopper-cloud-acceptance') found.push(v as Report);
  };
  try {
    take(JSON.parse(text));
  } catch { /* not JSON as a whole */ }
  for (const m of text.matchAll(/```json hopper-cloud-acceptance\n([\s\S]*?)\n```/g)) {
    try {
      take(JSON.parse(m[1]!));
    } catch { /* a broken block: unread */ }
  }
  return found;
}

/**
 * The reports in these texts — report.json files, and `gh issue list --json number,url,body` output — and a sum per
 * tool. `unread` names each issue with no report in it.
 */
export function collect(texts: readonly string[]): { reports: { from: string; report: Report }[]; unread: string[]; text: string } {
  const reports: { from: string; report: Report }[] = [];
  const unread: string[] = [];
  texts.forEach((text, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch { /* a report.md */ }
    if (Array.isArray(parsed)) {
      for (const issue of parsed as { number?: number; url?: string; body?: string }[]) {
        const from = issue.url ?? `#${issue.number}`;
        const got = reportsIn(issue.body ?? '');
        if (got.length === 0) unread.push(from);
        for (const report of got) reports.push({ from, report });
      }
    } else {
      for (const report of reportsIn(text)) reports.push({ from: `input ${i + 1}`, report });
    }
  });
  const count = (tool: Tool, s: Status) => reports.filter((r) => r.report.tools[tool] === s).length;
  const text = [
    `${reports.length} reports, ${reports.filter((r) => r.report.passed).length} passed.`,
    '',
    '| Tool | Passed | Failed | Skipped |', '|---|---|---|---|',
    ...TOOLS.map((t) => `| ${t} | ${count(t, 'passed')} | ${count(t, 'failed')} | ${count(t, 'skipped')} |`),
    '',
    '| Report | At | Result | Failed steps |', '|---|---|---|---|',
    ...reports.map(({ from, report }) => `| ${from} | ${report.at} | ${report.passed ? 'passed' : 'failed'} | ${cell(report.steps.filter((s) => s.status === 'failed').map((s) => s.id).join(', ') || 'none')} |`),
    ...(unread.length > 0 ? ['', `No report in: ${unread.join(', ')}`] : []),
    '',
  ].join('\n');
  return { reports, unread, text };
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === 'collect') {
    if (rest.length === 0) {
      process.stderr.write('usage: node scripts/cloud-acceptance.ts collect <report.json | gh issue list output>...\n');
      process.exit(2);
    }
    process.stdout.write(collect(rest.map((f) => readFileSync(f, 'utf8'))).text);
  } else if (verb === 'run') {
    const { values: v } = parseArgs({ args: rest, options: {
      'aws-role': { type: 'string' }, cluster: { type: 'string' }, namespace: { type: 'string' }, 'terraform-workspace': { type: 'string' },
      hopper: { type: 'string', default: 'hopper' }, out: { type: 'string', default: 'cloud-acceptance' }, wait: { type: 'string', default: '1800' },
    } });
    const [cmd, ...pre] = v.hopper.split(/\s+/).filter(Boolean);
    const assets: Assets = { awsRole: v['aws-role'], cluster: v.cluster, namespace: v.namespace, workspace: v['terraform-workspace'] };
    let r: Report;
    try {
      r = await run({
        hopper: (args) => {
          const x = spawnSync(cmd!, [...pre, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          return { status: x.status, stdout: x.stdout ?? '', stderr: x.error ? x.error.message : x.stderr ?? '' };
        },
        assets, waitMs: Number(v.wait) * 1000, pollMs: 10_000, now: () => new Date(),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)), say: (t) => process.stdout.write(`${t}\n`),
      });
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(2);
    }
    mkdirSync(v.out, { recursive: true });
    writeFileSync(join(v.out, 'report.json'), `${JSON.stringify(r, null, 2)}\n`);
    writeFileSync(join(v.out, 'report.md'), markdown(r));
    process.stdout.write(`\ncloud acceptance run ${r.passed ? 'passed' : 'failed'}: ${join(v.out, 'report.md')}\nRead it, then file it: ${ISSUE_FORM}\n`);
    process.exitCode = r.passed ? 0 : 1;
  } else {
    process.stderr.write('usage: node scripts/cloud-acceptance.ts run --aws-role <account>/<role> | --cluster <name> ... | collect <file>...\n');
    process.exit(2);
  }
}
