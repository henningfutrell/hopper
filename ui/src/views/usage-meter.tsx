// The meter of a usage source's account on its Usage panel (issue #2966, was #2932's No usage limits): auto, live or analytics,
// the source's `meter`, one plugins edit of its options (POST /ui/api/plugins), as Settings → Plugins sends it. Live reads the
// account's usage windows, and a read with none is usage unknown; analytics reads it as having no usage limits, so its machines
// run on every lane; auto resolves an Enterprise plan to analytics. Every role sees the meter the source resolved to; only an
// admin picks it, and only for a source whose plugin has the option.
import { useEffect, useState } from 'react';
import { sendPluginsEdit } from '@/components/plugin-form';
import type { OptionsSchema } from '@/model/plugins';
import type { UsageSourceReport } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const ROLE = 'usage-source';
const METERS = ['auto', 'live', 'analytics'] as const;

export function MeterOption({ source }: { source: Pick<UsageSourceReport, 'name' | 'meter'> }) {
  const canAdmin = useCanAdmin();
  const plugins = useHopper((s) => s.plugins);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (canAdmin && !plugins) refreshPlugins().catch(() => {}); }, [canAdmin, plugins]);
  // A report with no lists (an older daemon, a fake) shows no select.
  const found = canAdmin ? plugins?.instances?.find((c) => c.role === ROLE && c.instance.name === source.name) : undefined;
  const schema = found && plugins?.plugins?.find((p) => p.id === found.instance.plugin)?.options as OptionsSchema | undefined;
  const editable = !!found && !!schema?.properties?.meter;
  if (!source.meter && !editable) return null;
  const now = typeof found?.instance.options?.meter === 'string' ? found.instance.options.meter : 'auto';
  const set = async (next: string) => {
    if (!found || !plugins) return;
    const { meter: _, ...rest } = found.instance.options ?? {};
    setBusy(true);
    await sendPluginsEdit({ action: 'options', role: ROLE, name: source.name, version: plugins.config.version, options: next === 'auto' ? rest : { ...rest, meter: next } },
      `${source.name}: meter ${next}`);
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-slot="usage-meter">
      <span className="font-medium">Meter</span>
      {source.meter && <span className="num text-muted-foreground" data-meter={source.name}>meter: {source.meter}</span>}
      {editable && (
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Meter of {source.name}</span>
          <select className="h-7 rounded-md border bg-background px-1.5" value={now} disabled={busy} onChange={(e) => void set(e.target.value)}>
            {METERS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-muted-foreground">— live reads its usage windows; analytics reads it as having no usage limits (the account day budget still applies); auto: analytics for an Enterprise plan</span>
        </label>
      )}
    </div>
  );
}
