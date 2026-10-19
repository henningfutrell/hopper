// Issue #1977: whether an image a template runs is published, asked of its registry before a template request saves a
// template, so a request for an image that does not exist is refused then, not in its read-only check later. Unit test:
// src/sandbox/image-published.ts, with the registry a fetch double (the distribution API's HEAD of a manifest, with
// the anonymous bearer token a registry asks for).
//
// Feature: the published image check
//   Scenario: a published image is no problem; its registry's anonymous token is asked once
//   Scenario: an image whose registry answers 404 (manifest unknown) is not published, and the reason says so
//   Scenario: a registry that cannot be reached, or answers something else, says nothing: the request goes on
//   Scenario: a local image is not asked of any registry
//   Scenario: an answer is kept for a while, so the same image is not asked again at each request
//   Scenario: an image reference is read as the registry, the repository and the tag or digest
import { describe, expect, it } from 'vitest';
import { createImageCheck, imageRef } from '../../src/sandbox/image-published.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-test';
const CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:henningfutrell/hopper:pull"';

/** A registry double: `manifests` answers each HEAD of a manifest with the token; the token realm answers one token. */
function registry(manifest: (url: string) => number) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    calls.push(`${init?.method ?? 'GET'} ${url}${auth ? ` ${auth}` : ''}`);
    if (url.startsWith('https://ghcr.io/token?')) return new Response(JSON.stringify({ token: 'anon' }), { status: 200 });
    if (auth !== 'Bearer anon') return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE } });
    return new Response(null, { status: manifest(url) });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('the published image check (issue #1977)', () => {
  it('a published image is no problem; its registry\'s anonymous token is asked once', async () => {
    const r = registry(() => 200);
    expect(await createImageCheck({ fetch: r.fetch })('ghcr.io/henningfutrell/hopper:box-claude')).toBeUndefined();
    expect(r.calls).toEqual([
      'HEAD https://ghcr.io/v2/henningfutrell/hopper/manifests/box-claude',
      'GET https://ghcr.io/token?service=ghcr.io&scope=repository%3Ahenningfutrell%2Fhopper%3Apull',
      'HEAD https://ghcr.io/v2/henningfutrell/hopper/manifests/box-claude Bearer anon',
    ]);
  });

  it('an image whose registry answers 404 (manifest unknown) is not published, and the reason says so', async () => {
    const r = registry((url) => (url.endsWith('/box-test') ? 404 : 200));
    const problem = await createImageCheck({ fetch: r.fetch })(IMAGE);
    expect(problem).toBe(`the image ${IMAGE} is not published: its registry answers manifest unknown`);
  });

  it('a registry that cannot be reached, or answers something else, says nothing: the request goes on', async () => {
    const down = (async () => { throw new Error('getaddrinfo ENOTFOUND ghcr.io'); }) as typeof globalThis.fetch;
    expect(await createImageCheck({ fetch: down })(IMAGE)).toBeUndefined();
    expect(await createImageCheck({ fetch: registry(() => 500).fetch })(IMAGE)).toBeUndefined();
    const noToken = (async () => new Response(null, { status: 401 })) as typeof globalThis.fetch;
    expect(await createImageCheck({ fetch: noToken })(IMAGE)).toBeUndefined();
  });

  it('a local image is not asked of any registry', async () => {
    const r = registry(() => 404);
    expect(await createImageCheck({ fetch: r.fetch })('localhost/hopper-box-tools:0123456789abcdef')).toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it('an answer is kept for a while, so the same image is not asked again at each request', async () => {
    let now = 0;
    let status = 404;
    const r = registry(() => status);
    const check = createImageCheck({ fetch: r.fetch, now: () => now });
    expect(await check(IMAGE)).toBeDefined();
    status = 200;
    expect(await check(IMAGE)).toBeDefined();
    const asked = r.calls.length;
    // A missing image is asked again after a minute: one published since then is seen soon.
    now += 61_000;
    expect(await check(IMAGE)).toBeUndefined();
    expect(r.calls.length).toBeGreaterThan(asked);
  });

  it('an image reference is read as the registry, the repository and the tag or digest', () => {
    expect(imageRef(IMAGE)).toEqual({ registry: 'ghcr.io', repository: 'henningfutrell/hopper', reference: 'box-test' });
    expect(imageRef('ghcr.io/henningfutrell/hopper@sha256:abc')).toEqual({ registry: 'ghcr.io', repository: 'henningfutrell/hopper', reference: 'sha256:abc' });
    expect(imageRef('debian:bookworm-slim')).toEqual({ registry: 'registry-1.docker.io', repository: 'library/debian', reference: 'bookworm-slim' });
    expect(imageRef('docker.io/library/postgres')).toEqual({ registry: 'registry-1.docker.io', repository: 'library/postgres', reference: 'latest' });
    expect(imageRef('registry.example.com:5000/team/app:1.2')).toEqual({ registry: 'registry.example.com:5000', repository: 'team/app', reference: '1.2' });
    expect(imageRef('localhost/hopper-box-tools:abc')).toBeUndefined();
  });
});
