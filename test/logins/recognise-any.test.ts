// Issue #698: a device login of a CLI the hopper has no recogniser of its own for — or the job's own words about
// one — is still recognised: a device page URL and, near it, a code the words call one. The tool is the page's host.
import { describe, expect, it } from 'vitest';
import { hideCodes, recogniseDeviceCode } from '../../src/logins/recognise.ts';

/** `aws sso login --use-device-code`, as aws-cli v2 prints it. */
const AWS = [
  'Attempting to automatically open the SSO authorization page in your default browser.',
  'If the browser does not open or you wish to use a different device to authorize this request, open the following URL:',
  '',
  'https://device.sso.eu-west-1.amazonaws.com/',
  '',
  'Then enter the code:',
  '',
  'SPBX-QHWR',
].join('\n');

/** `az login --use-device-code`, as the Azure CLI prints it: no dash in the code. */
const AZ = 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code HGA6S7RN2 to authenticate.';

describe('device-code prompts of any CLI (issue #698)', () => {
  it('recognises the AWS CLI: the URL above, the code below', () => {
    expect(recogniseDeviceCode(AWS)).toEqual({ tool: 'device.sso.eu-west-1.amazonaws.com', verificationUrl: 'https://device.sso.eu-west-1.amazonaws.com/', userCode: 'SPBX-QHWR', expiresInSec: 900 });
  });

  it('recognises the Azure CLI: a code with no dash', () => {
    expect(recogniseDeviceCode(AZ)).toEqual({ tool: 'microsoft.com', verificationUrl: 'https://microsoft.com/devicelogin', userCode: 'HGA6S7RN2', expiresInSec: 900 });
  });

  it("recognises the job's own words, with the expiry it gives", () => {
    const said = '● The login waits. Open https://www.example.org/activate and enter code `QWER-TYUI` (expires in 10 minutes).';
    expect(recogniseDeviceCode(said)).toEqual({ tool: 'example.org', verificationUrl: 'https://www.example.org/activate', userCode: 'QWER-TYUI', expiresInSec: 600 });
  });

  it('a CLI the hopper knows keeps its own name', () => {
    const gh = '! First copy your one-time code: WDJB-MJHT\nOpen this URL to continue in your web browser: https://github.com/login/device';
    expect(recogniseDeviceCode(gh)?.tool).toBe('gh');
  });

  it('recognises nothing without a device page, without the word code, or with a short code', () => {
    expect(recogniseDeviceCode('See https://example.com/docs/errors for the error code ABCD-1234.')).toBeUndefined();
    expect(recogniseDeviceCode('Open https://example.com/device. Ticket PROJ-1234 is fixed.')).toBeUndefined();
    expect(recogniseDeviceCode('Open https://example.com/device and enter the code AB-12.')).toBeUndefined();
    expect(recogniseDeviceCode('The exit code was 1. https://example.com/device')).toBeUndefined();
  });

  it('hides such a code', () => {
    expect(hideCodes('copy SPBX-QHWR', AWS)).toBe('copy [code hidden]');
    expect(hideCodes(AZ)).not.toContain('HGA6S7RN2');
  });
});
