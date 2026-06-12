// Generic type-safe plugin execution system
import type { PluginResponse } from "./types.js";
import type { CompilerOperations } from "./base/compiler/types.js";
import type { RepoManagerOperations } from "./base/repo-manager/types.js";

// Union of all operation types
type AllOperations = CompilerOperations & RepoManagerOperations;

// Generic plugin execution interface
export type IPluginExecutor<T extends keyof AllOperations> = {
  [K in T]: (
    options: AllOperations[K]["params"],
  ) => Promise<PluginResponse<AllOperations[K]["result"]>>;
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
): Promise<PluginResponse<AllOperations[T]["result"]>> {
  const { operation, options } = request;

  // Type assertion to access the method safely
  const method = plugin[operation] as any;
  if (typeof method !== "function") {
    return {
      success: false,
      error: {
        message: `Operation '${String(operation)}' not implemented by plugin`,
        code: "OPERATION_NOT_IMPLEMENTED", // TODO: create enum enum and import in CLI for error handling
      },
    };
  }

  try {
    return await method.call(plugin, options);
  } catch (error) {
    return {
      success: false,
      error: {
        message: `Plugin execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        code: "PLUGIN_EXECUTION_ERROR",
        details: {
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
    };
  }
}

// Read the full stdin stream until EOF
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// CLI entry point for generic plugin execution
export async function runPluginCLI<T extends keyof AllOperations>(
  plugin: IPluginExecutor<T>,
): Promise<void> {
  if (process.env.IGNITE_PLUGIN_BUILD) {
    return;
  }
  try {
    // Operation comes via argv; options arrive on stdin so that secrets
    // (e.g. git credentials) never appear in the container's process list
    const operationStr = process.argv[1];
    const optionsJson = (await readStdin()).trim() || "{}";

    if (!operationStr) {
      console.log(
        JSON.stringify(
          {
            success: false,
            error: {
              code: "NO_OPERATION_SPECIFIED",
              message: "No operation specified",
              details: {
                instructions: process.argv,
              },
            },
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
          error: {
            code: "CLI_EXECUTION_FAILED",
            message: `CLI execution failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            details: {
              stack: error instanceof Error ? error.stack : undefined,
            },
          },
        },
        null,
        2,
      ),
    );
  }
}
