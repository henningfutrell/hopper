// The built-in plugins. A new built-in lives at src/plugins/<role>/<id>/index.ts and is listed here.
import jevRouter from './router/jev-router/index.ts';
import passThrough from './router/pass-through/index.ts';
import type { PluginDefinition } from './sdk.ts';

export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [jevRouter, passThrough];
