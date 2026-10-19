// The crash harness on landing batches (issues #1954, #1589, design.md "The crash harness" part 8): a hopper killed with
// SIGKILL after each GitHub write of the batch runner, before the event that records it, leaves the batch to a second
// hopper on the same database. That hopper takes it to the end a clean run reaches: each pull request, revert and issue
// exists once at GitHub, and no pull request or branch of the hopper's is left. The scenarios are in landing-world.ts;
// their tests are split over the landing-kill-*.test.ts files, so the shards of the pull request check share them.
//
// Feature: a kill between a GitHub write of the landing batches and its event
//   Scenario: a clean run writes what the kill points name, and ends with each effect once
//   Scenario Outline: killed after <write> #<n>: the next hopper ends the batch, each effect once (merge conflicts, its first 6 points)
import { describe } from 'vitest';
import { describeLanding } from './landing-world.ts';

describe('landing batches killed between a GitHub write and its event (issues #1954, #1589)', () => {
  describeLanding('back-merge', 0, 6);
});
