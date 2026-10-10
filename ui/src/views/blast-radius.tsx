// Blast radius on the Machines view (issue #542): the gate in one sentence; each machine's level and what set it — its
// reach, or a box's template (issue #605) —, whether it is gated
// and why, an actor machine's declaration and whether its rating matches, a radius that grew, when it was last
// discovered and what changed; on demand its evidence — every reach with its access, prod or not, and why —, its tools
// and its credential sources (names only). An operator discovers a machine now; an admin edits the settings, applied
// at the next Decision. A viewer reads only.
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Since } from '@/components/job';
import { Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { changesText, levelTone, radiusText, summaryOf } from '@/model/blast-radius';
import type { ActorMachine, BlastRadiusView, GateAt, MachineRadiusView, RadiusLevel, UnconfirmedAs } from '@/model/wire';
import { useHopper } from '@/store';
import { discoverNow, refreshBlastRadiusSoon, saveBlastRadiusSettings, type BlastRadiusPatch } from '@/store/blast-radius';
import { useCanAdmin, useCanOperate } from '@/store/selectors';

const LEVELS: RadiusLevel[] = ['low', 'medium', 'high'];
const csv = (xs: string[]): string => xs.join(', ');
const fromCsv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);

function Evidence({ m }: { m: MachineRadiusView }) {
  const f = m.discovery?.facts;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Evidence, tools and credential sources</summary>
      <div className="mt-2 space-y-2">
        {m.rating && m.rating.reach.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem]">
              <thead className="text-left text-muted-foreground"><tr><th className="py-1 font-normal">Reach</th><th className="py-1 font-normal">Access</th><th className="py-1 font-normal">Why</th></tr></thead>
              <tbody className="divide-y">
                {m.rating.reach.map((r, i) => (
                  <tr key={i} data-reach={r.kind}>
                    <td className="py-1 font-mono">{r.kind} {r.target}{r.prod && <span className="ml-1 text-bad">prod</span>}</td>
                    <td className="py-1">{r.access}</td>
                    <td className="py-1 text-muted-foreground">{r.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {f && <>
          <p><span className="text-muted-foreground">Tools: </span>{Object.entries(f.versions).map(([t, v]) => `${t} (${v})`).join(', ') || 'none of aws, terraform, tofu, kubectl'}; {f.bins.length} executables on a PATH of {f.path.length} directories</p>
          <p><span className="text-muted-foreground">Credential sources: </span>{[...f.credentials.env, ...f.credentials.files].join(', ') || 'none'}</p>
        </>}
      </div>
    </details>
  );
}

function MachineRow({ m, operator }: { m: MachineRadiusView; operator: boolean }) {
  const [busy, setBusy] = useState(false);
  const d = m.discovery;
  return (
    <div data-radius-machine={m.machineId} className="space-y-1.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium">{m.label}</span>
        <StatusBadge status={m.radius?.level ?? 'not discovered'} tone={levelTone(m.radius?.level)} label={radiusText(m)} />
        {m.gated && <StatusBadge status="gated" tone="warn" title={`Only jobs let through the gate run here: ${m.gated}`} label="gated" />}
        {m.actor && <StatusBadge status="actor" tone="operator" label={`actor: ${m.actor.purpose}`} title={`Declared ${m.actor.expected}`} />}
        {m.actor?.mismatch && <StatusBadge status="mismatch" tone="bad" label={`declared ${m.actor.expected}, rated ${m.radius?.level}`} />}
        {d?.grew && <StatusBadge status="grew" tone="bad" label={`grew ${d.grew.from} → ${d.grew.to}`} title={`Since ${d.grew.at}`} />}
        {operator && m.discoverable && m.online && (
          <Button size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={async () => { setBusy(true); await discoverNow(m.machineId); setBusy(false); }}>
            <RefreshCw />Discover
          </Button>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {!m.discoverable ? 'Cannot be discovered: no shell reaches it (a container target).'
          : !d ? (m.online ? 'Not discovered yet.' : 'Offline: discovered when it comes online.')
            : <>discovered <Since iso={d.at} /> ago · {d.changes ? changesText(d.changes) : 'no change recorded'}{d.error && <span className="text-bad"> · last discovery failed: {d.error}</span>}</>}
      </div>
      {m.gated && <div className="text-xs text-warn">{m.gated}: only jobs let through the gate run here</div>}
      {m.rating && <ul className="list-disc pl-5 text-xs text-muted-foreground">{m.rating.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {m.template && (
        <div data-box-template={m.template.name} className="text-xs text-muted-foreground">
          A box of template {m.template.name}, rated {m.template.radius.level}:
          <ul className="list-disc pl-5">{m.template.radius.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {d?.facts && <Evidence m={m} />}
    </div>
  );
}

function ActorsEditor({ actors, setActors, machines, busy }: { actors: ActorMachine[]; setActors: (a: ActorMachine[]) => void; machines: MachineRadiusView[]; busy: boolean }) {
  const free = machines.filter((m) => !actors.some((a) => a.machineId === m.machineId));
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">Actor machines</span>
      {actors.map((a, i) => (
        <div key={a.machineId} data-actor={a.machineId} className="flex flex-wrap items-center gap-2">
          <span className="w-32 truncate font-mono text-xs">{a.machineId}</span>
          <Input aria-label={`purpose of ${a.machineId}`} className="h-8 w-56" value={a.purpose} disabled={busy}
            onChange={(e) => setActors(actors.map((x, j) => (j === i ? { ...x, purpose: e.target.value } : x)))} />
          <select aria-label={`expected radius of ${a.machineId}`} className={`${FIELD} h-8 w-28 text-sm`} value={a.expected} disabled={busy}
            onChange={(e) => setActors(actors.map((x, j) => (j === i ? { ...x, expected: e.target.value as RadiusLevel } : x)))}>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setActors(actors.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      {free.length > 0 && (
        <select aria-label="Add an actor machine" className={`${FIELD} h-8 w-56 text-sm`} value="" disabled={busy}
          onChange={(e) => { if (e.target.value) setActors([...actors, { machineId: e.target.value, purpose: 'high-radius work', expected: 'high' }]); }}>
          <option value="">Add an actor machine…</option>
          {free.map((m) => <option key={m.machineId} value={m.machineId}>{m.label}</option>)}
        </select>
      )}
    </div>
  );
}

function SettingsForm({ view }: { view: BlastRadiusView }) {
  const s = view.settings;
  const [gateAt, setGateAt] = useState<GateAt>(s.gateAt);
  const [labels, setLabels] = useState(csv(s.pass.labels));
  const [repos, setRepos] = useState(csv(s.pass.repos));
  const [minPriority, setMinPriority] = useState(s.pass.minPriority === undefined ? '' : String(s.pass.minPriority));
  const [prodPatterns, setProdPatterns] = useState(csv(s.rules.prodPatterns));
  const [prodAccounts, setProdAccounts] = useState(csv(s.rules.prodAccounts));
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedAs>(s.rules.unconfirmed);
  const [everyMinutes, setEveryMinutes] = useState(String(s.everyMinutes));
  const [actors, setActors] = useState<ActorMachine[]>(s.actors);
  const [busy, setBusy] = useState(false);
  const next: BlastRadiusPatch = {
    gateAt,
    pass: { labels: fromCsv(labels), repos: fromCsv(repos), minPriority: minPriority.trim() === '' ? null : Number(minPriority) },
    rules: { prodPatterns: fromCsv(prodPatterns), prodAccounts: fromCsv(prodAccounts), unconfirmed },
    actors, everyMinutes: Number(everyMinutes),
  };
  const was = { ...s, pass: { ...s.pass, minPriority: s.pass.minPriority ?? null } };
  const changed = JSON.stringify(next) !== JSON.stringify({ gateAt: was.gateAt, pass: was.pass, rules: was.rules, actors: was.actors, everyMinutes: was.everyMinutes });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await saveBlastRadiusSettings(next);
    setBusy(false);
  };
  const field = (label: string, input: React.ReactNode) => <label className="grid gap-1"><span className="text-xs text-muted-foreground">{label}</span>{input}</label>;
  return (
    <form data-section="blast-radius-settings" onSubmit={(e) => void save(e)} className="space-y-2 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        {field('Gate', <select aria-label="Gate" className={`${FIELD} h-8 w-48 text-sm`} value={gateAt} disabled={busy} onChange={(e) => setGateAt(e.target.value as GateAt)}>
          <option value="high">machines rated high</option><option value="medium">rated medium or high</option><option value="off">only actor machines</option>
        </select>)}
        {field('Pass: labels', <Input aria-label="Pass labels" className="h-8 w-44" placeholder="hopper:actor" value={labels} disabled={busy} onChange={(e) => setLabels(e.target.value)} />)}
        {field('Pass: repos', <Input aria-label="Pass repos" className="h-8 w-44" placeholder="owner/name" value={repos} disabled={busy} onChange={(e) => setRepos(e.target.value)} />)}
        {field('Pass: priority from', <Input aria-label="Pass priority" type="number" min={0} max={100} className="h-8 w-24" value={minPriority} disabled={busy} onChange={(e) => setMinPriority(e.target.value)} />)}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {field('Prod names contain', <Input aria-label="Prod patterns" className="h-8 w-44" value={prodPatterns} disabled={busy} onChange={(e) => setProdPatterns(e.target.value)} />)}
        {field('Prod AWS accounts', <Input aria-label="Prod accounts" className="h-8 w-44" placeholder="123456789012" value={prodAccounts} disabled={busy} onChange={(e) => setProdAccounts(e.target.value)} />)}
        {field('Not confirmed counts as', <select aria-label="Not confirmed counts as" className={`${FIELD} h-8 w-32 text-sm`} value={unconfirmed} disabled={busy} onChange={(e) => setUnconfirmed(e.target.value as UnconfirmedAs)}>
          <option value="write">a write</option><option value="read">read-only</option>
        </select>)}
        {field('Discover every, minutes', <Input aria-label="Discover every" type="number" min={5} max={1440} className="h-8 w-24" value={everyMinutes} disabled={busy} onChange={(e) => setEveryMinutes(e.target.value)} />)}
      </div>
      <ActorsEditor actors={actors} setActors={setActors} machines={view.machines} busy={busy} />
      <Button type="submit" size="sm" disabled={busy || !changed}>Save</Button>
    </form>
  );
}

export function BlastRadiusPanel() {
  const view = useHopper((s) => s.blastRadius);
  const admin = useCanAdmin();
  const operator = useCanOperate();
  const [busy, setBusy] = useState(false);
  // Read when shown, and again when a machine is discovered or the settings change.
  const lastChange = useHopper((s) => s.events.find((e) => e.type.startsWith('machine.') || e.type === 'blast_radius.settings_changed')?.id);
  useEffect(() => { refreshBlastRadiusSoon(); }, [lastChange]);
  // Until read, or an answer without its machines (a daemon before this): nothing to show.
  if (!view || !Array.isArray(view.machines) || !view.settings) return null;
  const gated = view.machines.filter((m) => m.gated).length;
  return (
    <Panel title="Blast radius" icon={ShieldAlert} count={gated || ''} bodyClassName="space-y-3"
      action={operator && <Button size="xs" variant="outline" disabled={busy} onClick={async () => { setBusy(true); await discoverNow(); setBusy(false); }}><RefreshCw />Discover all</Button>}>
      <p data-slot="blast-radius-summary" className="text-sm text-muted-foreground">{summaryOf(view)}</p>
      <p className="text-xs text-muted-foreground">
        Each machine is discovered through its own connection: its tools, each AWS identity and what policy simulation allows it, each kubectl
        context and what can-i allows there, and the credential sources present — names only, never a secret. Write reach to prod, or reach that can
        grant itself more, is high; any other write reach is medium.
      </p>
      <div className="divide-y">{view.machines.map((m) => <MachineRow key={m.machineId} m={m} operator={operator} />)}</div>
      {admin && <SettingsForm key={JSON.stringify(view.settings)} view={view} />}
    </Panel>
  );
}
