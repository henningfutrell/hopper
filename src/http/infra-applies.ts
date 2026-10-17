// Infra applies (issue #1722, design.md "Infra applies off: changes through CI only"): an instance setting, on by default,
// kept in the instance's settings and read at each mint and each step ask (src/vault/mint.ts, src/vault/need-mint.ts,
// src/sandbox/need-steps.ts), so a change applies at once. Off, the hopper mints only reads and runs no step that
// applies: an infrastructure change goes through CI. The hopper's admin turns it on or off; a change is `infra.applies_changed`.
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';

/** GET /api/infra-applies. */
export interface InfraAppliesView { on: boolean }

export interface InfraApplies {
  view(): InfraAppliesView;
  /** Turns it on or off; nothing changed, nothing kept. */
  change(on: boolean, by: string): InfraAppliesView;
}

export function createInfraApplies(o: {
  settings: Pick<InstanceSettingsRepository, 'getInfraApplies' | 'setInfraApplies'>;
  events: Pick<InstanceEvents, 'append'>;
}): InfraApplies {
  const view = (): InfraAppliesView => ({ on: o.settings.getInfraApplies() });
  return {
    view,
    change(on, by) {
      if (o.settings.getInfraApplies() !== on) {
        o.settings.setInfraApplies(on);
        o.events.append({ type: 'infra.applies_changed', data: { on, by } });
      }
      return view();
    },
  };
}
