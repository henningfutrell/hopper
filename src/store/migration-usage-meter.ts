// Tenant migration 111 (issue #2966): the claude-plan option `noLimits` is gone, and `meter` takes its place. Each claude-plan
// usage source of the config record `plugins` with `noLimits: true` gets `meter: 'analytics'`; `noLimits: false` is taken
// off, as `auto`, the default, reads such an account as before. Every other option and instance stays. The build before
// runs on the result: it drops an option it does not know, and reads an Enterprise plan as having no usage limits.
import type { Db } from './db.ts';

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

export function usageMeterOption(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { usageSources?: unknown };
  if (!Array.isArray(value.usageSources)) return;
  let changed = false;
  value.usageSources = (value.usageSources as Instance[]).map((s) => {
    if (s?.plugin !== 'claude-plan' || !s.options || !('noLimits' in s.options)) return s;
    changed = true;
    const { noLimits, ...rest } = s.options;
    return { ...s, options: noLimits === true ? { ...rest, meter: 'analytics' } : rest };
  });
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
