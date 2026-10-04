// test: the built-in test executor (design.md "Test executor"). No options; always available.
import { createTestExecutor } from '../../../executors/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

const testExecutor: PluginDefinition<'executor', Record<string, never>> = {
  id: 'test',
  role: 'executor',
  describe: 'Built-in test executor: sleep, echo, fail, ask, fail-after-answer',
  async detect() { return { status: 'available' }; },
  create: () => createTestExecutor(),
};

export default testExecutor;
