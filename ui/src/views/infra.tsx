// Infra changes (#infra, issues #896, #897): a top-level page, never tucked in Settings → Vault. The plans waiting for
// approval before an apply (issue #870) and the out-of-band changes waiting to be marked (issue #871). Always shown,
// each panel with its own empty state.
import { InfraChanges } from './infra-plans';
import { OutOfBandChanges } from './out-of-band';

export function Infra() {
  return <div className="space-y-3"><InfraChanges /><OutOfBandChanges /></div>;
}
