// What a sandbox ask is for (issue #1001), on a template card and a sandbox run card: why the job asks, in its own words;
// the job, by its title and its issue or pull request; what the box will do; and each need in plain words. A person
// approves or declines from the card alone.
import type { OperationProfile, VaultSecret } from '@/model/wire';
import { needText } from '@/model/vault';

export function SandboxAsk({ purpose, plan, job, needs, secrets }: {
  purpose?: string | undefined; plan?: string | undefined; job?: { id: string; title?: string | undefined; url?: string | undefined } | undefined;
  needs?: readonly OperationProfile[] | undefined; secrets: readonly VaultSecret[];
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">Why</dt>
      <dd data-slot="why" className="break-words">{purpose ?? <span className="text-muted-foreground">Not said: a person or an older job asked for it.</span>}</dd>
      {job && (
        <>
          <dt className="text-muted-foreground">Job</dt>
          <dd data-slot="job" className="break-words">
            <a href={`#jobs/${job.id}`} className="font-mono underline">{job.id.slice(0, 8)}</a>
            {job.title ? <>: {job.title}</> : null}
            {job.url ? <> · <a href={job.url} target="_blank" rel="noreferrer" className="underline">issue or pull request</a></> : null}
          </dd>
        </>
      )}
      {plan && (
        <>
          <dt className="text-muted-foreground">Plan</dt>
          <dd data-slot="plan" className="whitespace-pre-wrap break-words">{plan}</dd>
        </>
      )}
      {needs && needs.length > 0 && (
        <>
          <dt className="text-muted-foreground">Needs</dt>
          <dd data-slot="needs"><ul>{needs.map((p) => <li key={`${p.operation}/${p.asset.kind}/${p.asset.name}`} className="break-words">{needText(p, secrets)}</li>)}</ul></dd>
        </>
      )}
    </dl>
  );
}
