// Landing batches' event examples (issue #1073): part of EVENT_EXAMPLES (examples.ts), apart for its size.
import type { EventType } from '../domain/types.ts';

export const LANDING_BATCH_EXAMPLES: Record<Extract<EventType, `landing_batch${string}`>, Record<string, unknown>> = {
  'landing_batch.started': { repo: 'owner/repo', landing: 'main', tested: 'dev', tip: '0123456789abcdef0123456789abcdef01234567', branch: 'hopper-batch/0123456789ab', pullRequest: 1101, url: 'https://github.com/owner/repo/pull/1101', merges: [1088, 1090, 1093], why: '3 merges since the last batch run' },
  'landing_batch.promoted': { repo: 'owner/repo', tested: 'dev', tip: '0123456789abcdef0123456789abcdef01234567', pullRequest: 1101, url: 'https://github.com/owner/repo/pull/1101', merge: '89abcdef0123456789abcdef0123456789abcdef' },
  'landing_batch.failed': { repo: 'owner/repo', tested: 'dev', tip: '0123456789abcdef0123456789abcdef01234567', pullRequest: 1101, url: 'https://github.com/owner/repo/pull/1101', reason: 'checks failed: shard (4)', checks: ['shard (4)'] },
  'landing_batch.retargeted': { repo: 'owner/repo', pullRequest: 1090, url: 'https://github.com/owner/repo/pull/1090', from: 'dev', to: 'main' },
  'landing_batches.changed': { from: { repos: {} }, to: { repos: { 'owner/repo': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } }, by: 'owner' },
};
