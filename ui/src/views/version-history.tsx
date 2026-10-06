// The version history (issue #246): every version the installed hopper is made of, newest first —
// the day it landed and what it brought, in the plain words of What's new — with the installed one
// marked. In Settings, beside Version; read from GET /api/update/history.
import { ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import type { VersionHistory as History } from '@/model/wire';
import { useHopper } from '@/store';

const short = (sha: string) => sha.slice(0, 7);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

export function VersionHistory() {
  const installed = useHopper((s) => s.update?.installed?.commit);
  const [history, setHistory] = useState<History | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    get<History>('/api/update/history').then(setHistory, (e: Error) => setError(e.message));
  }, [installed]);
  const versions = history?.versions ?? [];
  return (
    <Panel title="Version history" icon={ScrollText} count={history ? versions.length : undefined} className="max-w-2xl" bodyClassName="p-0">
      {versions.length
        ? <ol data-slot="version-history">
          {versions.map((v) => (
            <li key={v.commit} data-slot="version" className="space-y-1 border-b px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-medium">{day(v.at)}</span>
                <span className="font-mono text-muted-foreground">{short(v.commit)}</span>
                {v.commit === installed && <span className="rounded border border-ok/40 px-1.5 text-[11px] text-ok">installed</span>}
              </div>
              <ul className="list-disc space-y-1 pl-4 text-sm">{v.changes.map((c) => <li key={c}>{c}</li>)}</ul>
            </li>
          ))}
        </ol>
        : <Empty>{error ?? history?.reason ?? (history ? 'no versions yet' : 'Loading…')}</Empty>}
    </Panel>
  );
}
