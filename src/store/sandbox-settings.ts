// A user's settings for the templates and sandboxes their jobs ask for: the read policy (issue #716, "Templates on
// request"), the sandbox approval toggles (issue #991, "Sandboxes jobs start"), the auto-approve policy and the remembered write
// approvals (issue #1001). Part of the user's settings
// repository (settings.ts).
import { RADIUS_LEVELS, type RadiusLevel } from '../domain/blast-radius.ts';
import type { UserSettingsRepository } from '../domain/ports.ts';
import type { RememberedWrite } from '../domain/remembered-writes.ts';
import { DEFAULT_AUTO_APPROVE, type AutoApprove } from '../domain/sandbox-approvals.ts';

type SandboxSettings = Pick<UserSettingsRepository, 'getReadPolicy' | 'setReadPolicy' | 'getSandboxApprovals' | 'setSandboxApprovals' | 'getRememberedWrites' | 'setRememberedWrites'>;

export function sandboxSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): SandboxSettings {
  return {
    getReadPolicy() {
      const text = read('readPolicy');
      return text === undefined ? undefined : { assets: (JSON.parse(text) as { assets: string[] }).assets };
    },
    setReadPolicy(p) {
      write('readPolicy', JSON.stringify({ assets: [...p.assets] }));
    },
    getSandboxApprovals() {
      const text = read('sandboxApprovals');
      if (text === undefined) return undefined;
      const a = JSON.parse(text) as { skipTemplateApproval?: unknown; skipSandboxApproval?: unknown; autoApprove?: Partial<Record<RadiusLevel, unknown>>; rememberWritesHours?: unknown };
      // Issue #1001: a value saved before the auto-approve policy has none; the default holds.
      const auto = a.autoApprove && typeof a.autoApprove === 'object'
        ? { autoApprove: Object.fromEntries(RADIUS_LEVELS.map((l) => [l, a.autoApprove![l] === undefined ? DEFAULT_AUTO_APPROVE[l] : a.autoApprove![l] === true])) as AutoApprove }
        : {};
      // Issue #1001: absent, the default time limit for remembered write approvals holds.
      const hours = typeof a.rememberWritesHours === 'number' ? { rememberWritesHours: a.rememberWritesHours } : {};
      return { skipTemplateApproval: a.skipTemplateApproval === true, skipSandboxApproval: a.skipSandboxApproval === true, ...auto, ...hours };
    },
    setSandboxApprovals(a) {
      write('sandboxApprovals', JSON.stringify({
        skipTemplateApproval: a.skipTemplateApproval, skipSandboxApproval: a.skipSandboxApproval, ...(a.autoApprove ? { autoApprove: { ...a.autoApprove } } : {}),
        ...(a.rememberWritesHours !== undefined ? { rememberWritesHours: a.rememberWritesHours } : {}),
      }));
    },
    getRememberedWrites() {
      const text = read('rememberedWrites');
      return text === undefined ? [] : (JSON.parse(text) as RememberedWrite[]);
    },
    setRememberedWrites(list) {
      write('rememberedWrites', JSON.stringify(list));
    },
  };
}
