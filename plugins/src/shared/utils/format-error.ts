import type { PluginResponse } from "../types.js";
import type { ExecResult } from "./exec.js";

// Build a user-facing message from a failed exec: prefer the stderr tail
// (where compilers write their diagnostics), fall back to stdout
export function execFailureMessage(
  label: string,
  result: PluginResponse<ExecResult>,
  maxChars = 4000,
): string {
  if (result.success) {
    return label;
  }
  const details = (result.error?.details ?? {}) as Record<string, unknown>;
  const stderr = typeof details.stderr === "string" ? details.stderr : "";
  const stdout = typeof details.stdout === "string" ? details.stdout : "";
  const output = (stderr || stdout).slice(-maxChars).trim();
  return output ? `${label}:\n${output}` : label;
}
