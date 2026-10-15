// Tagged (issue #1141): the open issues and pull requests of the job repositories that ask for your review, mention you, or
// are assigned to you, per GitHub source, as its last sync read them. Each row: the repository and number, the title, the
// author, why it is listed, its age, a pull request's checks, and a link to it on GitHub. A row leaves by itself once it is
// handled on GitHub (the review given, the pull request merged or closed, the issue closed); Dismiss takes it off for the
// reasons it has now, and a new reason shows it again. Always rendered: with no source that reads them, it says what will show.
import { AtSign, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GhLink } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import { TAGGED_WHY_LABEL, readsTagged, taggedDismissed, taggedOf } from '@/model/tagged';
import type { SourceStatus } from '@/model/wire';
import { actFor, useHopper } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { useCanOperate } from '@/store/selectors';
import type { TaggedItem } from '../../../src/domain/tagged.ts';

const CHECKS: Record<NonNullable<TaggedItem['checks']>, { text: string; cls: string }> = {
  passing: { text: 'checks pass', cls: 'text-ok' }, pending: { text: 'checks running', cls: 'text-warn' },
  failing: { text: 'checks fail', cls: 'text-bad' }, none: { text: 'no checks', cls: 'text-muted-foreground' }, unknown: { text: 'checks unknown', cls: 'text-muted-foreground' },
};

function Row({ x, source, canOperate, now }: { x: TaggedItem; source: string; canOperate: boolean; now: number }) {
  return (
    <li data-tagged={x.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="min-w-0 flex-1">
        <GhLink url={x.key} className="font-medium text-foreground">{x.repo}#{x.number}</GhLink>
        <span className="ml-2">{x.title}</span>
        <span className="block text-muted-foreground">
          {x.kind === 'pull' ? (x.isDraft ? 'draft pull request' : 'pull request') : 'issue'}
          {x.author ? ` by ${x.author}` : ''} · <span title={x.createdAt}>opened {ago(x.createdAt, now)}</span>
          {x.checks && <> · <span data-tagged-checks className={CHECKS[x.checks].cls}>{CHECKS[x.checks].text}</span></>}
        </span>
      </span>
      <span className="flex flex-wrap gap-1">
        {x.why.map((w) => <span key={w} data-tagged-why={w} className="rounded-full bg-muted px-2 py-0.5">{TAGGED_WHY_LABEL[w]}</span>)}
      </span>
      {canOperate && (
        <Button size="xs" variant="outline" title="Takes it off this list until it is tagged for a new reason. Nothing changes on GitHub."
          onClick={() => void actFor(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind: 'dismiss', keys: [x.key] }, 'Dismissed', intakeRefusal([x.key]))}>
          <EyeOff />Dismiss
        </Button>
      )}
    </li>
  );
}

function SourceTagged({ s }: { s: SourceStatus }) {
  const canOperate = useCanOperate();
  const now = useNow();
  const items = taggedOf(s);
  const dismissed = taggedDismissed(s);
  const error = typeof s.detail.taggedError === 'string' ? s.detail.taggedError : undefined;
  const at = typeof s.detail.taggedAt === 'string' ? s.detail.taggedAt : undefined;
  return (
    <Panel title={s.name} icon={AtSign} count={items.length || ''} bodyClassName="space-y-2 text-xs">
      <div data-tagged-source={s.name} className="space-y-2">
        {error !== undefined && <p data-tagged-error className="text-destructive">The last read failed: {error}. This shows what the read before it found.</p>}
        <p className="text-muted-foreground">
          {at ? <span title={at}>Read {ago(at, now)}</span> : 'Not read yet'}
          {dismissed > 0 && ` · ${dismissed} dismissed`}
        </p>
        {items.length === 0
          ? <Empty>Nothing tagged for you.</Empty>
          : <ul className="divide-y rounded-md border">{items.map((x) => <Row key={x.key} x={x} source={s.name} canOperate={canOperate} now={now} />)}</ul>}
      </div>
    </Panel>
  );
}

export function Tagged() {
  const sources = useHopper((s) => s.sources).filter(readsTagged);
  return (
    <div data-tagged-page className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The open issues and pull requests in your job repositories that ask for your review, mention you, or are assigned to you.
        Issues with the hopper label are on <a href="#intake" className="underline">Intake</a>, and your own pull requests on <a href="#pull-requests" className="underline">Pull requests</a>.
        An item leaves this list when you handle it on GitHub. <a href="/help/needs-you#tagged" className="underline">Help</a>
      </p>
      {sources.length === 0
        ? <Panel title="Tagged" icon={AtSign}><Empty>No job source reads tagged items yet. Connect GitHub on Sources: then each sync lists them here.</Empty></Panel>
        : sources.map((s) => <SourceTagged key={s.name} s={s} />)}
    </div>
  );
}
