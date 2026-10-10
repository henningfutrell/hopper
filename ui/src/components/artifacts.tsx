// Artifacts on the cards (issue #624): a job's artifacts as links to the Artifacts view — on every card that names a
// job (its title) —, an artifact's preview, and the previews a proposal or a research report embeds by linking an
// artifact. HTML shows only in a sandboxed frame: its scripts run, but it has no origin of the hopper's; a Markdown
// preview is rendered into a frame where nothing runs.
import { marked } from 'marked';
import Papa from 'papaparse';
import { Paperclip } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { artifactsOfJob, findArtifact, FRAME_SANDBOX, previewOf, referencedArtifacts } from '@/model/artifacts';
import type { ArtifactView } from '@/model/wire';
import { useArtifacts } from '@/store/artifacts';
import { cn } from '@/lib/utils';

/** A job's artifacts, each a link to it in the Artifacts view. Nothing when the job has none. */
export function ArtifactChips({ jobId, className }: { jobId: string; className?: string }) {
  const view = useArtifacts((s) => s.view);
  const list = useMemo(() => artifactsOfJob(view, jobId), [view, jobId]);
  if (list.length === 0) return null;
  return (
    <span data-slot="artifact-chips" className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {list.slice(0, 3).map((a) => (
        <a key={a.id} href={`#artifacts/${a.id}`} title={a.summary ? `${a.title}: ${a.summary}` : a.title} onClick={(e) => e.stopPropagation()}
          className="inline-flex max-w-32 items-center gap-0.5 rounded border px-1 text-[10px] text-muted-foreground hover:text-foreground">
          <Paperclip className="size-2.5 shrink-0" /><span className="truncate">{a.title}</span>
        </a>
      ))}
      {list.length > 3 && <a href="#artifacts" className="text-[10px] text-muted-foreground hover:text-foreground">+{list.length - 3}</a>}
    </span>
  );
}

/** The artifact's content as text, for the previews that read it. */
function useText(url: string): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((t) => { if (live) setText(t); }, () => { if (live) setText(''); });
    return () => { live = false; };
  }, [url]);
  return text;
}

const CSV_ROWS = 50;
const TEXT_MAX = 200_000;

function CsvPreview({ url }: { url: string }) {
  const text = useText(url);
  if (text === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const rows = Papa.parse<string[]>(text.slice(0, TEXT_MAX), { skipEmptyLines: true, preview: CSV_ROWS + 1 }).data;
  const [head, ...body] = rows;
  return (
    <div className="max-h-96 overflow-auto rounded border">
      <table className="w-full text-xs">
        {head && <thead className="sticky top-0 bg-muted"><tr>{head.map((h, i) => <th key={i} className="px-2 py-1 text-left font-medium">{h}</th>)}</tr></thead>}
        <tbody>{body.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="px-2 py-1 font-mono">{c}</td>)}</tr>)}</tbody>
      </table>
      {body.length >= CSV_ROWS && <p className="p-2 text-xs text-muted-foreground">The first {CSV_ROWS} rows. Open it for all.</p>}
    </div>
  );
}

function MarkdownPreview({ url, title, height }: { url: string; title: string; height: number }) {
  const text = useText(url);
  const doc = useMemo(() => (text === null ? null
    : `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#222}pre{overflow:auto;background:#f4f4f4;padding:8px}img{max-width:100%}</style>${marked.parse(text.slice(0, TEXT_MAX), { async: false })}`), [text]);
  if (doc === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  // An empty sandbox: the rendered HTML runs nothing and reaches nothing.
  return <iframe title={title} sandbox="" srcDoc={doc} className="w-full rounded border bg-white" style={{ height }} />;
}

function TextPreview({ url }: { url: string }) {
  const text = useText(url);
  return <pre className="max-h-96 overflow-auto rounded border bg-muted/40 p-2 text-xs">{text === null ? 'Loading…' : text.slice(0, TEXT_MAX)}</pre>;
}

/** The artifact as its kind shows it; a file of another kind is a download only. */
export function ArtifactPreview({ artifact: a, height = 420 }: { artifact: Pick<ArtifactView, 'kind' | 'contentUrl' | 'title' | 'type'>; height?: number }) {
  const mode = previewOf(a.kind);
  switch (mode) {
    case 'frame':
      return <iframe data-slot="artifact-frame" title={a.title} src={a.contentUrl} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" className="w-full rounded border bg-white" style={{ height }} />;
    case 'image':
      return <img src={a.contentUrl} alt={a.title} referrerPolicy="no-referrer" className="max-h-[32rem] max-w-full rounded border bg-white object-contain" />;
    case 'pdf':
      return <iframe title={a.title} src={a.contentUrl} className="w-full rounded border" style={{ height }} />;
    case 'csv':
      return <CsvPreview url={a.contentUrl} />;
    case 'markdown':
      return <MarkdownPreview url={a.contentUrl} title={a.title} height={height} />;
    case 'text':
      return <TextPreview url={a.contentUrl} />;
    default:
      return <p className="text-xs text-muted-foreground">No preview for {a.type}. <a className="underline" href={`${a.contentUrl}&download=1`}>Download it</a>.</p>;
  }
}

/** The artifacts a text links to, previewed below it: how a proposal or a research report embeds one. */
export function ArtifactEmbeds({ text }: { text: string }) {
  const view = useArtifacts((s) => s.view);
  const found = referencedArtifacts(text).map((id) => findArtifact(view, id)).filter((a): a is ArtifactView => a !== undefined);
  if (found.length === 0) return null;
  return (
    <div data-slot="artifact-embeds" className="space-y-2">
      {found.map((a) => (
        <figure key={a.id} className="space-y-1">
          <ArtifactPreview artifact={a} height={320} />
          <figcaption className="text-xs text-muted-foreground"><a className="hover:underline" href={`#artifacts/${a.id}`}>{a.title}</a>{a.summary ? ` — ${a.summary}` : ''}</figcaption>
        </figure>
      ))}
    </div>
  );
}
