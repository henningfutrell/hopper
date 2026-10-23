// The hopper's default push requirements (issue #2555, design.md "Push requirements"), apart from settings.ts for its size:
// a user's key-value setting, absent when never set; an empty list is none.
import type { PushRequirement } from '../domain/push-requirements.ts';

export function pushRequirementSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getPushRequirementDefaults(): PushRequirement[];
  setPushRequirementDefaults(requirements: readonly PushRequirement[]): void;
} {
  return {
    getPushRequirementDefaults() {
      const text = read('pushRequirementDefaults');
      return text === undefined ? [] : (JSON.parse(text) as { requirements: PushRequirement[] }).requirements;
    },
    setPushRequirementDefaults(requirements) {
      write('pushRequirementDefaults', JSON.stringify({ requirements }));
    },
  };
}
