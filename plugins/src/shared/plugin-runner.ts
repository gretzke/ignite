// Generic type-safe plugin execution system
import type { PluginResult } from "./types.js";
import type { CompilerOperations } from "./base/compiler/types.js";
import type { RepoManagerOperations } from "./base/repo-manager/types.js";

// Union of all operation types
type AllOperations = CompilerOperations & RepoManagerOperations;

// Generic plugin execution interface
export type IPluginExecutor<T extends keyof AllOperations> = {
  [K in T]: (
    options: AllOperations[K]["params"],
  ) => Promise<PluginResult<AllOperations[K]["result"]>>;
};

// Plugin execution request structure
export interface PluginExecutionRequest<T extends keyof AllOperations> {
  operation: T;
  options: AllOperations[T]["params"];
}

// Generic plugin runner function
export async function executePluginOperation<T extends keyof AllOperations>(
  plugin: IPluginExecutor<T>,
  request: PluginExecutionRequest<T>,
): Promise<PluginResult<AllOperations[T]["result"]>> {
  const { operation, options } = request;

  // Type assertion to access the method safely
  const method = plugin[operation] as any;
  if (typeof method !== "function") {
    return {
      success: false,
      error: `Operation '${String(operation)}' not implemented by plugin`,
    };
  }

  try {
    return await method(options);
  } catch (error) {
    return {
      success: false,
      error: `Plugin execution failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// CLI entry point for generic plugin execution
export async function runPluginCLI<T extends keyof AllOperations>(
  plugin: IPluginExecutor<T>,
): Promise<void> {
  try {
    // Parse command line arguments for container execution
    // From the debug output, we see: ["/usr/local/bin/node", "detect", "{\"repoContainerName\":...}"]
    // So operation is at argv[1] and options are at argv[2]
    const operationStr = process.argv[1];
    const optionsJson = process.argv[2] || "{}";

    if (!operationStr) {
      console.log(
        JSON.stringify(
          {
            success: false,
            error: "No operation specified",
          },
          null,
          2,
        ),
      );
      return;
    }

    const options = JSON.parse(optionsJson);

    // Add default workspace path if not provided
    if (!options.workspacePath) {
      options.workspacePath = process.env.WORKSPACE_PATH || "/workspace";
    }

    // Create type-safe execution request
    const request: PluginExecutionRequest<T> = {
      operation: operationStr as T,
      options: options,
    };

    const result = await executePluginOperation(plugin, request);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          success: false,
          error: `CLI execution failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        null,
        2,
      ),
    );
  }
}
