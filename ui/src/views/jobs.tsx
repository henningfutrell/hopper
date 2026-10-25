// The Jobs view (issues #434, #900): where every job stands, at a glance, and how the jobs hang together. It reads the job
// graph (GET /api/jobs/graph) when it opens and again each time the store's jobs change — the store reads the queue after
// each event, so a stage change arrives with no reload. Above both modes: how many jobs are in each stage (a count is
// also its stage's filter) and the filters by stage and by repository. In flight (issue #1113): only the jobs whose work
// item is in flight, on at #jobs/in-flight — the header badge's link — and off at #jobs.
// - List (the default, issue #2372): a table, one row per job (job-row.tsx); a click on a row opens its run graph — the
//   job tree it is in, as Graph draws it — under the row, and a second click folds it. A job whose kept delivery track is
//   open (GET /api/delivery-tracks?state=open, read again with the graph; issue #2775) shows its delivery step, and a held
//   mark while a delivery hold holds its change.
// - Graph: a section per job tree, named by its root, laid out from it; nodes are jobs, issues and pull
//   requests, coloured by stage, a job with its task count; edges are typed. What blocks the root is ringed, and the
//   edges to it are drawn bold. A settled tree starts folded. Select a node to read its details.
// A row and a node render again only when what they show changes, so the view stays quick with hundreds of jobs. On a
// long page (issue #2353): the header, its filters and the stage counts stay in view; the list shows 30 rows to a page and
// the graph 8 trees; the mode and each tree folded or open are kept per browser.
import { Briefcase, ChevronDown, ChevronRight, CircleHelp, List, Network } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useSection } from '@/app/nav';
import { GhLink } from '@/components/job';
import { NodeTends } from '@/components/node-tends';
import { FitGraph } from '@/components/fit-graph';
import { Empty, Panel } from '@/components/panel';
import { ModeToggle, Pager, usePaged } from '@/components/pager';
import { COLOR, StatusBadge, TEXT, type Tone } from '@/components/status';
import { WaitsOnLink } from '@/components/waits-on';
import { useNow } from '@/hooks/use-now';
import { useGroupOpen, usePagePref } from '@/hooks/use-page-pref';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { laneName } from '@/model/board';
import { elapsed } from '@/model/format';
import { jobHref } from '@/model/job';
import {
  EDGE_TEXT, filterChoices, IN_FLIGHT_SECTION, KIND_TEXT, jobRows, lastEvents, layoutTree, NO_FILTER, NODE_H, NODE_W, shownTrees, stageCounts, stageInfo,
  STAGES, tasksText, type JobsFilter,
} from '@/model/jobs-view';
import { ROWS_PER_PAGE } from '@/model/page-prefs';
import type { DeliveryTracksView, DomainEvent, JobGraph, JobGraphEdge, JobGraphNode, JobStage, JobTree } from '@/model/wire';
import { useHopper } from '@/store';
import { Filter, InFlightToggle, StageCounts } from './jobs-filters';
import { type DeliveryPosition, issueOf, JOB_COLUMNS, JobRow, JobTableHead, PullRequest, StageBadge } from './job-row';

const EMPTY: JobGraph = { nodes: [], edges: [], trees: [], stages: {} };
const MODES = [
  { mode: 'list', label: 'List', icon: List, title: 'A row per job' },
  { mode: 'graph', label: 'Graph', icon: Network, title: 'A graph per job tree' },
] as const;
type Mode = (typeof MODES)[number]['mode'];
const MODE_NAMES: readonly Mode[] = MODES.map((m) => m.mode);
const TREES_PER_PAGE = 8;

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
  const ref = issueOf(node);
  return (
    <g data-slot="graph-node" data-node-id={node.id} data-kind={node.kind} data-stage={node.stage} data-blocking={blocking ? '' : undefined}
      transform={`translate(${x},${y})`} className="cursor-pointer" role="button" tabIndex={0} aria-label={`${kind} ${node.label}, ${node.stageText}`}
      onClick={() => onSelect(node.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.id); } }}>
      <title>{`${node.label}${ref ? ` (${ref})` : ''}\n${kind} · ${node.stageText}${tasks ? ` · tasks ${tasks}` : ''}${blocking ? '\nnot settled yet: its tree waits on it' : ''}`}</title>
      {blocking && <rect x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={9} fill="none" stroke="var(--bad)" strokeWidth={1.5} strokeDasharray="3 2" />}
      <rect width={NODE_W} height={NODE_H} rx={RADIUS[node.kind]} fill="var(--card)"
        stroke={selected ? 'var(--foreground)' : COLOR[tone]} strokeWidth={selected ? 2 : 1.25} strokeDasharray={node.stage === 'no_job' ? '4 3' : undefined} />
      <rect width={5} height={NODE_H} rx={2} fill={COLOR[tone]} />
      <text data-slot="graph-node-title" x={12} y={16} fontSize={11} fill="var(--foreground)" fontWeight={500}>{short(node.label, tasks ? 24 : 30)}</text>
      {tasks && <text x={NODE_W - 8} y={16} fontSize={11} textAnchor="end" fill="var(--muted-foreground)" fontFamily="var(--font-mono, monospace)">{tasks}</text>}
      <text x={12} y={30} fontSize={9} fill="var(--muted-foreground)" fontFamily="var(--font-mono, monospace)">{ref && <tspan data-slot="graph-node-ref">{ref}</tspan>}{`${ref ? ' · ' : ''}${kind}`}</text>
      <text data-slot="graph-node-stage" x={12} y={45} fontSize={10} fill={COLOR[tone]}>{short(node.stageText, 34)}</text>
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
    <FitGraph slot="job-tree-graph" label="job tree" width={layout.width + 2 * PAD} height={layout.height + 2 * PAD}>
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
                <title>{`${byId.get(e.from)?.label ?? e.from} ${EDGE_TEXT[e.kind]} ${byId.get(e.to)?.label ?? e.to}`}</title>
              </path>
            );
          })}
          {layout.placed.map((p) => (
            <NodeBox key={p.id} node={byId.get(p.id)!} x={p.x} y={p.y} blocking={blocking.has(p.id)} selected={selected === p.id} onSelect={onSelect} />
          ))}
        </g>
    </FitGraph>
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
        <StageBadge stage={node.stage} text={node.stageText} />
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
        {node.status === 'waiting_on' && node.ownWait !== 'command' && <><dt>waits on</dt><dd data-slot="graph-node-waits-on"><WaitsOnLink on={node.waitOn} repo={node.repo} /></dd></>}
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

/** A tree, open or folded as a person left it; else open unless nothing blocks it and other trees show (`openFirst`). */
function TreeSection({ graph, tree, openFirst, selected, onSelect, children }: {
  graph: JobGraph; tree: JobTree; openFirst: boolean; selected: string | null; onSelect: (id: string) => void; children?: React.ReactNode;
}) {
  const [open, onToggle] = useGroupOpen(`jobs.tree.${tree.root}`, openFirst);
  const root = graph.nodes.find((n) => n.id === tree.root)!;
  const jobs = Object.values(tree.stages).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <section data-slot="job-tree" data-root={tree.root} data-open={open ? '' : undefined} className="rounded-lg border">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40">
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={root.label}>{root.label}</span>
        <span data-slot="job-tree-summary" className={cn('shrink-0 text-xs', tree.summary.includes('waiting on you') && !tree.summary.includes('nothing waiting') ? TEXT.question : 'text-muted-foreground')}>{tree.summary}</span>
        <span className="flex shrink-0 gap-1">
          {STAGES.filter((s) => tree.stages[s.stage]).map((s) => <StatusBadge key={s.stage} status={s.stage} tone={s.tone} label={`${tree.stages[s.stage]} ${s.label}`} />)}
        </span>
        <span className="num shrink-0 text-xs text-muted-foreground">{jobs} {jobs === 1 ? 'job' : 'jobs'}</span>
      </button>
      {open && <div className="space-y-2 border-t px-3 py-2"><TreeGraph graph={graph} tree={tree} selected={selected} onSelect={onSelect} />{children}</div>}
    </section>
  );
}

/** A row's run graph (issue #2372): the job tree its job is in, under the row, and a node's details on select. */
function RunGraph({ graph, node, laneOf, now }: { graph: JobGraph; node: JobGraphNode; laneOf: (laneId: string) => string; now: number }) {
  const tree = graph.trees.find((t) => t.nodes.includes(node.id));
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <tr data-slot="job-row-graph" data-job-id={node.jobId} className="bg-muted/20">
      <td colSpan={JOB_COLUMNS} className="space-y-2 px-4 py-2">
        {tree ? <TreeGraph graph={graph} tree={tree} selected={selected} onSelect={(id) => setSelected((s) => (s === id ? null : id))} />
          : <span className="text-xs text-muted-foreground">No run graph for this job.</span>}
        {selected && <NodeDetails graph={graph} id={selected} laneOf={laneOf} now={now} onClose={() => setSelected(null)} />}
      </td>
    </tr>
  );
}

function Legend() {
  return (
    <div data-slot="jobs-graph-legend" className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
      <span>rounded: job · square corners: pull request · between: issue</span>
      <span className={TEXT.bad}>dashed red ring and bold red line: not settled yet, on the way to the top of the tree</span>
      <span>hover a line to read it as a sentence</span>
    </div>
  );
}

export function Jobs() {
  const held = useHopper((s) => s.jobs);
  const locked = useHopper((s) => s.locked);
  const events = useHopper((s) => s.events);
  const machines = useHopper((s) => s.machines);
  const [graph, setGraph] = useState<JobGraph | null>(null);
  const [delivery, setDelivery] = useState<Map<string, DeliveryPosition>>(new Map());
  const [fetched, setFetched] = useState<DomainEvent[]>([]);
  const [picked, setFilter] = useState<JobsFilter>(NO_FILTER);
  const inFlight = useSection() === IN_FLIGHT_SECTION; // the hash's, so the header badge's link turns it on
  const filter = useMemo(() => ({ ...picked, inFlight }), [picked, inFlight]);
  const [mode, setMode] = usePagePref<Mode>('jobs.mode', 'list', MODE_NAMES);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const onToggle = useCallback((jobId: string) => setExpanded((e) => (e === jobId ? null : jobId)), []);
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  // Each job's last event, read once; the stream's events since are newer where they are a job's.
  useEffect(() => { get<{ events: DomainEvent[] }>('/api/jobs/last-events').then((r) => setFetched(r.events), () => {}); }, []);
  // The graph, read again (debounced) each time the store's jobs change: the store reads the queue after each event.
  useEffect(() => {
    let live = true;
    const soon = setTimeout(() => {
      get<JobGraph>('/api/jobs/graph').then((g) => { if (live) setGraph(g); }, () => {});
      get<DeliveryTracksView>('/api/delivery-tracks?state=open').then((v) => { if (live) setDelivery(new Map((v.tracks ?? []).map((t) => [t.jobId, { ...t.current, ...(t.hold ? { held: t.hold.owner } : {}) }]))); }, () => {});
    }, graph ? 150 : 0);
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
  const reset = `${filter.stage} ${filter.repo} ${filter.inFlight}`;
  const rowPage = usePaged(rows, ROWS_PER_PAGE, reset);
  const treePage = usePaged(trees, TREES_PER_PAGE, reset);
  const empty = graph === null ? 'reading the jobs…'
    : total === 0 ? 'No jobs yet. A job starts when a source takes an issue: label it and assign it as Sources says.'
      : 'No job matches the filters.';
  return (
    <Panel title="Jobs" icon={Briefcase}
      count={<span data-slot="jobs-count">{rows.length === total ? total : `${rows.length} of ${total}`}</span>}
      action={<div className="flex flex-wrap items-center gap-2">
        <ModeToggle slot="jobs-mode" value={mode} choices={MODES} onPick={setMode} />
        <InFlightToggle on={inFlight} />
        <Filter<JobStage> slot="jobs-filter-stage" label="Stage" value={filter.stage} choices={choices.stages} name={(s) => stageInfo(s).label} onPick={(stage) => setFilter((f) => ({ ...f, stage }))} />
        <Filter<string> slot="jobs-filter-repo" label="Repository" value={filter.repo} choices={choices.repos} name={(r) => r} onPick={(repo) => setFilter((f) => ({ ...f, repo }))} />
        <a href="/help/jobs" target="_blank" rel="noopener" className="text-muted-foreground hover:text-foreground" aria-label="Help for the Jobs view" title="Help for the Jobs view"><CircleHelp className="size-4" /></a>
      </div>}
      sticky toolbar={<StageCounts counts={counts} chosen={filter.stage} onPick={(stage) => setFilter((f) => ({ ...f, stage }))} />}
      bodyClassName="p-0">
      {mode === 'list' ? (
        <div data-slot="jobs-list">
          {rows.length ? <table className="w-full table-fixed border-collapse">
            <JobTableHead />
            <tbody className="divide-y">{rowPage.shown.map((n) => (
              <Fragment key={n.id}>
                <JobRow node={n} lane={n.laneId ? laneOf(n.laneId) : 'no lane'} last={last.get(n.jobId!)} since={n.stageSince ? elapsed(n.stageSince, minute * 60_000) : undefined}
                  delivery={delivery.get(n.jobId!)} expanded={expanded === n.jobId} onToggle={onToggle} />
                {expanded === n.jobId && <RunGraph graph={g} node={n} laneOf={laneOf} now={now} />}
              </Fragment>
            ))}</tbody>
          </table> : <Empty>{empty}</Empty>}
          <Pager p={rowPage} onPage={rowPage.setPage} className="border-t px-4 py-2" />
        </div>
      ) : (
        <div data-slot="jobs-graph" className="space-y-2 p-4">
          {trees.length ? <>
            <Legend />
            {treePage.shown.map((t) => (
              <TreeSection key={t.root} graph={g} tree={t} openFirst={!(t.blocking.length === 0 && trees.length > 1)}
                selected={selected} onSelect={(id) => setSelected((s) => (s === id ? null : id))}>
                {selected && t.nodes.includes(selected) && <NodeDetails graph={g} id={selected} laneOf={laneOf} now={now} onClose={() => setSelected(null)} />}
              </TreeSection>
            ))}
            <Pager p={treePage} onPage={treePage.setPage} />
          </> : <Empty>{empty}</Empty>}
        </div>
      )}
    </Panel>
  );
}
