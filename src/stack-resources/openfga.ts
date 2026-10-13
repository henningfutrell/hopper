// The OpenFGA meter (issue #947, design.md "Stack resources"): OpenFGA's checks since it started, from its own metrics
// endpoint (`:2112/metrics`, on by default), in the Prometheus text format. Checks and failed checks from the gRPC counter
// `grpc_server_handled_total` (OpenFGA's service, method Check, by code); the mean check time from OpenFGA's own histogram
// `openfga_request_duration_ms` (method `check`). The two counters are all it reads, so a small line reader serves: the
// one npm parser of the format has had no release since 2019, and a dependency for twenty lines costs more than they do.
import type { OpenFgaMeter, OpenFgaReading } from '../domain/stack-resources.ts';

/** OpenFGA's default metrics port (its `--metrics-addr`, `0.0.0.0:2112`). */
export const OPENFGA_METRICS_PORT = 2112;
const WAIT_MS = 2_000;
const SERVICE = 'openfga.v1.OpenFGAService';

/** The metrics endpoint beside the OpenFGA API HOPPER_OPENFGA_URL names: the same host, on the metrics port. */
export function openFgaMetricsUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  return `${u.protocol}//${u.hostname}:${OPENFGA_METRICS_PORT}/metrics`;
}

interface Sample { name: string; labels: Record<string, string>; value: number }

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** The samples of a Prometheus text exposition; comments, and lines that are not samples, are left out. */
function samples(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? '').matchAll(LABEL)) labels[l[1]!] = l[2]!.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
    out.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return out;
}

function readingOf(text: string): OpenFgaReading {
  let checks = 0;
  let errors = 0;
  let sum = 0;
  let count = 0;
  for (const s of samples(text)) {
    if (!Number.isFinite(s.value)) continue;
    const l = s.labels;
    if (s.name === 'grpc_server_handled_total' && l.grpc_service === SERVICE && l.grpc_method === 'Check') {
      checks += s.value;
      if (l.grpc_code !== 'OK') errors += s.value;
    } else if (l.grpc_method?.toLowerCase() === 'check' && l.grpc_service === SERVICE) {
      if (s.name === 'openfga_request_duration_ms_sum') sum += s.value;
      else if (s.name === 'openfga_request_duration_ms_count') count += s.value;
    }
  }
  return { checks, errors, ...(count > 0 ? { meanMs: sum / count } : {}) };
}

export function createOpenFgaMeter(o: { url: string }): OpenFgaMeter {
  return {
    async read() {
      let res: Response;
      try {
        res = await fetch(o.url, { signal: AbortSignal.timeout(WAIT_MS) });
      } catch (e) {
        throw new Error(`OpenFGA's metrics (${o.url}) did not answer: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (!res.ok) throw new Error(`OpenFGA's metrics (${o.url}) answered ${res.status}`);
      return readingOf(await res.text());
    },
  };
}
