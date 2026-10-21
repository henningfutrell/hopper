// The search box in the header (issue #945, design.md "Search"), on every screen from tablet width: as a person types,
// job titles whose words start with what they typed (GET /api/search/suggest, after a short pause) open below it, each a
// link to its job; Enter opens the Search view on the words. Search degraded or not set up: no suggestions, and Enter
// still opens the view, which says why. On a phone the Search entry in the navigation drawer opens the view.
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { get } from '@/lib/api';
import { emptySearch, hitHref, linksOut, searchHash, suggestPath } from '@/model/search';
import type { SuggestAnswer } from '@/model/wire';

const PAUSE_MS = 150;
const MIN_CHARS = 2;

export function SearchBox() {
  const [words, setWords] = useState('');
  const [open, setOpen] = useState(false);
  // The suggestions with the words they are for: a stale answer, or one for words since cut short, is not shown.
  const [found, setFound] = useState<{ q: string; suggestions: SuggestAnswer['suggestions'] }>({ q: '', suggestions: [] });
  const asked = useRef('');
  const q = words.trim();
  useEffect(() => {
    if (q.length < MIN_CHARS) return undefined;
    const timer = setTimeout(() => {
      asked.current = q;
      get<SuggestAnswer>(suggestPath(q)).then((a) => { if (asked.current === q) setFound({ q, suggestions: a.suggestions ?? [] }); }, () => { if (asked.current === q) setFound({ q, suggestions: [] }); });
    }, PAUSE_MS);
    return () => clearTimeout(timer);
  }, [q]);
  const suggestions = found.q === q ? found.suggestions : [];
  const close = () => { setOpen(false); };
  return (
    <form data-slot="search-box" role="search" className="relative w-full max-w-xs"
      onSubmit={(e) => { e.preventDefault(); close(); window.location.hash = searchHash(emptySearch(q)); }}>
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input type="search" aria-label="Search jobs" placeholder="Search jobs" value={words} autoComplete="off"
        onChange={(e) => { setWords(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(close, 150)}
        onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
        className="h-8 w-full rounded-lg border border-input bg-transparent pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" />
      {open && suggestions.length > 0 && (
        <ul className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border bg-popover py-1 text-sm shadow-md">
          {suggestions.map((s) => (
            <li key={`${s.type}/${s.ref}`}>
              <a data-slot="search-suggestion" href={hitHref(s)} {...(linksOut(s) ? { target: '_blank', rel: 'noopener noreferrer' } : {})} onClick={close} className="block truncate px-3 py-1.5 hover:bg-muted/60">{s.title}</a>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
