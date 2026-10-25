// The delivery settings' event (issue #2554 part 3, design.md "Delivery forecasts"): an admin's change of a repository's
// promotion set schedule and delivery gates; the expedite flag's (part 4): a person's flag on one change; and a gate
// clearance's (part 5): a person's act that ends a delivery gate for one promotion set; and a person's flip of a job's
// deployment expectation (issue #2775): no-deploy or deploy, on its kept delivery track. Their schemas, docs and examples:
// part of EVENT_SCHEMAS (schemas.ts), EVENT_DOCS (docs.ts) and the examples (examples.ts), apart for their size.
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
  'delivery_gate.cleared': strict({ repo: z.string(), set: z.number().int(), step: z.enum(DELIVERY_STEPS), by: z.string() }),
  'delivery_track.no_deploy_marked': strict({ by: z.string(), note: z.string().optional() }),
  'delivery_track.deploy_expected': strict({ by: z.string(), note: z.string().optional() }),
};

export const DELIVERY_SETTINGS_EVENT_DOCS: Record<'delivery_settings.changed' | 'delivery_expedite.changed' | 'delivery_gate.cleared' | 'delivery_track.no_deploy_marked' | 'delivery_track.deploy_expected', string> = {
  'delivery_settings.changed': 'An admin changed the delivery settings (issue #2554 part 3): per repository (`owner/repo`, lowercased), its promotion set `schedule` — the weekly `cutoffs` (ISO weekday, `HH:MM`) in its `timeZone`, the minutes from a cutoff to the end of the test gate and from there to production, its `epoch` (set 1 is the first cutoff after it) and what `expedite` may do — and its delivery `gates`: each step a person ends, with its `owner`. `from` and `to` are the settings whole; `by` who changed them. A delivery forecast reads them at each request.',
  'delivery_expedite.changed': 'A person turned the expedite flag of one change on or off (issue #2554 part 4): exactly one of `job` (a job id), `issue` (`owner/name#N`, lowercased) or `pullRequest` (its URL); `expedite` on or off; `by` who. A change is expedited when the newest flag that names its job, its issue or its pull request is on; its delivery forecast then shows the expedited path beside the normal one. It changes no job and no promotion: the forecast only.',
  'delivery_gate.cleared': 'A person cleared a delivery gate of one promotion set (issue #2554 part 5): `repo` (`owner/repo`, lowercased), the `set` number and the gated `step` (`promotion_set`, `test_gate` or `production`) — the test gate\'s sign-off, a production approval —; `by` who. Each change of that set goes on past the gate from this time, not before the step starts; a cleared production gate delivers it. The first clearance of a gate counts. It changes no job and promotes nothing: the hopper records the act.',
  'delivery_track.no_deploy_marked': 'A person marked a job no-deploy (issue #2775): its kept delivery track is closed with a deployment record of kind `none`, outcome `marked`, `by` who and their `note`. The record stays open: a later flip to deploy opens the track again. Refused once the job\'s deployment completed. It changes no job, pull request or promotion: the hopper records the act.',
  'delivery_track.deploy_expected': 'A person said a job\'s change is to be deployed (issue #2775 part 2), `by` who and their `note`: its kept delivery track opens again, its `none` record kept with the flip, and the kept-track pass follows it until its deployment completes, which locks the record. Refused once the job\'s deployment completed. It changes no job, pull request or promotion: the hopper records the act.',
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
  'delivery_gate.cleared': { repo: 'octo/identity', set: 7, step: 'test_gate', by: 'release-owner' },
  'delivery_track.no_deploy_marked': { by: 'release-owner', note: 'a docs change: nothing is deployed' },
  'delivery_track.deploy_expected': { by: 'release-owner', note: 'ship it with the next set' },
};
