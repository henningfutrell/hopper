// The read-only check on the vault's side (issue #716, item 4): a check kept on its template, and a person asking for it
// to run again. The check itself runs in the sandbox module (src/sandbox/check.ts); the vault keeps only its result.
import type { UserStore } from '../domain/ports.ts';
import { currentCheck, failedProbes, type ReadOnlyCheck } from '../domain/read-only-check.ts';

type Result = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };

export interface TemplateChecks {
  /** Keeps the check on the template; false (nothing kept) when it is gone or was saved again since the check began. */
  recordCheck(name: string, check: ReadOnlyCheck): boolean;
  /** A person asks for the check to run again: the template's current check goes, and the next check pass runs one. */
  checkTemplate(name: string, by: string): Result;
}

export function templateChecks(store: Pick<UserStore, 'vault' | 'events' | 'tx'>): TemplateChecks {
  const { vault, events } = store;
  return {
    recordCheck(name, check) {
      return store.tx(() => {
        const t = vault.template(name);
        if (!t || t.savedAt !== check.version) return false;
        vault.saveTemplate({ ...t, check });
        if (check.state !== 'running') {
          events.append({ type: 'template.checked', data: { template: name, state: check.state, failed: failedProbes(check), ...(check.problem ? { problem: check.problem } : {}) } });
        }
        return true;
      });
    },
    checkTemplate(name, by) {
      const t = vault.template(name);
      if (!t) return { ok: false, code: 'not_found', error: `no template ${name}` };
      if (!t.readOnly) return { ok: false, code: 'invalid', error: `${name} takes no read-only check: only a template a job asked for with read needs only does` };
      if (currentCheck(t)?.state === 'running') return { ok: false, code: 'conflict', error: `the read-only check of ${name} runs now` };
      store.tx(() => {
        const { check: _was, ...rest } = t;
        vault.saveTemplate(rest);
        events.append({ type: 'template.check_requested', data: { template: name, by } });
      });
      return { ok: true };
    },
  };
}
