// The hopper's tracer and meter (issue #1486). The API's tracer follows the provider set later; its meter does not — a
// meter taken before the SDK starts stays a no-op —, so each instrument is made again when the provider changes.
import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';

export const SCOPE = 'hopper';

export function tracer(): Tracer {
  return trace.getTracer(SCOPE);
}

/** An instrument of the current meter provider's `hopper` meter, made once per provider. */
export function instrument<T>(make: (meter: Meter) => T): () => T {
  let made: { provider: unknown; it: T } | undefined;
  return () => {
    const provider = metrics.getMeterProvider();
    if (made?.provider !== provider) made = { provider, it: make(provider.getMeter(SCOPE)) };
    return made.it;
  };
}
