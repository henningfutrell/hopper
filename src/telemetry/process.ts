// The process's basics (issue #1486, design.md "Telemetry"): its memory, its CPU time and how long its event loop was
// held, read at each collection. The names are the semantic conventions' where they have one. Started after the SDK:
// its gauges are the meter provider's of that moment.
import { metrics, type BatchObservableResult } from '@opentelemetry/api';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SCOPE } from './instruments.ts';

const NS_PER_S = 1e9;

/** Reports the process's basics at each collection; the returned function stops it. */
export function observeProcess(): () => void {
  const meter = metrics.getMeterProvider().getMeter(SCOPE);
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const memory = meter.createObservableGauge('process.memory.usage', { unit: 'By', description: 'The process\'s resident memory.' });
  const heap = meter.createObservableGauge('nodejs.memory.heap.used', { unit: 'By', description: 'The V8 heap in use.' });
  const cpu = meter.createObservableCounter('process.cpu.time', { unit: 's', description: 'CPU time the process used, by mode.' });
  const delayMax = meter.createObservableGauge('nodejs.eventloop.delay.max', { unit: 's', description: 'The longest event loop delay since the last collection.' });
  const delayP99 = meter.createObservableGauge('nodejs.eventloop.delay.p99', { unit: 's', description: 'The 99th percentile event loop delay since the last collection.' });
  const observables = [memory, heap, cpu, delayMax, delayP99];
  const callback = (r: BatchObservableResult): void => {
    const mem = process.memoryUsage();
    r.observe(memory, mem.rss);
    r.observe(heap, mem.heapUsed);
    const used = process.cpuUsage();
    r.observe(cpu, used.user / 1e6, { 'cpu.mode': 'user' });
    r.observe(cpu, used.system / 1e6, { 'cpu.mode': 'system' });
    r.observe(delayMax, delay.max / NS_PER_S);
    r.observe(delayP99, delay.percentile(99) / NS_PER_S);
    delay.reset();
  };
  meter.addBatchObservableCallback(callback, observables);
  return () => {
    meter.removeBatchObservableCallback(callback, observables);
    delay.disable();
  };
}
