// The version history (issue #246): every version the installed hopper is made of, newest first —
// the day it landed and what it brought, in the plain words of What's new — with the installed one
// marked. In Settings, beside Version; read from GET /api/update/history. Above the list, what the running
// build knows of itself (issue #409): its version, how it was built, its repository, branch, commit and build
// time — whatever it knows, with a short note on what it lacks, never an error in place of the page.
import { ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import type { VersionHistory as History } from '@/model/wire';
import { useHopper } from '@/store';

const short = (sha: string) => sha.slice(0, 7);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const BUILT_BY = { install: 'install', image: 'container image' } as const;

function BuildInfo({ build }: { build: History['build'] | undefined }) {
  const version = useHopper((s) => s.health?.version);
  const rows: [string, string | undefined, boolean?][] = [
    ['Version', version, true],
    ['Built as', build?.kind && BUILT_BY[build.kind]],
    ['Repository', build?.repo, true],
    ['Branch', build?.branch, true],
    ['Commit', build?.commit && short(build.commit), true],
    ['Built', build?.installedAt && new Date(build.installedAt).toLocaleString()],
  ];
  return (
    <dl data-slot="build-info" className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b px-4 py-3 text-xs">
      {rows.map(([label, value, mono]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={value ? (mono ? 'font-mono break-all' : '') : 'text-muted-foreground'}>{value ?? 'unknown'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function VersionHistory() {
  const installed = useHopper((s) => s.update?.installed?.commit);
  const [history, setHistory] = useState<History | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    get<History>('/api/update/history').then(setHistory, (e: Error) => setError(e.message));
  }, [installed]);
  const versions = history?.versions ?? [];
  const note = error ?? history?.reason;
  return (
    <Panel title="Version history" icon={ScrollText} count={history ? versions.length : undefined} className="max-w-2xl" bodyClassName="p-0">
      <BuildInfo build={history?.build} />
      {note && <p data-slot="build-note" className="border-b px-4 py-2 text-xs break-words text-muted-foreground">{note}</p>}
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
        : <Empty>{history || error ? 'No versions to list' : 'Loading…'}</Empty>}
    </Panel>
  );
}
