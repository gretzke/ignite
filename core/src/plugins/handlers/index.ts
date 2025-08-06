import { CompilerHandler } from './CompilerHandler.js';
import { RepoManagerHandler } from './RepoManagerHandler.js';

// Plugin-specific handler instances
export const PLUGIN_HANDLERS = {
  // Compiler plugins
  foundry: new CompilerHandler('foundry'),
  hardhat: new CompilerHandler('hardhat'),
  // Repo manager plugins
  'local-repo': new RepoManagerHandler('local-repo'),
  'git-repo': new RepoManagerHandler('git-repo'),
} as const;

export function getHandler(pluginId: string) {
  const handler = PLUGIN_HANDLERS[pluginId as keyof typeof PLUGIN_HANDLERS];
  if (!handler) {
    throw new Error(`No handler found for plugin: ${pluginId}`);
  }
  return handler;
}

export type HandlerType<T extends keyof typeof PLUGIN_HANDLERS> =
  (typeof PLUGIN_HANDLERS)[T];

export { CompilerHandler } from './CompilerHandler.js';
export { RepoManagerHandler } from './RepoManagerHandler.js';
