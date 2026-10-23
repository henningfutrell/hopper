// Delivery settings (issue #2554 part 3, design.md "Delivery forecasts"): per repository (`owner/repo`, lowercased), its
// promotion set schedule and its delivery gates — the steps a person ends, each with its owner. The user's, in the
// database, changed by an admin; the forecast reads them at each request. Pure.
import type { DeliveryStep } from './delivery-steps.ts';
import type { PromotionSetSchedule } from './promotion-sets.ts';

export type { DeliveryStep } from './delivery-steps.ts';
export type { PromotionSet, PromotionSetSchedule } from './promotion-sets.ts';

export type DeliveryGates = Partial<Record<DeliveryStep, { owner: string }>>;
/** A repository's delivery settings. With no schedule, its scheduled steps are `unknown`. */
export interface DeliveryRepo { schedule?: PromotionSetSchedule; gates: DeliveryGates }
export interface DeliverySettings { repos: Record<string, DeliveryRepo> }
/** A change: per repository, its settings whole, or `null` to take them away. */
export interface DeliverySettingsPatch { repos: Record<string, DeliveryRepo | null> }
export interface DeliverySettingsView { settings: DeliverySettings; choices: { repos: string[]; steps: readonly DeliveryStep[] } }

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = { repos: {} };

export function patchDeliverySettings(s: DeliverySettings, p: DeliverySettingsPatch): DeliverySettings {
  const repos = { ...s.repos };
  for (const [repo, v] of Object.entries(p.repos)) {
    if (v === null) delete repos[repo.toLowerCase()];
    else repos[repo.toLowerCase()] = v;
  }
  return { repos: Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b))) };
}

/** A repository's delivery settings; none: no schedule and no gates. */
export const deliveryOf = (s: DeliverySettings, repo: string | undefined): DeliveryRepo => (repo ? s.repos[repo.toLowerCase()] : undefined) ?? { gates: {} };
