// The update notice's words and links (issue #44): pure, from GET /api/update.
import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../src/domain/types.ts';
import { CHANNELS, headline, imageUpdate, reloadNeeded, showNotice } from '../../ui/src/model/update.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const installed = { kind: 'install' as const, repo: 'git@github.com:o/r.git', branch: 'stable', commit: A, installedAt: '2026-10-04T00:00:00Z' };
const status = (o: Partial<UpdateStatus>): UpdateStatus => ({ state: 'current', channel: 'stable', autoUpdate: false, whatsNew: [], installedWhatsNew: [], restartBlockers: 0, installed, ...o });

describe('update model', () => {
  it('the channels are dev, beta and stable, least stable first (issue #423)', () => {
    expect(CHANNELS.map((c) => c.channel)).toEqual(['dev', 'beta', 'stable']);
  });

  it('headline: what is newer, what is happening, or why not; never commits', () => {
    expect(headline(status({ state: 'available', target: { commit: B, ref: 'stable' }, whatsNew: ['x', 'y'] }))).toBe('Update available');
    expect(headline(status({ state: 'available', channel: 'beta', target: { commit: B, ref: 'beta' } }))).toBe('Update available: move to the beta channel');
    expect(headline(status({ state: 'available', channel: 'dev', installed: { ...installed, branch: 'dev' }, target: { commit: B, ref: 'dev' } }))).toBe('Update available');
    // An image is updated by the user pulling its channel's tag, never in place (issues #409, #494).
    expect(headline(status({ state: 'available', installed: { ...installed, kind: 'image' }, target: { commit: B, ref: 'stable' } }))).toBe('Update available: pull the stable image and recreate the container');
    expect(headline(status({ state: 'applying', apply: { phase: 'waiting', detail: 'waiting for job j1', target: B, startedAt: '' } }))).toBe('Updating: waiting for job j1');
    expect(headline(status({ state: 'error', reason: 'fetch failed' }))).toBe('Update problem: fetch failed');
    expect(headline(status({}))).toBe('Up to date');
    expect(headline(status({ state: 'unavailable', installed: undefined, reason: 'no install.json' }))).toBe('Self-update unavailable: no install.json');
  });

  describe('an image install (issue #494): the commands for the selected channel\'s image tag', () => {
    const image = (channel: UpdateStatus['channel'], branch: string, o: Partial<UpdateStatus> = {}) =>
      status({ state: 'available', channel, installed: { ...installed, kind: 'image', branch }, target: { commit: B, ref: channel }, ...o });

    for (const channel of ['dev', 'beta', 'stable'] as const) {
      it(`${channel}: the tag of the channel, the pull and recreate of the hopper container alone, and the prune`, () => {
        const u = imageUpdate(image(channel, channel))!;
        expect(headline(image(channel, channel))).toBe(`Update available: pull the ${channel} image and recreate the container`);
        expect(u.env).toBe(`HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:${channel}`);
        expect(u.commands).toEqual([
          { tool: 'Podman', update: 'podman compose pull hopper && podman compose up -d --force-recreate --no-deps hopper', prune: 'podman image prune -f --filter label=org.opencontainers.image.title=hopper' },
          { tool: 'Docker', update: 'docker compose pull hopper && docker compose up -d --force-recreate --no-deps hopper', prune: 'docker image prune -f --filter label=org.opencontainers.image.title=hopper' },
        ]);
        expect(JSON.stringify(u)).not.toMatch(/postgres|volume|down/);
        expect(u.mismatch).toBeUndefined();
      });
    }

    it('says so plainly when the running image is not the selected channel\'s', () => {
      const s = image('dev', 'stable');
      expect(imageUpdate(s)!.mismatch).toBe('this container runs the stable image; the selected channel is dev: switch the image tag');
      expect(headline(s)).toBe('Update available: this container runs the stable image; the selected channel is dev: switch the image tag');
      expect(imageUpdate(s)!.env).toBe('HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:dev');
    });

    it('counts the running jobs a recreate would lose, and says to wait until none', () => {
      expect(imageUpdate(image('stable', 'stable', { restartBlockers: 2 }))!.blockers).toBe('2 running jobs would be lost by recreating the container: wait until none runs.');
      expect(imageUpdate(image('stable', 'stable', { restartBlockers: 1 }))!.blockers).toBe('1 running job would be lost by recreating the container: wait until none runs.');
      expect(imageUpdate(image('stable', 'stable'))!.blockers).toBe('No running job would be lost: jobs that reattach keep running across the recreate.');
    });

    it('none for an install, or with no update', () => {
      expect(imageUpdate(status({ state: 'available', target: { commit: B, ref: 'stable' } }))).toBeUndefined();
      expect(imageUpdate(image('stable', 'stable', { state: 'current' }))).toBeUndefined();
    });
  });

  it('shows the notice only when there is something to act on or watch', () => {
    expect(showNotice(status({ state: 'available' }))).toBe(true);
    expect(showNotice(status({ state: 'applying' }))).toBe(true);
    expect(showNotice(status({ state: 'error' }))).toBe(true);
    expect(showNotice(status({}))).toBe(false);
    expect(showNotice(status({ state: 'unavailable' }))).toBe(false);
    expect(showNotice(null)).toBe(false);
  });

  it('reloadNeeded: the daemon now runs another commit than the page was loaded from', () => {
    expect(reloadNeeded(A, status({ installed: { ...installed, commit: B } }))).toBe(true);
    expect(reloadNeeded(A, status({}))).toBe(false);
    expect(reloadNeeded(undefined, status({}))).toBe(false);
  });
});
