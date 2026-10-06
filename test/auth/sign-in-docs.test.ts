// Sign-in set up at launch (issue #234, docs/deploy.md "Sign-in set up at launch"): the
// install docs give one block of HOPPER_SIGN_IN_* variables for each way in — an auth gateway, OIDC
// single sign-on, SAML, a directory, GitHub — and .env.example carries the same, commented. Every
// block must load as written: a documented setup the daemon refuses at start is a broken install step.
// A `<variable>_FILE=` line stands for its mounted secret, read here as a value.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSignInEnvironment } from '../../src/auth/environment.ts';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** `NAME=value` lines (a leading `# ` removed when `commented`) as an environment; `NAME_FILE` as `NAME`. */
function environment(lines: string[], commented = false): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of lines) {
    const line = commented ? raw.replace(/^# /, '') : raw;
    const m = /^(HOPPER_SIGN_IN_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, name, value] = m;
    if (name!.endsWith('_FILE')) env[name!.slice(0, -'_FILE'.length)] = `secret from ${value}`;
    else env[name!] = value!;
  }
  return env;
}

/** The deploy doc's "Sign-in set up at launch" section: each sh block with sign-in variables, under its heading. */
function deployBlocks(): [string, string[]][] {
  const doc = read('docs/deploy.md');
  const start = doc.indexOf('\n## Sign-in set up at launch');
  if (start < 0) return [];
  const section = doc.slice(start + 1, doc.indexOf('\n## ', start + 1));
  const blocks: [string, string[]][] = [];
  let heading = '';
  for (const part of section.split(/^```/m).entries()) {
    const [i, text] = part;
    if (i % 2 === 0) heading = [...text.matchAll(/^### (.+)$/gm)].at(-1)?.[1] ?? heading;
    else if (text.includes('HOPPER_SIGN_IN_')) blocks.push([heading, text.split('\n')]);
  }
  return blocks;
}

describe('docs/deploy.md "Sign-in set up at launch"', () => {
  const blocks = deployBlocks();

  it('gives a block of variables for each way in: an auth gateway, OIDC, SAML, LDAP and GitHub', () => {
    const types = blocks.flatMap(([, lines]) => Object.entries(environment(lines)).filter(([k]) => k.endsWith('_TYPE')).map(([, v]) => v));
    expect(new Set(types)).toEqual(new Set(['gateway', 'oidc', 'saml', 'ldap', 'github']));
  });

  it.each(blocks)('the block under "%s" loads as written', (_heading, lines) => {
    expect(readSignInEnvironment(environment(lines)).realms).not.toHaveLength(0);
  });
});

describe('.env.example', () => {
  it('carries the sign-in variables, commented, and they load as written', () => {
    const env = environment(read('.env.example').split('\n'), true);
    const types = Object.entries(env).filter(([k]) => /^HOPPER_SIGN_IN_REALM_.+_TYPE$/.test(k)).map(([, v]) => v);
    expect(new Set(types)).toEqual(new Set(['gateway', 'oidc', 'saml']));
    expect(readSignInEnvironment(env).realms).toHaveLength(3);
  });
});
