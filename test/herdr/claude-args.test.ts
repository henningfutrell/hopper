// Yolo (issue #267): the herdr-claude instance's `yolo` decides whether Claude starts with every
// permission granted; `args` never does. The command line Claude starts with, either way.
import { describe, expect, it } from 'vitest';
import { YOLO_SETTINGS, claudeArgsFor } from '../../src/executors/herdr/start.ts';

describe('claudeArgsFor', () => {
  it('yolo: every permission granted, and the warning about it already accepted', () => {
    expect(claudeArgsFor(true, [])).toEqual(['--dangerously-skip-permissions', '--settings', YOLO_SETTINGS]);
    expect(JSON.parse(YOLO_SETTINGS)).toEqual({ skipDangerousModePermissionPrompt: true });
  });

  it('yolo keeps the other arguments, after its own, and grants every permission once', () => {
    expect(claudeArgsFor(true, ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--mcp-config', 'm.json']))
      .toEqual(['--dangerously-skip-permissions', '--settings', YOLO_SETTINGS, '--mcp-config', 'm.json']);
  });

  it('yolo leaves settings the arguments already name to them (the startup dialog is answered on screen instead)', () => {
    expect(claudeArgsFor(true, ['--settings', 'mine.json'])).toEqual(['--dangerously-skip-permissions', '--settings', 'mine.json']);
  });

  it('not yolo: Claude asks; arguments that would grant every permission are dropped', () => {
    expect(claudeArgsFor(false, [])).toEqual([]);
    expect(claudeArgsFor(false, ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions', '--allowedTools', 'Read']))
      .toEqual(['--allowedTools', 'Read']);
    expect(claudeArgsFor(false, ['--permission-mode', 'acceptEdits'])).toEqual(['--permission-mode', 'acceptEdits']);
  });
});
