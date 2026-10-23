// The delivery settings' event (issue #2554 part 3, design.md "Delivery forecasts"): an admin's change of a repository's
// promotion set schedule and delivery gates. Its schema, doc and example: part of EVENT_SCHEMAS (schemas.ts), EVENT_DOCS
// (docs.ts) and the examples (examples.ts), apart for their size.
import { z } from 'zod';
import { DELIVERY_STEPS } from '../domain/delivery-steps.ts';

const strict = z.strictObject;
const schedule = strict({
  timeZone: z.string(), cutoffs: z.array(strict({ weekday: z.number().int(), time: z.string() })), testGateAfterMinutes: z.number().int(),
  productionAfterMinutes: z.number().int(), epoch: z.string(), expedite: z.enum(['out_of_cadence', 'none']),
});
const settings = strict({ repos: z.record(z.string(), strict({ schedule: schedule.optional(), gates: z.partialRecord(z.enum(DELIVERY_STEPS), strict({ owner: z.string() })) })) });

export const DELIVERY_SETTINGS_EVENT_SCHEMAS = { 'delivery_settings.changed': strict({ from: settings, to: settings, by: z.string() }) };

export const DELIVERY_SETTINGS_EVENT_DOCS: Record<'delivery_settings.changed', string> = {
  'delivery_settings.changed': 'An admin changed the delivery settings (issue #2554 part 3): per repository (`owner/repo`, lowercased), its promotion set `schedule` — the weekly `cutoffs` (ISO weekday, `HH:MM`) in its `timeZone`, the minutes from a cutoff to the end of the test gate and from there to production, its `epoch` (set 1 is the first cutoff after it) and what `expedite` may do — and its delivery `gates`: each step a person ends, with its `owner`. `from` and `to` are the settings whole; `by` who changed them. A delivery forecast reads them at each request.',
};

export const DELIVERY_SETTINGS_EVENT_EXAMPLES = {
  'delivery_settings.changed': {
    from: { repos: {} },
    to: { repos: { 'octo/identity': {
      schedule: { timeZone: 'America/Chicago', cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }], testGateAfterMinutes: 120, productionAfterMinutes: 1440, epoch: '2026-10-01T00:00:00.000Z', expedite: 'out_of_cadence' },
      gates: { test_gate: { owner: 'release-owner' } },
    } } },
    by: 'admin',
  },
};
