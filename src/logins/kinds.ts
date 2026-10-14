// The login kinds (issue #476, design.md "Logins"): how the user completes a login of each kind, and what a
// report of one must carry. `device_code` first; a later kind (a browser sign-in, an approval on another
// device) is one more entry here, and nothing in the questions changes.
import type { LoginKind, LoginReport } from '../domain/types.ts';

export interface LoginKindHandler {
  /** What the UI calls it. */
  readonly title: string;
  /** Why `report` cannot be a login of this kind, or undefined. */
  problem(report: LoginReport): string | undefined;
}

const httpUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** RFC 8628: open the URL, enter the code before it expires. */
const deviceCode: LoginKindHandler = {
  title: 'Device login',
  problem(r) {
    if (!httpUrl(r.verificationUrl)) return 'a device login needs the URL to open (http or https)';
    if (!r.userCode?.trim()) return 'a device login needs the code to enter';
    return undefined;
  },
};

/** A tool sign-in (issue #1128): open the URL, sign in, paste the code the page shows into the hopper, which gives it to the tool. */
const pasteCode: LoginKindHandler = {
  title: 'Sign-in',
  problem(r) {
    if (!httpUrl(r.verificationUrl)) return 'a sign-in needs the URL to open (http or https)';
    return r.userCode ? 'a sign-in has no code to enter: the person pastes the code the page shows' : undefined;
  },
};

export const LOGIN_KIND_HANDLERS: Readonly<Record<LoginKind, LoginKindHandler>> = { device_code: deviceCode, paste_code: pasteCode };
