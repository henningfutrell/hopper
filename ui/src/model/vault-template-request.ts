// The template request on Vault (issue #708, part 9): a person writes what the box must do — its needs — and the panel
// shows the template the hopper makes from them before it is made. The hopper derives the template; the page only says it.
import type { TemplatePreview } from './wire.ts';

/** What a box of a template made on request is given: no vault secret; a person gives each credential when it is asked. */
export const REQUEST_SECRETS = 'No vault secret. A box of it asks a person for each credential the first time it loads that skill.';

/** Who approves the template, and why it waits for a person. */
export const requestApproval = (p: TemplatePreview): string => (p.approvedBy === 'the read policy'
  ? `The read policy approves it: no person is needed.${p.readOnly ? ' A read-only check runs before its first box.' : ''}`
  : `It waits for a person in Templates: ${p.waits.join('; ')}.`);

/** Whether the template is there already, and what asking again does then. */
export const requestExists = (p: TemplatePreview): string | undefined => (p.exists === 'same'
  ? `Template ${p.template} is there already: asking again makes no second one.`
  : p.exists === 'changed' ? `A person changed template ${p.template} since it was asked for: asking again is refused.` : undefined);
