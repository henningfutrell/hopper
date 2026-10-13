// The tables of tenant migrations 48 (job checkpoints, issue #921), 49 (direct jobs, issue #901) and 50 (pending index
// updates, issue #945), each kept with its
// repository. Named here together so the migration list (tenant-migrations.ts) stays under the file-size limit.
export { CHECKPOINT_TABLE } from './checkpoints.ts';
export { DIRECT_JOB_TABLE } from './direct-jobs.ts';
export { SEARCH_PENDING_TABLE } from './search-pending.ts';
