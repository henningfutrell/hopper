// Issue #947: the OpenFGA meter against a double of OpenFGA's own metrics endpoint (`:2112/metrics`, the Prometheus text
// format). The double's text is what OpenFGA v1.22.0 answers, taken from a live server: its gRPC counters per code, and its
// own request duration histogram, labelled by method in lower case.
//
// Feature: the hopper reads OpenFGA's check latency and error rate from OpenFGA's own metrics
//   Scenario: checks, failed checks and the mean check time are read; other methods and the health check are left out
//   Scenario: before any check, there is no mean time
//   Scenario: the metrics URL is OpenFGA's own host on its metrics port
//   Scenario: an endpoint that answers an error, or does not answer, is a failed read
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenFgaMeter, openFgaMetricsUrl } from '../../src/stack-resources/openfga.ts';

let server: Server | undefined;
afterEach(async () => { await new Promise((r) => server ? server.close(r) : r(undefined)); server = undefined; });

async function serve(status: number, body: string): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(req.url === '/metrics' ? status : 404, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(req.url === '/metrics' ? body : 'not found');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`;
}

const SVC = 'grpc_service="openfga.v1.OpenFGAService",grpc_type="unary"';
const DURATION = 'datastore_query_count="50",dispatch_count="50",grpc_service="openfga.v1.OpenFGAService"';
const METRICS = `# HELP grpc_server_handled_total Total number of RPCs completed on the server, regardless of success or failure.
# TYPE grpc_server_handled_total counter
grpc_server_handled_total{grpc_code="OK",grpc_method="Check",grpc_service="grpc.health.v1.Health",grpc_type="unary"} 7
grpc_server_handled_total{grpc_code="Code(2000)",grpc_method="Check",${SVC}} 1
grpc_server_handled_total{grpc_code="Internal",grpc_method="Check",${SVC}} 2
grpc_server_handled_total{grpc_code="OK",grpc_method="Check",${SVC}} 97
grpc_server_handled_total{grpc_code="OK",grpc_method="Write",${SVC}} 40
# HELP openfga_request_duration_ms The request duration (in ms) labeled by method and buckets of datastore query counts and number of dispatches.
# TYPE openfga_request_duration_ms histogram
openfga_request_duration_ms_bucket{consistency="UNSPECIFIED",${DURATION},grpc_method="check",le="1"} 90
openfga_request_duration_ms_bucket{consistency="UNSPECIFIED",${DURATION},grpc_method="check",le="+Inf"} 90
openfga_request_duration_ms_sum{consistency="UNSPECIFIED",${DURATION},grpc_method="check"} 45
openfga_request_duration_ms_count{consistency="UNSPECIFIED",${DURATION},grpc_method="check"} 90
openfga_request_duration_ms_sum{consistency="HIGHER_CONSISTENCY",${DURATION},grpc_method="check"} 52
openfga_request_duration_ms_count{consistency="HIGHER_CONSISTENCY",${DURATION},grpc_method="check"} 7
openfga_request_duration_ms_sum{consistency="UNSPECIFIED",${DURATION},grpc_method="write"} 900
openfga_request_duration_ms_count{consistency="UNSPECIFIED",${DURATION},grpc_method="write"} 40
`;

describe('the OpenFGA meter', () => {
  it('reads checks, failed checks and the mean check time; other methods and the health check are left out', async () => {
    const meter = createOpenFgaMeter({ url: await serve(200, METRICS) });
    expect(await meter.read()).toEqual({ checks: 100, errors: 3, meanMs: 1 });
  });

  it('before any check, there is no mean time', async () => {
    const meter = createOpenFgaMeter({ url: await serve(200, '# TYPE grpc_server_handled_total counter\n') });
    expect(await meter.read()).toEqual({ checks: 0, errors: 0 });
  });

  it('the metrics URL is OpenFGA\'s own host on its metrics port', () => {
    expect(openFgaMetricsUrl('http://openfga:8080')).toBe('http://openfga:2112/metrics');
    expect(openFgaMetricsUrl('https://fga.example.com/base/')).toBe('https://fga.example.com:2112/metrics');
  });

  it('an endpoint that answers an error is a failed read that says so', async () => {
    const meter = createOpenFgaMeter({ url: await serve(503, 'down') });
    await expect(meter.read()).rejects.toThrow(/503/);
  });

  it('an endpoint that does not answer is a failed read', async () => {
    const url = await serve(200, METRICS);
    await new Promise((r) => server!.close(r));
    server = undefined;
    await expect(createOpenFgaMeter({ url }).read()).rejects.toThrow(/OpenFGA's metrics/);
  });
});
