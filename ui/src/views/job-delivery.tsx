// A job's kept delivery track on its job view (issue #2775, design.md "Kept delivery tracks"): GET /api/delivery-tracks
// ?job=, read again as the job's state changes. A job in progress shows the delivery step it is in, since when and what it
// waits on; a completed one its deployment record — delivered, with its pull request, or no deployment expected, with its
// source and outcome. Then every step it started and ended. Until its deployment completes a person flips its deployment
// expectation here (POST /ui/api/delivery-tracks/no-deploy|deploy), and each flip is listed; a delivered record is final.
// Each text edit of its item is listed too: when, at which step, and who edited it (part 3). A delivered record names the
// merge commit of the batch run that landed it, when the hopper knows it (part 4). The acts its step allows (part 8): Hold
// and Take ownership put a delivery hold on the change (POST /ui/api/delivery-tracks/hold), Release lets it go on or hands it
// back (POST /ui/api/delivery-tracks/release); its hold and each person's act on its change are listed. A record of a job
// that ran again links the new job, whose own track carries the work on (part 9).
import { Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { stepLabel } from '@/model/delivery-forecast';
import { jobHref } from '@/model/job';
import type { DeliveryTracksView, DeploymentRecord, Job, KeptTrack } from '@/model/wire';
import { useHopper } from '@/store';

const OUTCOMES: Record<string, string> = {
  finished: 'the job finished with no change to deliver', failed: 'the job failed', cancelled: 'the job was cancelled', rejected: 'the job was turned away',
  pull_request_closed: 'its pull request was closed with no merge', marked: 'a person marked it no-deploy',
  rerouted: 'its item ran again in a new job',
};

function Record({ d }: { d: DeploymentRecord }) {
  if (d.kind === 'deploy') {
    return (
      <div data-slot="job-delivery-record">
        Delivered to {d.target} at <span className="num">{d.at}</span>: <a href={d.artifact.pullRequest} target="_blank" rel="noreferrer" className="underline underline-offset-4">its pull request</a>{d.artifact.commit ? <>, commit <span className="num">{d.artifact.commit.slice(0, 12)}</span></> : ''}. This record is final.
      </div>
    );
  }
  const o = d.outcome;
  return (
    <div data-slot="job-delivery-record">
      No deployment expected: {OUTCOMES[o.status] ?? o.status}{o.report ? ` (a ${o.report} report)` : ''}{o.by ? `, by ${o.by}` : ''}{o.note ? ` — ${o.note}` : ''}. From {d.source}.{o.nextJob ? <> <a data-slot="job-delivery-next" href={jobHref(o.nextJob)} className="underline underline-offset-4">The new job's track</a>.</> : ''}
    </div>
  );
}

/** The flips a track offers: none once its deployment completed; no-deploy while open; deploy unless a person's last flip is deploy. */
function Flips({ track, onFlipped }: { track: KeptTrack; onFlipped: (t: KeptTrack) => void }) {
  const [busy, setBusy] = useState(false);
  if (track.deployment?.kind === 'deploy') return null;
  const flip = async (path: 'no-deploy' | 'deploy') => {
    setBusy(true);
    try {
      onFlipped(await post<KeptTrack>(`/ui/api/delivery-tracks/${path}`, { job: track.jobId }));
      toast.success(path === 'deploy' ? 'A deployment is expected' : 'Marked no-deploy');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator changes what a job deploys' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="flex gap-2 pt-1">
      {track.state === 'open' && <Button data-slot="job-delivery-no-deploy" size="sm" variant="outline" disabled={busy} onClick={() => void flip('no-deploy')}>Mark no-deploy</Button>}
      {track.expectations?.at(-1)?.expect !== 'deploy' && <Button data-slot="job-delivery-deploy" size="sm" variant="outline" disabled={busy} onClick={() => void flip('deploy')}>Expect a deployment</Button>}
    </div>
  );
}

/** The hold acts the track's step allows: Hold, Take ownership, Release. The other acts are the job page's own buttons. */
function HoldActs({ track, onChanged }: { track: KeptTrack; onChanged: (t: KeptTrack) => void }) {
  const [busy, setBusy] = useState(false);
  const acts = track.acts ?? [];
  const act = async (path: 'hold' | 'release', body: Record<string, string>, done: string) => {
    setBusy(true);
    try {
      onChanged(await post<KeptTrack>(`/ui/api/delivery-tracks/${path}`, { job: track.jobId, ...body }));
      toast.success(done);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator holds or releases a job\'s change' : (e as Error).message);
    }
    setBusy(false);
  };
  if (!acts.some((a) => a === 'hold' || a === 'take_ownership' || a === 'release')) return null;
  return (
    <div className="flex gap-2 pt-1">
      {acts.includes('hold') && <Button data-slot="job-delivery-hold" size="sm" variant="outline" disabled={busy} onClick={() => void act('hold', {}, 'Held: the hopper does not merge or promote it')}>Hold</Button>}
      {acts.includes('take_ownership') && <Button data-slot="job-delivery-take-ownership" size="sm" variant="outline" disabled={busy} onClick={() => void act('hold', { owner: 'person' }, 'You own this change until you hand it back')}>Take ownership</Button>}
      {acts.includes('release') && <Button data-slot="job-delivery-release" size="sm" variant="outline" disabled={busy} onClick={() => void act('release', {}, 'Released: the hopper goes on with it')}>{track.hold?.owner === 'person' ? 'Hand back' : 'Release'}</Button>}
    </div>
  );
}

const ACTS: Record<string, string> = {
  park: 'Parked', pick_up: 'Picked up', run_again: 'Ran again', merge_now: 'Merged now', expedite: 'Expedite', hold: 'Held', release: 'Released',
};

export function JobDelivery({ job }: { job: Job }) {
  const [track, setTrack] = useState<KeptTrack | null | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    get<DeliveryTracksView>(`/api/delivery-tracks?job=${encodeURIComponent(job.id)}`).then((v) => { if (!gone) setTrack(v.tracks?.[0] ?? null); }, () => { if (!gone) setTrack(undefined); });
    return () => { gone = true; };
  }, [job.id, job.status]);
  if (track === undefined) return null;
  return (
    <Panel title="Delivery" icon={Truck} bodyClassName="space-y-1 p-3 text-sm">
      {track === null ? <Empty><span data-slot="job-delivery-none">No delivery track yet: the hopper keeps one within a minute of the job's start.</span></Empty> : (
        <>
          {track.state === 'open' ? (
            <>
              <div data-slot="job-delivery-current"><span className="font-medium">{stepLabel(track.current.step)}</span>, for <Since iso={track.current.since} /></div>
              <div data-slot="job-delivery-waits" className="text-xs text-muted-foreground">Waits on {track.current.waitingOn}</div>
            </>
          ) : track.deployment && <Record d={track.deployment} />}
          {track.hold && (
            <div data-slot="job-delivery-hold-state" className="text-xs">
              {track.hold.owner === 'person' ? `${track.hold.by} owns this change` : `Held by ${track.hold.by}`} at {stepLabel(track.hold.step)} since <span className="num">{track.hold.at}</span>{track.hold.reason ? ` — ${track.hold.reason}` : ''}
            </div>
          )}
          <HoldActs track={track} onChanged={setTrack} />
          <Flips track={track} onFlipped={setTrack} />
          {track.expectations?.map((x) => (
            <div key={`${x.at}-${x.expect}`} data-slot="job-delivery-expectation" className="text-xs text-muted-foreground">
              {x.expect === 'deploy' ? 'Expect a deployment' : 'No deploy'}, by {x.by} at <span className="num">{x.at}</span>{x.note ? ` — ${x.note}` : ''}
            </div>
          ))}
          {track.interventions?.map((x) => (
            <div key={x.seq} data-slot="job-delivery-intervention" className="text-xs text-muted-foreground">
              {x.act === 'hold' && x.owner === 'person' ? 'Ownership taken' : x.act === 'expedite' ? `Expedite ${x.expedite ? 'on' : 'off'}` : ACTS[x.act] ?? x.act}, by {x.by} at <span className="num">{x.at}</span>, in {stepLabel(x.step)}{x.reason ? ` — ${x.reason}` : ''}
            </div>
          ))}
          {track.textEdits?.map((x) => (
            <div key={x.seq} data-slot="job-delivery-text-edit" className="text-xs text-muted-foreground">
              Item text edited at <span className="num">{x.at}</span>, in {stepLabel(x.step)}{x.editors.length > 0 ? `, by ${x.editors.join(', ')}` : ''}
            </div>
          ))}
          {track.steps.map((s) => (
            <div key={s.step} data-slot="job-delivery-step" className="text-xs text-muted-foreground">
              {stepLabel(s.step)}: <span className="num">{s.start}</span>{s.end ? <> → <span className="num">{s.end}</span></> : ' → now'}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
