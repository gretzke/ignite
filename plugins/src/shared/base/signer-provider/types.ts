import { PluginType } from "../../types.js";
import type {
  ChainMetadata,
  Hex,
  PluginResponse,
  UnsignedTx,
} from "../../types.js";
import type { NoParams } from "../../index.js";

export type { ChainMetadata, Hex, UnsignedTx };

// One account exposed by a signer provider. Capability is per-account so a
// single provider can mix sign-only and sign-and-send accounts.
export interface SignerAccount {
  id: string;
  address: Hex;
  label?: string;
  capability: "sign-only" | "sign-and-send";
}

// null means "nothing configured yet" (no keys added / no mnemonic);
// distinct from [], which means the provider ran fine and has no accounts.
export interface GetAccountsResult {
  accounts: SignerAccount[] | null;
}

export interface SignTransactionParams {
  accountId: string;
  tx: UnsignedTx;
}

export interface SignTransactionResult {
  rawTransaction: Hex;
}

export interface SendTransactionParams {
  accountId: string;
  tx: UnsignedTx;
  rpcUrl: string;
  chain: ChainMetadata;
}

export interface SendTransactionResult {
  txHash: Hex;
}

export type SignerProviderOperations = {
  getAccounts: { params: NoParams; result: GetAccountsResult };
  signTransaction: {
    params: SignTransactionParams;
    result: SignTransactionResult;
  };
  sendTransaction: {
    params: SendTransactionParams;
    result: SendTransactionResult;
  };
};

export type SignerProviderOperation = keyof SignerProviderOperations;

export type ISignerProviderPlugin = {
  type: PluginType.SIGNER_PROVIDER;
} & {
  [K in keyof SignerProviderOperations]: (
    options: SignerProviderOperations[K]["params"],
  ) => Promise<PluginResponse<SignerProviderOperations[K]["result"]>>;
};
