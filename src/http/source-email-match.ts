// The source email match (issue #1380, design.md "The source email match"): an instance setting, on by default, kept in the
// instance's settings and read at each check (src/connected-accounts/email-match.ts), so a change applies at once. The
// hopper's admin turns it on or off; a change is `source_email_match.changed`.
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';

/** GET /api/source-email-match. */
export interface SourceEmailMatchView { on: boolean }

export interface SourceEmailMatch {
  view(): SourceEmailMatchView;
  /** Turns it on or off; nothing changed, nothing kept. */
  change(on: boolean, by: string): SourceEmailMatchView;
}

export function createSourceEmailMatch(o: {
  settings: Pick<InstanceSettingsRepository, 'getSourceEmailMatch' | 'setSourceEmailMatch'>;
  events: Pick<InstanceEvents, 'append'>;
}): SourceEmailMatch {
  const view = (): SourceEmailMatchView => ({ on: o.settings.getSourceEmailMatch() });
  return {
    view,
    change(on, by) {
      if (o.settings.getSourceEmailMatch() !== on) {
        o.settings.setSourceEmailMatch(on);
        o.events.append({ type: 'source_email_match.changed', data: { on, by } });
      }
      return view();
    },
  };
}
