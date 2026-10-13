// A user's settings for the templates and sandboxes their jobs ask for: the read policy (issue #716, "Templates on
// request") and the sandbox approval toggles (issue #991, "Sandboxes jobs start"). Part of the user's settings
// repository (settings.ts).
import type { UserSettingsRepository } from '../domain/ports.ts';

type SandboxSettings = Pick<UserSettingsRepository, 'getReadPolicy' | 'setReadPolicy' | 'getSandboxApprovals' | 'setSandboxApprovals'>;

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
      const a = JSON.parse(text) as { skipTemplateApproval?: unknown; skipSandboxApproval?: unknown };
      return { skipTemplateApproval: a.skipTemplateApproval === true, skipSandboxApproval: a.skipSandboxApproval === true };
    },
    setSandboxApprovals(a) {
      write('sandboxApprovals', JSON.stringify({ skipTemplateApproval: a.skipTemplateApproval, skipSandboxApproval: a.skipSandboxApproval }));
    },
  };
}
