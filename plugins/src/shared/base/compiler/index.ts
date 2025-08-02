// Base class for compiler plugins (Foundry, Hardhat, etc.)
import { BasePlugin } from "../../base-plugin.ts";
import type { DetectionResult, PluginResult } from "../../types.ts";

export abstract class CompilerPlugin extends BasePlugin {
  abstract detect(
    workspacePath: string,
  ): Promise<PluginResult<DetectionResult>>;
}
