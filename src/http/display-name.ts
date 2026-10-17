// The instance's display name (issue #465, design.md "The instance's display name"): what the hopper's admin calls this
// hopper, kept in the instance's settings, shown in Settings → Version beside the instance id (made once and kept, issue
// #603). The first part of registering hoppers under one account; a change is `display_name.changed`.
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';

/** GET /api/display-name. `displayName`: empty when none. */
export interface DisplayNameView { instanceId: string; displayName: string }

export interface DisplayName {
  view(): DisplayNameView;
  /** Sets the name, trimmed; empty clears it. Nothing changed, nothing kept. */
  change(name: string, by: string): DisplayNameView;
}

export function createDisplayName(o: {
  settings: Pick<InstanceSettingsRepository, 'instanceId' | 'getDisplayName' | 'setDisplayName'>;
  events: Pick<InstanceEvents, 'append'>;
}): DisplayName {
  const view = (): DisplayNameView => ({ instanceId: o.settings.instanceId(), displayName: o.settings.getDisplayName() });
  return {
    view,
    change(name, by) {
      const from = o.settings.getDisplayName(), to = name.trim();
      if (from !== to) {
        o.settings.setDisplayName(to);
        o.events.append({ type: 'display_name.changed', data: { from, to, by } });
      }
      return view();
    },
  };
}
