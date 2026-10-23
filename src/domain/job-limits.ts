// A machine's limits for each job (issue #2498, design.md "The job's scope"): set on the job's scope as it is made, so a job
// past its memory limit is stopped by the OOM killer in its own scope, and the machine's other work goes on.

/** A machine's own job limits (its `jobMemoryMaxGiB` and `jobCpuPercent` options). Absent fields: no limit. */
export interface JobLimits { memoryMaxGiB?: number; cpuPercent?: number }

/** The systemd properties of the limits, for `systemd-run -p`: `MemoryMax` in bytes, `CPUQuota` in percent of one CPU. */
export function scopeLimitProperties(l: JobLimits | undefined): string[] {
  return [
    ...(l?.memoryMaxGiB !== undefined ? [`MemoryMax=${Math.round(l.memoryMaxGiB * 1024 ** 3)}`] : []),
    ...(l?.cpuPercent !== undefined ? [`CPUQuota=${Math.round(l.cpuPercent)}%`] : []),
  ];
}
