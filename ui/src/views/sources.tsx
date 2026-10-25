// Job sources: where jobs come from, when each last synced, and what is wrong with it. The GitHub
// sources are one section (issue #160): the GitHub connection first (issue #214), with its source's
// sync inside it: the one way the hopper reads and writes GitHub (issues #359, #1377). Its summary line reads the sign-in
// the panel shows. Below it, each job repository's setup (issue #652).
// A source that takes the same work as an earlier one (issue #1264) is named in a banner at the top, with one click to remove it.
// More than one GitHub account (issue #1448): each further account has a panel of its own, with its source inside it, and Add
// another GitHub account, in the first account's panel once it is connected, takes a personal access token of another account.
// Below GitHub, the GitLab account (issue #1448 part 2), with its source's sync inside its panel. Each section and source
// folds, and stays folded over a reload (issue #2353).
import { useCallback, useEffect, useState } from 'react';
import { CopyX, Inbox, Trash2 } from 'lucide-react';
import { sendPluginsEdit } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Empty, FoldSection, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { sourcesView } from '@/model/sources';
import type { ConnectedAccountStatus, SourceStatus } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { AfterAnswer } from './after-answer';
import { ConnectedAccountPanel } from './connected-account';
import { GitLabSection } from './gitlab-account';
import { get } from '@/lib/api';
import { RepoSetupSection } from './repo-setup';
import { SourceSync } from './source-sync';

function SourceCard({ s }: { s: SourceStatus }) {
  return (
    <Panel title={s.name} icon={Inbox} fold={`sources.source.${s.name}`} action={<StatusBadge status={s.state} tone={s.state === 'ok' ? 'ok' : undefined} />} bodyClassName="space-y-3">
      <SourceSync s={s} />
    </Panel>
  );
}

/** Removes a duplicate source from the plugins config, at the version read just now. */
async function removeDuplicate(name: string): Promise<void> {
  await refreshPlugins();
  const version = useHopper.getState().plugins?.config.version;
  if (version) await sendPluginsEdit({ action: 'remove', role: 'job-source', name, version }, `Removed ${name}`);
}

/** The duplicate sources (issue #1264): each polls the same service again for the same work, so each has a Remove. */
function DuplicateBanner({ duplicates }: { duplicates: SourceStatus[] }) {
  const [busy, setBusy] = useState<string>();
  if (!duplicates.length) return null;
  return (
    <div data-duplicate-sources role="alert" className="space-y-1.5 rounded-md border border-bad/40 bg-bad/5 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-bad"><CopyX className="size-4" />
        {duplicates.length === 1 ? 'A job source is a duplicate' : `${duplicates.length} job sources are duplicates`}: each polls GitHub again for the same issues. Remove it.</div>
      {duplicates.map((d) => (
        <div key={d.name} className="flex flex-wrap items-center gap-2">
          <span><span className="font-mono">{d.name}</span> takes the same work as <span className="font-mono">{d.duplicateOf}</span></span>
          <Button size="xs" variant="outline" data-remove-duplicate={d.name} disabled={busy !== undefined}
            onClick={() => { setBusy(d.name); void removeDuplicate(d.name).finally(() => setBusy(undefined)); }}><Trash2 />Remove {d.name}</Button>
        </div>
      ))}
    </div>
  );
}

/** The further GitHub accounts' keys (issue #1448), read again after one is added or removed. */
function useFurtherKeys(): [ConnectedAccountStatus['key'][], () => void] {
  const [keys, setKeys] = useState<ConnectedAccountStatus['key'][]>([]);
  const read = useCallback(() => {
    void get<{ accounts: ConnectedAccountStatus[] }>('/api/connected-accounts').then((v) => setKeys(v.accounts.map((a) => a.key).filter((k) => k !== 'github')), () => {});
  }, []);
  useEffect(read, [read]);
  return [keys, read];
}

export function Sources() {
  const sources = useHopper((s) => s.sources);
  const [signIn, setSignIn] = useState<ConnectedAccountStatus>();
  const [further, readFurther] = useFurtherKeys();
  const v = sourcesView(sources, signIn);
  return (
    <div className="space-y-4">
      <DuplicateBanner duplicates={v.duplicates} />
      <FoldSection id="sources-github" title="GitHub" fold="sources.github" line={<p data-github-summary className="text-xs text-muted-foreground">{v.summary}</p>}>
        <div className="grid gap-3 lg:grid-cols-2">
          <ConnectedAccountPanel provider="github" source={v.account} onStatus={setSignIn} onAdded={readFurther} />
          {further.map((k) => <ConnectedAccountPanel key={k} provider="github" accountKey={k} source={v.further[k]} onRemoved={readFurther} />)}
          {v.github.map((s) => <SourceCard key={s.name} s={s} />)}
        </div>
      </FoldSection>
      <GitLabSection source={v.gitlab} />
      <RepoSetupSection />
      {v.others.length > 0 && (
        <section className="grid gap-3 lg:grid-cols-2">{v.others.map((s) => <SourceCard key={s.name} s={s} />)}</section>
      )}
      <AfterAnswer />
      {!sources.length && <Panel title="Sources" icon={Inbox}><Empty>no job sources configured</Empty></Panel>}
    </div>
  );
}
