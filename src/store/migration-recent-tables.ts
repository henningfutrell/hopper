// The tables of tenant migrations 48 (job checkpoints, issue #921) and 49 (direct jobs, issue #901), each kept with its
// repository. Named here together so the migration list (tenant-migrations.ts) stays under the file-size limit.
export { CHECKPOINT_TABLE } from './checkpoints.ts';
export { DIRECT_JOB_TABLE } from './direct-jobs.ts';
