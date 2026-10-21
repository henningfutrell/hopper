// Auto-park (issues #650, #2335, design.md "Parked jobs"): a job on a question, or on its proposal or research report,
// parks by itself, as the Park button parks it, so no job on a question holds an agent. A question parks its job a few
// seconds after it reached a person (WAIT_RELEASE_AFTER_MS): time at the escalation levels does not count. A proposal or a
// research report parks its job as long after it reached the human stage. No setting. Pure.

/** What the card and the `job.parked` event say about a job auto-park parked. */
export const AUTO_PARK_WHY = 'Parked automatically: a job that waits on a person holds no agent.';
