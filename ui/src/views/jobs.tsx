// The Jobs view (issues #434, #900): where every job stands, at a glance, and how the jobs hang together. It reads the job
// graph (GET /api/jobs/graph) when it opens and again each time the store's jobs change — the store reads the queue after
// each event, so a stage change arrives with no reload. Above both modes: how many jobs are in each stage (a count is
// also its stage's filter) and the filters by stage and by repository.
// - Graph (the default): a section per job tree, named by its root, laid out from it; nodes are jobs, issues and pull
//   requests, coloured by stage, a job with its task count; edges are typed. What blocks the root is ringed, and the
//   edges to it are drawn bold. A settled tree starts folded. Select a node to read its details.
// - List: a row per job — its issue, stage, task count, lane, time in stage, pull request and checks, last event; a
//   partly done job names the pull request that blocks the rest and what runs after its merge.
// A row and a node render again only when what they show changes, so the view stays quick with hundreds of jobs.
import { Briefcase, ChevronDown, ChevronRight, CircleHelp, List, Network } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { detailOf, eventTone } from '@/components/event-line';
import { GhLink } from '@/components/job';
import { NodeTends } from '@/components/node-tends';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { COLOR, StatusBadge, TEXT, type Tone } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { laneName } from '@/model/board';
import { clock, elapsed } from '@/model/format';
import { jobHref } from '@/model/job';
import {
  EDGE_TEXT, filterChoices, KIND_TEXT, jobRows, lastEvents, layoutTree, NO_FILTER, NODE_H, NODE_W, pullRequestText, pullRequestTone, shownTrees, stageCounts, stageInfo,
  STAGES, tasksText, type JobsFilter,
} from '@/model/jobs-view';
import type { DomainEvent, JobGraph, JobGraphEdge, JobGraphNode, JobStage, JobTree } from '@/model/wire';
import { useHopper } from '@/store';

const EMPTY: JobGraph = { nodes: [], edges: [], trees: [], stages: {} };
type Mode = 'graph' | 'list';

function StageBadge({ stage }: { stage: JobStage }) {
  const s = stageInfo(stage);
  return <StatusBadge status={stage} label={s.label} tone={s.tone} title={s.title} />;
}

const prLabel = (url: string): string => { const n = /\/pull\/(\d+)/.exec(url)?.[1]; return n ? `PR #${n}` : 'its pull request'; };

function PullRequest({ pr }: { pr: NonNullable<JobGraphNode['pullRequest']> }) {
  return (
    <span data-slot="card-pr" className="inline-flex min-w-0 items-center gap-1.5">
      <GhLink url={pr.url}>{prLabel(pr.url)}</GhLink>
      <span className={cn('truncate', TEXT[pullRequestTone(pr)])}>{pullRequestText(pr)}</span>
    </span>
  );
}

const issueOf = (n: JobGraphNode): string | undefined => (n.repo && n.number !== undefined ? `${n.repo}#${n.number}` : undefined);

interface RowProps { node: JobGraphNode; lane: string; last: DomainEvent | undefined; since: string | undefined }

const same = (a: RowProps, b: RowProps): boolean =>
  a.node.id === b.node.id && a.node.stage === b.node.stage && a.node.status === b.node.status && a.node.stageSince === b.node.stageSince
  && a.node.tasks?.done === b.node.tasks?.done && a.node.tasks?.total === b.node.tasks?.total && a.lane === b.lane && a.last?.seq === b.last?.seq
  && a.since === b.since && JSON.stringify(a.node.pullRequest) === JSON.stringify(b.node.pullRequest);

const JobRow = memo(function JobRow({ node, lane, last, since }: RowProps) {
  const issue = issueOf(node);
  const detail = last ? detailOf(last) : '';
  return (
    <div data-slot="job-card" data-job-id={node.jobId} data-stage={node.stage} data-status={node.status} className="min-w-0 space-y-1.5 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-start gap-2">
        <a href={jobHref(node.jobId!)} className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline" title={`${node.label}\njob ${node.jobId}`}>{node.label}</a>
        {node.tasks && <span data-slot="card-tasks" className="num shrink-0 font-mono text-xs text-muted-foreground" title="tasks done of its task list">{tasksText(node)}</span>}
        <span data-slot="card-stage"><StageBadge stage={node.stage} /></span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="card-issue" className="font-mono">{issue ? <GhLink url={node.url}>{issue}</GhLink> : 'no issue'}</span>
        <span data-slot="card-lane" title="its lane">{lane}</span>
        {since && <span data-slot="card-since" title={`in this stage since ${node.stageSince}`}>{since} in stage</span>}
        {node.pullRequest && <PullRequest pr={node.pullRequest} />}
      </div>
      {node.partlyDone && (
        <div data-slot="card-partly-done" className={cn('text-xs', TEXT.operator)}>
          waits on the merge of <GhLink url={node.partlyDone.pullRequest}>{prLabel(node.partlyDone.pullRequest)}</GhLink>; then {node.partlyDone.afterMerge}
        </div>
      )}
      <div data-slot="card-last-event" className="flex min-w-0 items-baseline gap-2 text-xs" title={last ? `${last.at}${detail ? ` — ${detail}` : ''}` : undefined}>
        {last ? <>
          <span className="num shrink-0 font-mono text-muted-foreground/80">{clock(last.at)}</span>
          <span className={cn('shrink-0 font-mono font-medium', TEXT[eventTone(last.type)])}>{last.type}</span>
          {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
        </> : <span className="text-muted-foreground/70">no event yet</span>}
      </div>
    </div>
  );
}, same);

function Filter<T extends string>({ slot, label, value, choices, name, onPick }: { slot: string; label: string; value: T | null; choices: readonly T[]; name: (v: T) => string; onPick: (v: T | null) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}
      <select data-slot={slot} className={cn(FIELD, 'w-36')} value={value ?? ''} onChange={(e) => onPick(e.target.value === '' ? null : (e.target.value as T))}>
        <option value="">all</option>
        {/* A choice no job has any more stays selectable, so the filter never changes by itself. */}
        {[...new Set([...(value ? [value] : []), ...choices])].map((c) => <option key={c} value={c}>{name(c)}</option>)}
      </select>
    </label>
  );
}

/** How many jobs are in each stage; a count is a button that filters to its stage. */
function StageCounts({ counts, chosen, onPick }: { counts: Partial<Record<JobStage, number>>; chosen: JobStage | null; onPick: (s: JobStage | null) => void }) {
  return (
    <div data-slot="jobs-stage-counts" className="flex flex-wrap gap-1.5 border-b px-4 py-2">
      {STAGES.filter((s) => s.stage !== 'no_job').map((s) => {
        const n = counts[s.stage] ?? 0;
        const on = chosen === s.stage;
        return (
          <button key={s.stage} type="button" data-slot="jobs-stage-count" data-stage={s.stage} title={s.title} aria-pressed={on}
            onClick={() => onPick(on ? null : s.stage)} disabled={n === 0 && !on}
            className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs disabled:opacity-40', on ? 'border-foreground/40 bg-muted' : 'hover:bg-muted/60')}>
            <span className="size-2 rounded-full" style={{ background: COLOR[s.tone] }} />
            <span>{s.label}</span>
            <span className="num font-mono font-medium">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

const EDGE_STYLE: Record<JobGraphEdge['kind'], { dash?: string; tone: Tone }> = {
  parent: { tone: 'muted' }, follow_up: { dash: '2 3', tone: 'muted' }, works: { tone: 'muted' },
  next_part: { tone: 'operator' }, rerun: { dash: '4 3', tone: 'muted' }, spawned: { dash: '4 3', tone: 'question' },
  plan_apply: { tone: 'busy' }, opened: { tone: 'muted' }, waits_on_merge: { dash: '6 3', tone: 'operator' }, closes: { dash: '2 3', tone: 'ok' },
  blocked_by: { dash: '6 3', tone: 'bad' }, stacked_on: { dash: '6 3', tone: 'warn' }, asks: { tone: 'question' }, hands_off: { tone: 'bad' },
};

/** A node's corners: an issue's soft, a job's round, a pull request's square, a question's and a hand-off's a pill. */
const RADIUS: Record<JobGraphNode['kind'], number> = { issue: 6, job: 10, pull_request: 2, question: NODE_H / 2, handoff: NODE_H / 2 };

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const NodeBox = memo(function NodeBox({ node, x, y, blocking, selected, onSelect }: { node: JobGraphNode; x: number; y: number; blocking: boolean; selected: boolean; onSelect: (id: string) => void }) {
  const tone = stageInfo(node.stage).tone;
  const kind = KIND_TEXT[node.kind];
  const tasks = tasksText(node);
  return (
    <g data-slot="graph-node" data-node-id={node.id} data-kind={node.kind} data-stage={node.stage} data-blocking={blocking ? '' : undefined}
      transform={`translate(${x},${y})`} className="cursor-pointer" role="button" tabIndex={0} aria-label={`${kind} ${node.label}, ${stageInfo(node.stage).label}`}
      onClick={() => onSelect(node.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.id); } }}>
      <title>{`${node.label}\n${kind} · ${stageInfo(node.stage).label}${tasks ? ` · tasks ${tasks}` : ''}${blocking ? '\nblocks its root' : ''}`}</title>
      {blocking && <rect x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={9} fill="none" stroke="var(--bad)" strokeWidth={1.5} strokeDasharray="3 2" />}
      <rect width={NODE_W} height={NODE_H} rx={RADIUS[node.kind]} fill="var(--card)"
        stroke={selected ? 'var(--foreground)' : COLOR[tone]} strokeWidth={selected ? 2 : 1.25} strokeDasharray={node.stage === 'no_job' ? '4 3' : undefined} />
      <rect width={5} height={NODE_H} rx={2} fill={COLOR[tone]} />
      <text x={12} y={17} fontSize={11} fill="var(--foreground)" fontWeight={500}>{short(node.label, tasks ? 22 : 28)}</text>
      {tasks && <text x={NODE_W - 8} y={17} fontSize={11} textAnchor="end" fill="var(--muted-foreground)" fontFamily="var(--font-mono, monospace)">{tasks}</text>}
      <text x={12} y={34} fontSize={10} fill={COLOR[tone]}>{`${kind} · ${stageInfo(node.stage).label}`}</text>
    </g>
  );
});

function TreeGraph({ graph, tree, selected, onSelect }: { graph: JobGraph; tree: JobTree; selected: string | null; onSelect: (id: string) => void }) {
  const layout = useMemo(() => layoutTree(graph, tree), [graph, tree]);
  const at = useMemo(() => new Map(layout.placed.map((p) => [p.id, p])), [layout]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const blocking = useMemo(() => new Set(tree.blocking), [tree]);
  const edges = useMemo(() => graph.edges.filter((e) => at.has(e.from) && at.has(e.to)), [graph, at]);
  const PAD = 8;
  return (
    <div className="overflow-x-auto">
      <svg data-slot="job-tree-graph" width={layout.width + 2 * PAD} height={layout.height + 2 * PAD} className="block" role="group" aria-label="job tree">
        <g transform={`translate(${PAD},${PAD})`}>
          {edges.map((e) => {
            const a = at.get(e.from)!;
            const b = at.get(e.to)!;
            const forward = a.x <= b.x;
            const [x1, y1, x2, y2] = forward ? [a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2] : [a.x, a.y + NODE_H / 2, b.x + NODE_W, b.y + NODE_H / 2];
            const mid = (x1 + x2) / 2;
            const hot = blocking.has(e.to) && (e.from === tree.root || blocking.has(e.from));
            const style = EDGE_STYLE[e.kind];
            return (
              <path key={`${e.from} ${e.kind} ${e.to}`} data-slot="graph-edge" data-kind={e.kind} data-blocking={hot ? '' : undefined}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none"
                stroke={hot ? 'var(--bad)' : COLOR[style.tone]} strokeOpacity={hot ? 0.9 : 0.6} strokeWidth={hot ? 2.25 : 1.25} strokeDasharray={style.dash}>
                <title>{`${byId.get(e.from)?.label ?? e.from} → ${EDGE_TEXT[e.kind]} → ${byId.get(e.to)?.label ?? e.to}`}</title>
              </path>
            );
          })}
          {layout.placed.map((p) => (
            <NodeBox key={p.id} node={byId.get(p.id)!} x={p.x} y={p.y} blocking={blocking.has(p.id)} selected={selected === p.id} onSelect={onSelect} />
          ))}
        </g>
      </svg>
    </div>
  );
}

function NodeDetails({ graph, id, laneOf, now, onClose }: { graph: JobGraph; id: string; laneOf: (laneId: string) => string; now: number; onClose: () => void }) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;
  const into = graph.edges.filter((e) => e.to === id);
  const out = graph.edges.filter((e) => e.from === id);
  const label = (nid: string) => graph.nodes.find((n) => n.id === nid)?.label ?? nid;
  const issue = issueOf(node);
  return (
    <div data-slot="graph-node-details" data-node-id={id} className="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{node.jobId ? <a href={jobHref(node.jobId)} className="underline-offset-4 hover:underline">{node.label}</a> : node.url ? <GhLink url={node.url}>{node.label}</GhLink> : node.label}</span>
        <StageBadge stage={node.stage} />
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close the details">✕</button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
        <dt>kind</dt><dd>{KIND_TEXT[node.kind]}</dd>
        {issue && <><dt>issue</dt><dd className="font-mono">{node.url ? <GhLink url={node.url}>{issue}</GhLink> : issue}</dd></>}
        {node.status && <><dt>status</dt><dd>{node.status.replace('_', ' ')}</dd></>}
        {node.tasks && <><dt>tasks</dt><dd className="font-mono">{tasksText(node)}</dd></>}
        {node.parts && <><dt>parts</dt><dd className="font-mono">{node.parts.done}/{node.parts.total}</dd></>}
        {node.kind === 'job' && <><dt>lane</dt><dd>{node.laneId ? laneOf(node.laneId) : 'no lane'}</dd></>}
        {node.stageSince && <><dt>in stage</dt><dd>{elapsed(node.stageSince, now)}</dd></>}
        {node.pullRequest && <><dt>pull request</dt><dd><PullRequest pr={node.pullRequest} /></dd></>}
        {node.partlyDone && <><dt>after merge</dt><dd>{node.partlyDone.afterMerge}</dd></>}
      </dl>
      {node.tends && <NodeTends tends={node.tends} now={now} />}
      {(into.length > 0 || out.length > 0) && (
        <ul className="space-y-0.5 text-muted-foreground">
          {into.map((e) => <li key={`in ${e.from} ${e.kind}`}>{label(e.from)} <span className="text-foreground">{EDGE_TEXT[e.kind]}</span> this</li>)}
          {out.map((e) => <li key={`out ${e.kind} ${e.to}`}>this <span className="text-foreground">{EDGE_TEXT[e.kind]}</span> {label(e.to)}</li>)}
        </ul>
      )}
    </div>
  );
}

function TreeSection({ graph, tree, open, onToggle, selected, onSelect, children }: {
  graph: JobGraph; tree: JobTree; open: boolean; onToggle: () => void; selected: string | null; onSelect: (id: string) => void; children?: React.ReactNode;
}) {
  const root = graph.nodes.find((n) => n.id === tree.root)!;
  const jobs = Object.values(tree.stages).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <section data-slot="job-tree" data-root={tree.root} data-open={open ? '' : undefined} className="rounded-lg border">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40">
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={root.label}>{root.label}</span>
        <span data-slot="job-tree-blocking" className={cn('shrink-0 text-xs', tree.blocking.length ? TEXT.bad : TEXT.ok)}>
          {tree.blocking.length ? `${tree.blocking.length} blocking` : 'nothing blocks it'}
        </span>
        <span className="flex shrink-0 gap-1">
          {STAGES.filter((s) => tree.stages[s.stage]).map((s) => <StatusBadge key={s.stage} status={s.stage} tone={s.tone} label={`${tree.stages[s.stage]} ${s.label}`} />)}
        </span>
        <span className="num shrink-0 text-xs text-muted-foreground">{jobs} {jobs === 1 ? 'job' : 'jobs'}</span>
      </button>
      {open && <div className="space-y-2 border-t px-3 py-2"><TreeGraph graph={graph} tree={tree} selected={selected} onSelect={onSelect} />{children}</div>}
    </section>
  );
}

function Legend() {
  return (
    <div data-slot="jobs-graph-legend" className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
      <span>rounded: job · square corners: pull request · between: issue</span>
      <span className={TEXT.bad}>dashed red ring and bold red line: what blocks the root</span>
      <span>hover a line for what it means</span>
    </div>
  );
}

export function Jobs() {
  const held = useHopper((s) => s.jobs);
  const locked = useHopper((s) => s.locked);
  const events = useHopper((s) => s.events);
  const machines = useHopper((s) => s.machines);
  const [graph, setGraph] = useState<JobGraph | null>(null);
  const [fetched, setFetched] = useState<DomainEvent[]>([]);
  const [filter, setFilter] = useState<JobsFilter>(NO_FILTER);
  const [mode, setMode] = useState<Mode>('graph');
  // A tree a person opened or folded; else it starts open unless nothing blocks it and other trees show.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  // Each job's last event, read once; the stream's events since are newer where they are a job's.
  useEffect(() => { get<{ events: DomainEvent[] }>('/api/jobs/last-events').then((r) => setFetched(r.events), () => {}); }, []);
  // The graph, read again (debounced) each time the store's jobs change: the store reads the queue after each event.
  useEffect(() => {
    let live = true;
    const soon = setTimeout(() => { get<JobGraph>('/api/jobs/graph').then((g) => { if (live) setGraph(g); }, () => {}); }, graph ? 150 : 0);
    return () => { live = false; clearTimeout(soon); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again on the store's change only, not on its own answer
  }, [held, locked]);
  const g = graph ?? EMPTY;
  const last = useMemo(() => lastEvents(fetched, events), [fetched, events]);
  const choices = useMemo(() => filterChoices(g), [g]);
  const counts = useMemo(() => stageCounts(g, filter.repo), [g, filter.repo]);
  const rows = useMemo(() => jobRows(g, filter), [g, filter]);
  const trees = useMemo(() => shownTrees(g, filter), [g, filter]);
  const total = g.nodes.filter((n) => n.kind === 'job').length;
  const laneOf = (laneId: string) => laneName(laneId, machines);
  const isOpen = (t: JobTree) => opened[t.root] ?? !(t.blocking.length === 0 && trees.length > 1);
  const empty = graph === null ? 'reading the jobs…'
    : total === 0 ? 'No jobs yet. A job starts when a source takes an issue: label it and assign it as Sources says.'
      : 'No job matches the filters.';
  return (
    <Panel title="Jobs" icon={Briefcase}
      count={<span data-slot="jobs-count">{rows.length === total ? total : `${rows.length} of ${total}`}</span>}
      action={<div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View mode" className="inline-flex rounded-md border">
          <button type="button" data-slot="jobs-mode-graph" aria-pressed={mode === 'graph'} onClick={() => setMode('graph')} className={cn('inline-flex items-center gap-1 px-2 py-1 text-xs', mode === 'graph' && 'bg-muted')}><Network className="size-3.5" />Graph</button>
          <button type="button" data-slot="jobs-mode-list" aria-pressed={mode === 'list'} onClick={() => setMode('list')} className={cn('inline-flex items-center gap-1 border-l px-2 py-1 text-xs', mode === 'list' && 'bg-muted')}><List className="size-3.5" />List</button>
        </div>
        <Filter<JobStage> slot="jobs-filter-stage" label="Stage" value={filter.stage} choices={choices.stages} name={(s) => stageInfo(s).label} onPick={(stage) => setFilter((f) => ({ ...f, stage }))} />
        <Filter<string> slot="jobs-filter-repo" label="Repository" value={filter.repo} choices={choices.repos} name={(r) => r} onPick={(repo) => setFilter((f) => ({ ...f, repo }))} />
        <a href="/help/jobs" target="_blank" rel="noopener" className="text-muted-foreground hover:text-foreground" aria-label="Help for the Jobs view" title="Help for the Jobs view"><CircleHelp className="size-4" /></a>
      </div>}
      bodyClassName="p-0">
      <StageCounts counts={counts} chosen={filter.stage} onPick={(stage) => setFilter((f) => ({ ...f, stage }))} />
      {mode === 'list' ? (
        <div data-slot="jobs-list" className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.length ? rows.map((n) => (
            <JobRow key={n.id} node={n} lane={n.laneId ? laneOf(n.laneId) : 'no lane'} last={last.get(n.jobId!)} since={n.stageSince ? elapsed(n.stageSince, minute * 60_000) : undefined} />
          )) : <div className="col-span-full"><Empty>{empty}</Empty></div>}
        </div>
      ) : (
        <div data-slot="jobs-graph" className="space-y-2 p-4">
          {trees.length ? <>
            <Legend />
            {trees.map((t) => (
              <TreeSection key={t.root} graph={g} tree={t} open={isOpen(t)} onToggle={() => setOpened((o) => ({ ...o, [t.root]: !isOpen(t) }))}
                selected={selected} onSelect={(id) => setSelected((s) => (s === id ? null : id))}>
                {selected && t.nodes.includes(selected) && <NodeDetails graph={g} id={selected} laneOf={laneOf} now={now} onClose={() => setSelected(null)} />}
              </TreeSection>
            ))}
          </> : <Empty>{empty}</Empty>}
        </div>
      )}
    </Panel>
  );
}
