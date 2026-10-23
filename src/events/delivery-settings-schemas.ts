// The delivery settings' event (issue #2554 part 3, design.md "Delivery forecasts"): an admin's change of a repository's
// promotion set schedule and delivery gates; and the expedite flag's (part 4): a person's flag on one change. Its schema, doc and example: part of EVENT_SCHEMAS (schemas.ts), EVENT_DOCS
// (docs.ts) and the examples (examples.ts), apart for their size.
import { z } from 'zod';
import { DELIVERY_STEPS } from '../domain/delivery-steps.ts';

const strict = z.strictObject;
const schedule = strict({
  timeZone: z.string(), cutoffs: z.array(strict({ weekday: z.number().int(), time: z.string() })), testGateAfterMinutes: z.number().int(),
  productionAfterMinutes: z.number().int(), epoch: z.string(), expedite: z.enum(['out_of_cadence', 'none']),
});
const settings = strict({ repos: z.record(z.string(), strict({ schedule: schedule.optional(), gates: z.partialRecord(z.enum(DELIVERY_STEPS), strict({ owner: z.string() })) })) });

export const DELIVERY_SETTINGS_EVENT_SCHEMAS = {
  'delivery_settings.changed': strict({ from: settings, to: settings, by: z.string() }),
  'delivery_expedite.changed': strict({ job: z.string().optional(), issue: z.string().optional(), pullRequest: z.string().optional(), expedite: z.boolean(), by: z.string() }),
};

export const DELIVERY_SETTINGS_EVENT_DOCS: Record<'delivery_settings.changed' | 'delivery_expedite.changed', string> = {
  'delivery_settings.changed': 'An admin changed the delivery settings (issue #2554 part 3): per repository (`owner/repo`, lowercased), its promotion set `schedule` — the weekly `cutoffs` (ISO weekday, `HH:MM`) in its `timeZone`, the minutes from a cutoff to the end of the test gate and from there to production, its `epoch` (set 1 is the first cutoff after it) and what `expedite` may do — and its delivery `gates`: each step a person ends, with its `owner`. `from` and `to` are the settings whole; `by` who changed them. A delivery forecast reads them at each request.',
  'delivery_expedite.changed': 'A person turned the expedite flag of one change on or off (issue #2554 part 4): exactly one of `job` (a job id), `issue` (`owner/name#N`, lowercased) or `pullRequest` (its URL); `expedite` on or off; `by` who. A change is expedited when the newest flag that names its job, its issue or its pull request is on; its delivery forecast then shows the expedited path beside the normal one. It changes no job and no promotion: the forecast only.',
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
  'delivery_expedite.changed': { issue: 'octo/identity#436', expedite: true, by: 'release-owner' },
};
