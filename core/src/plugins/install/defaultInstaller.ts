import { PluginInstaller } from './PluginInstaller.js';
import { LocalFolderBuildBackend } from './LocalFolderBuildBackend.js';
import { GitSourceBuildBackend } from './GitSourceBuildBackend.js';
import { RoutingBuildBackend } from './RoutingBuildBackend.js';

// Production wiring shared by the install API handlers, the startup image
// validator, and PluginExecutor's lazy rebuild path: local sources build on
// the host, git sources build inside the isolated builder.
export function createDefaultPluginInstaller(): PluginInstaller {
  return new PluginInstaller(
    new RoutingBuildBackend(
      new LocalFolderBuildBackend(),
      new GitSourceBuildBackend()
    )
  );
}
