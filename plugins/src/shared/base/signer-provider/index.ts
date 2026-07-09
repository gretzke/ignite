// Base class for signer-provider plugins.
import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type {
  GetAccountsResult,
  ISignerProviderPlugin,
  SendTransactionParams,
  SendTransactionResult,
  SignTransactionParams,
  SignTransactionResult,
} from "./types.js";

export abstract class SignerProviderPlugin
  extends BasePlugin<PluginType.SIGNER_PROVIDER>
  implements ISignerProviderPlugin
{
  public readonly type = PluginType.SIGNER_PROVIDER as const;

  abstract getAccounts(): Promise<PluginResponse<GetAccountsResult>>;

  abstract signTransaction(
    options: SignTransactionParams,
  ): Promise<PluginResponse<SignTransactionResult>>;

  // Default for sign-only providers: sign-and-send providers override this.
  async sendTransaction(
    _options: SendTransactionParams,
  ): Promise<PluginResponse<SendTransactionResult>> {
    return {
      success: false,
      error: {
        code: "OPERATION_NOT_IMPLEMENTED",
        message: "This signer provider is sign-only; core broadcasts for it.",
      },
    };
  }
}

export type {
  ChainMetadata,
  GetAccountsResult,
  Hex,
  ISignerProviderPlugin,
  SendTransactionParams,
  SendTransactionResult,
  SignerAccount,
  SignerProviderOperation,
  SignerProviderOperations,
  SignTransactionParams,
  SignTransactionResult,
  UnsignedTx,
} from "./types.js";
