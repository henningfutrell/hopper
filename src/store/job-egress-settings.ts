// The job egress setting (issue #2849, design.md "A job's egress allowlist"), apart from settings.ts for its size: a user's
// key-value setting, the defaults only when never set.
import { NO_JOB_EGRESS, type JobEgressSettings } from '../domain/job-egress.ts';

export function jobEgressSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getJobEgress(): JobEgressSettings;
  setJobEgress(egress: JobEgressSettings): void;
} {
  return {
    getJobEgress() {
      const text = read('jobEgress');
      return text === undefined ? NO_JOB_EGRESS : { ...NO_JOB_EGRESS, ...(JSON.parse(text) as Partial<JobEgressSettings>) };
    },
    setJobEgress: ({ defaults, hosts, repos, route }) => write('jobEgress', JSON.stringify({ defaults, hosts, repos, route })),
  };
}
