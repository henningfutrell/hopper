// What a job's own wait waits on (issue #1245): a link where it is a page, words where it is not. The Queue view, the job
// view and the job graph's node details show it the same way.
import { waitOnLinkOf } from '@/model/board';
import type { WaitOn } from '@/model/wire';

/** `repo`: the job's own repository, where a pull request or an item that names none is. */
export function WaitsOnLink({ on, repo }: { on: WaitOn | undefined; repo: string | undefined }) {
  const l = waitOnLinkOf(on, repo);
  return l.href
    ? <a data-slot="waits-on" href={l.href} target={l.href.startsWith('#') ? undefined : '_blank'} rel="noreferrer" className="font-medium underline">{l.label}</a>
    : <span data-slot="waits-on" className="font-medium text-foreground/90">{l.label}</span>;
}
