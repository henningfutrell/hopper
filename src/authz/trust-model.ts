// The trust stamp in the access model (issue #655, part 15; design.md "Trust stamps"): the part of the default model's
// DSL that reads a job's trust, and what the hopper writes and asks of it. Apart from ./model.ts, which imports it, so
// the two hold no import cycle. Each live job whose stamp verifies holds its level and each level below it, so
// `trust:approved#holder` is every live job at approved or above. An operation profile with a minimum trust lets no job
// below it be its requester; one with none is as before. A box and a person are no job: the minimum gates neither.

/** The trust levels and the operation profile, as the default model writes them. */
export const TRUST_MODEL = `# A trust level of a job's stamp (issue #655). The hopper writes each live job whose stamp verifies as a holder of its
# level and of each level below it; a quarantined job holds none.
type trust
  relations
    define holder: [job]

# An operation on an asset, as read/cluster/x. A template approved for it lets its requesters do the operation. With a
# minimum trust (issue #655), a job below it is no requester: the hopper writes the minimum, and every job (job:*) as
# gated by it.
type operation_profile
  relations
    define approved_for: [template]
    define min_trust: [trust]
    define trust_gated: [job:*]
    define trust_met: holder from min_trust
    define below_trust: trust_gated but not trust_met
    define requester: requester from approved_for but not below_trust
`;

/** What the hopper writes for trust: apart, so a model edited before it still decides mints, with no minimum trust. */
export const TRUST_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [
  ['trust', 'holder', 'job'], ['operation_profile', 'min_trust', 'trust'], ['operation_profile', 'trust_gated', 'job'],
];
