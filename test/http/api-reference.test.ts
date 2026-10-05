// The API reference keeps up with the routes (issue #68): the daemon refuses to start when a route
// under /api/ or /ui/ is not in it, or it names a route that is not served.
import { describe, expect, it } from 'vitest';
import { referenceDrift } from '../../src/http/openapi.ts';

const doc = { paths: { '/api/jobs/{id}': { get: {} }, '/ui/api/logout': { post: {} } } };

describe('referenceDrift', () => {
  it('is empty when the routes and the reference agree; HEAD, the UI page, its assets and /docs are not API routes', () => {
    expect(referenceDrift(doc, [
      { method: 'GET', url: '/api/jobs/:id' }, { method: 'HEAD', url: '/api/jobs/:id' }, { method: 'POST', url: '/ui/api/logout' },
      { method: 'GET', url: '/' }, { method: 'GET', url: '/ui/assets/index-abc.js' }, { method: 'GET', url: '/docs/openapi.json' },
    ])).toEqual([]);
  });

  it('names a served route the reference lacks, and a documented one nothing serves', () => {
    expect(referenceDrift(doc, [{ method: 'GET', url: '/api/jobs/:id' }, { method: 'POST', url: '/ui/api/new' }])).toEqual([
      'POST /ui/api/new is served but not in the API reference (src/http/openapi.ts)',
      'POST /ui/api/logout is in the API reference (src/http/openapi.ts) but not served',
    ]);
  });
});
