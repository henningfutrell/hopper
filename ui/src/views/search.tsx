// The Search view (issue #945, design.md "Search"): the search the hash holds (#search/q=…&status=…, model/search.ts), read
// from GET /api/search — the same route the operator CLI and an agent use. Each hit links to its view (a job's, an
// artifact's, Infra for a plan), its title and up to two snippets with the matched words marked (read as text, never
// HTML); the facets count what matched and filter when picked; the page moves on by 20. When search is degraded or not set up it says why and shows no hits: nothing
// else in the hopper waits on it. A long page (issue #2353): the header with the search form stays in view.
import { AlertTriangle, ChevronLeft, ChevronRight, Search as SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { highlightParts, hitHref, linksOut, PAGE, parseSearch, picked, searchHash, searchPath, snippets, toggleFilter, TYPE_LABEL, type SearchFilters } from '@/model/search';
import type { SearchAnswer, SearchFacet } from '@/model/wire';
import { useSection } from '@/app/nav';

/** A highlight: text, each match in a <mark>. */
export function Highlight({ html }: { html: string }) {
  return <>{highlightParts(html).map((p, i) => (p.mark ? <mark key={i} className="rounded-sm bg-warn/25 px-0.5 text-foreground">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

const FACET_LABEL: Record<SearchFacet, string> = { type: 'Type', status: 'Status', labels: 'Labels', repo: 'Repository' };
const FACETS: readonly SearchFacet[] = ['status', 'labels', 'repo', 'type'];

const go = (f: SearchFilters): void => { window.location.hash = searchHash(f); };

type Hit = SearchAnswer['hits'][number];

function HitRow({ h }: { h: Hit }) {
  const title = h.highlights.title?.[0];
  return (
    <li data-slot="search-hit" className="grid gap-1 border-b py-2.5 text-sm last:border-b-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <a href={hitHref(h)} {...(linksOut(h) ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className="min-w-0 truncate font-medium hover:underline">{title ? <Highlight html={title} /> : h.title}</a>
        <span className="flex shrink-0 items-center gap-1.5">
          {TYPE_LABEL[h.type] && <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{TYPE_LABEL[h.type]}</Badge>}
          {h.status && <StatusBadge status={h.status} />}
        </span>
      </div>
      {snippets(h.highlights).map((s, i) => (
        <p key={i} className="line-clamp-2 text-xs text-muted-foreground"><span className="font-medium">{s.label}:</span> <Highlight html={s.html} /></p>
      ))}
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {h.repo && <span className="font-mono">{h.repo}</span>}
        {h.labels.map((l) => <Badge key={l} variant="outline" className="h-5 px-1.5 text-[11px]">{l}</Badge>)}
        <span>updated {new Date(h.updated).toLocaleString()}</span>
      </p>
    </li>
  );
}

function Facets({ f, answer }: { f: SearchFilters; answer: SearchAnswer }) {
  return (
    <div className="grid content-start gap-3 text-sm">
      {FACETS.map((facet) => {
        const values = Object.entries(answer.facets[facet] ?? {});
        // A value picked stays shown, so it can be put back even when nothing matches it now.
        const shown = [...values, ...f[facet === 'labels' ? 'label' : facet].filter((v) => !values.some(([k]) => k === v)).map((v) => [v, 0] as [string, number])];
        if (shown.length === 0) return null;
        return (
          <div key={facet} className="grid gap-1">
            <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{FACET_LABEL[facet]}</h3>
            <div className="flex flex-wrap gap-1">
              {shown.map(([value, n]) => {
                const on = picked(f, facet, value);
                return (
                  <button key={value} type="button" data-slot="search-facet" data-facet={facet} data-value={value} aria-pressed={on} onClick={() => go(toggleFilter(f, facet, value))}
                    className={cn('flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-muted/60', on && 'border-foreground/40 bg-muted text-foreground')}>
                    <span className="max-w-48 truncate">{value}</span><span className="num text-muted-foreground">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The words, as the hash holds them until the person changes them; a new search in the hash starts them again (`key`). */
function SearchForm({ f }: { f: SearchFilters }) {
  const [words, setWords] = useState(f.q);
  return (
    <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); go({ ...f, q: words, offset: 0 }); }}>
      <Input aria-label="Search jobs" placeholder="Search jobs: titles, briefs, results, questions, failures" value={words} onChange={(e) => setWords(e.target.value)} />
      <Button type="submit" size="sm"><SearchIcon />Search</Button>
    </form>
  );
}

/** Read when shown, and again each time the hash's search changes. */
export function Search() {
  const section = useSection();
  const f = parseSearch(section);
  const path = searchPath(f);
  const [read, setRead] = useState<{ path: string; answer?: SearchAnswer; error?: string } | null>(null);
  useEffect(() => {
    let gone = false;
    get<SearchAnswer>(path).then((answer) => { if (!gone) setRead({ path, answer }); }, (e: Error) => { if (!gone) setRead({ path, error: e.message }); });
    return () => { gone = true; };
  }, [path]);
  const current = read?.path === path ? read : null;
  const answer = current?.answer;
  const down = answer && answer.state !== 'ok' ? answer : undefined;
  return (
    <Panel title="Search" icon={SearchIcon} count={answer && answer.state === 'ok' ? answer.total : undefined}
      sticky toolbar={<div className="px-4 pb-3"><SearchForm key={f.q} f={f} /></div>}>
      <div className="space-y-3">
        {current?.error && <p className="text-sm text-bad">Could not search: {current.error}</p>}
        {down && (
          <div data-slot="search-state" data-state={down.state} className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{down.state === 'not-configured' ? 'Search is not set up' : 'Search is degraded'}{down.why ? `: ${down.why}` : ''}. The rest of the hopper works as before.</span>
          </div>
        )}
        {!current
          ? <p className="text-sm text-muted-foreground">Searching…</p>
          : answer && (
            <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
              <div className="min-w-0">
                <p data-slot="search-total" className="text-xs text-muted-foreground">
                  {answer.total === 1 ? '1 job matches' : `${answer.total} jobs match`}{answer.total > 0 && ` · ${f.offset + 1}–${f.offset + answer.hits.length}`}
                </p>
                {answer.hits.length === 0
                  ? (!down && <Empty>No job matches. Try fewer words, or take a filter off.</Empty>)
                  : <ul>{answer.hits.map((h) => <HitRow key={`${h.type}/${h.ref}`} h={h} />)}</ul>}
                {(f.offset > 0 || f.offset + PAGE < answer.total) && (
                  <div className="flex justify-between pt-2">
                    <Button size="sm" variant="outline" disabled={f.offset === 0} onClick={() => go({ ...f, offset: Math.max(0, f.offset - PAGE) })}><ChevronLeft />Back</Button>
                    <Button size="sm" variant="outline" disabled={f.offset + PAGE >= answer.total} onClick={() => go({ ...f, offset: f.offset + PAGE })}>More<ChevronRight /></Button>
                  </div>
                )}
              </div>
              <Facets f={f} answer={answer} />
            </div>
          )}
      </div>
    </Panel>
  );
}
