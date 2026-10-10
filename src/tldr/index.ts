// The TL;DR (issue #569, design.md "TL;DR"). Its model and the sweep with it (`haiku.ts`, the `claude` CLI) are composed
// by the user runtime, not exported here: what reads a TL;DR imports nothing of the plugins.
export { agentSummary, hashOf, isLong, plainText, shownTldr, sourceOf, summaryOf, tldrOrSummary, tldrPrompt, withShownTldr } from './text.ts';
export { createTldrs, tldrData, tldrSettings, type Tldrs } from './service.ts';
export { TLDR_KINDS, TLDR_MAX } from '../domain/types.ts';
