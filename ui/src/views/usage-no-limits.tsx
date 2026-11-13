// A usage source's No usage limits on its Usage panel (issue #2932): an account that prints no usage limits (an Enterprise plan is
// read so by itself) is not read as unknown usage, so its machines run on every lane, not on the soft lanes only. The option is the
// source's `noLimits`, one plugins edit of its options (POST /ui/api/plugins), as Settings → Plugins sends it. An admin's; shown
// only for a source whose plugin has the option.
import { useEffect, useState } from 'react';
import { sendPluginsEdit } from '@/components/plugin-form';
import type { OptionsSchema } from '@/model/plugins';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const ROLE = 'usage-source';

export function NoLimitsOption({ source }: { source: string }) {
  const canAdmin = useCanAdmin();
  const plugins = useHopper((s) => s.plugins);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (canAdmin && !plugins) refreshPlugins().catch(() => {}); }, [canAdmin, plugins]);
  if (!canAdmin || !plugins) return null;
  // A report with no lists (an older daemon, a fake) shows nothing.
  const found = plugins.instances?.find((c) => c.role === ROLE && c.instance.name === source);
  const schema = found && plugins.plugins?.find((p) => p.id === found.instance.plugin)?.options as OptionsSchema | undefined;
  if (!found || !schema?.properties?.noLimits) return null;
  const on = found.instance.options?.noLimits === true;
  const set = async (next: boolean) => {
    const { noLimits: _, ...rest } = found.instance.options ?? {};
    setBusy(true);
    await sendPluginsEdit({ action: 'options', role: ROLE, name: source, version: plugins.config.version, options: next ? { ...rest, noLimits: true } : rest },
      next ? `${source}: no usage limits` : `${source}: usage limits read`);
    setBusy(false);
  };
  return (
    <label className="flex items-start gap-2 text-xs" data-slot="usage-no-limits">
      <input type="checkbox" className="mt-0.5 size-4" checked={on} disabled={busy} onChange={(e) => void set(e.target.checked)} />
      <span>
        <span className="font-medium">No usage limits</span>
        <span className="text-muted-foreground"> — its account has none: when it prints no usage limits, its machines run on every lane, not on the soft lanes only. An Enterprise plan is read so without it.</span>
      </span>
    </label>
  );
}
