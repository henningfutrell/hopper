// The herdr view's model (issue #189): where its socket opens (this page's host, ws or wss as the page
// is http or https), what the terminal sends (keys, its size), and how each machine reads.
import { describe, expect, it } from 'vitest';
import { inputMessage, machineLine, resizeMessage, socketUrl } from '../../ui/src/model/herdr-terminal.ts';

describe('the herdr view', () => {
  it('opens its socket on the page\'s own host, wss behind https', () => {
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:4790' }, 'ab12', { cols: 120, rows: 40 })).toBe('ws://127.0.0.1:4790/ui/api/herdr-terminal/socket?ticket=ab12&cols=120&rows=40');
    expect(socketUrl({ protocol: 'https:', host: 'hopper.example' }, 'ab12', { cols: 80, rows: 24 })).toBe('wss://hopper.example/ui/api/herdr-terminal/socket?ticket=ab12&cols=80&rows=24');
  });

  it('sends keys and its size as the socket reads them', () => {
    expect(JSON.parse(inputMessage('\x1b[A'))).toEqual({ type: 'input', data: '\x1b[A' });
    expect(JSON.parse(resizeMessage({ cols: 100, rows: 30 }))).toEqual({ type: 'resize', cols: 100, rows: 30 });
  });

  it('says of each machine whether the root herdr lists it, and if not, why', () => {
    expect(machineLine({ name: 'laptop', label: 'Laptop', listed: true })).toEqual({ tone: 'neutral', text: 'listed' });
    expect(machineLine({ name: 'laptop', label: 'Laptop', listed: true, sync: 'saved' })).toEqual({ tone: 'good', text: 'in the sidebar' });
    expect(machineLine({ name: 'laptop', label: 'Laptop', listed: true, sync: 'failed', error: 'ssh: connect timed out' })).toEqual({ tone: 'bad', text: 'herdr could not save it: ssh: connect timed out' });
    expect(machineLine({ name: 'box', label: 'box', listed: false, reason: 'a container target runs no herdr' })).toEqual({ tone: 'muted', text: 'not listed: a container target runs no herdr' });
  });
});
