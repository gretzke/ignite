// Base class for verifier plugins. Submit and poll are deliberately separate
// operations because each invocation runs in a fresh plugin container.
import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type {
  CheckVerificationParams,
  CreationTxResult,
  GetCreationTxParams,
  IVerifierPlugin,
  SupportedExplorersResult,
  VerifyParams,
  VerifyStatusResult,
} from "./types.js";

export abstract class VerifierPlugin
  extends BasePlugin<PluginType.VERIFIER>
  implements IVerifierPlugin
{
  public readonly type = PluginType.VERIFIER as const;

  abstract getSupportedExplorers(): Promise<
    PluginResponse<SupportedExplorersResult>
  >;
  abstract verify(options: VerifyParams): Promise<PluginResponse<VerifyStatusResult>>;
  abstract checkVerification(
    options: CheckVerificationParams,
  ): Promise<PluginResponse<VerifyStatusResult>>;
  abstract getCreationTx(
    options: GetCreationTxParams,
  ): Promise<PluginResponse<CreationTxResult>>;
}

export type {
  CheckVerificationParams,
  CreationTxResult,
  DetectedExplorer,
  GetCreationTxParams,
  IVerifierPlugin,
  SupportedExplorersResult,
  VerifierOperation,
  VerifierOperations,
  VerifyParams,
  VerifyStatusResult,
} from "./types.js";
