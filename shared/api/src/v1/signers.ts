// Signer-provider surface: account listing + dev send flow. Addresses/labels
// come from plugins (untrusted input -- core validates before they get here);
// responses carry no key material ever.
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";
import { JobRecordSchema, type JobRecord } from "./jobs.js";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

export interface SignerAccount {
  id: string;
  address: string;
  label?: string;
  capability: "sign-only" | "sign-and-send";
}

export type SignerProviderState =
  | "ok"
  | "needs-config"
  | "needs-browser"
  | "error";

export interface SignerProviderAccounts {
  pluginId: string;
  name: string;
  state: SignerProviderState;
  accounts: SignerAccount[];
}

export interface ListSignerAccountsData {
  providers: SignerProviderAccounts[];
}

export interface SendSignerTxRequest {
  pluginId: string;
  accountId: string;
  chainId: number;
  rpcEndpointId: string;
  to: string;
  value: string; // decimal wei string ("0" allowed)
  data?: string;
}

export interface SendSignerTxData {
  job: JobRecord;
}

export const SignerAccountSchema = z.object({
  id: z.string().min(1).max(200),
  address: z.string().regex(HEX_ADDRESS),
  label: z.string().max(120).optional(),
  capability: z.enum(["sign-only", "sign-and-send"]),
});

export const SignerProviderAccountsSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  state: z.enum(["ok", "needs-config", "needs-browser", "error"]),
  accounts: z.array(SignerAccountSchema),
});

export const ListSignerAccountsQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
});
export type ListSignerAccountsQuery = z.infer<
  typeof ListSignerAccountsQuerySchema
>;

export const ListSignerAccountsResponseSchema =
  createApiResponseSchema<ListSignerAccountsData>(
    "ListSignerAccountsResponseSchema",
  )(z.object({ providers: z.array(SignerProviderAccountsSchema) }));

export const SendSignerTxRequestSchema =
  createRequestSchema<SendSignerTxRequest>("SendSignerTxRequestSchema")(
    z.object({
      pluginId: z.string().min(1),
      accountId: z.string().min(1).max(200),
      chainId: z.number().int().positive(),
      rpcEndpointId: z.string().min(1),
      to: z.string().regex(HEX_ADDRESS),
      value: z.string().regex(/^\d+$/),
      data: z.string().regex(HEX_DATA).optional(),
    }),
  );

export const SendSignerTxResponseSchema =
  createApiResponseSchema<SendSignerTxData>("SendSignerTxResponseSchema")(
    z.object({ job: JobRecordSchema }),
  );

export const signerRoutes = {
  listSignerAccounts: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/signers/accounts`,
    querystring: ListSignerAccountsQuerySchema,
    schema: {
      tags: ["signers"],
      response: { 200: ListSignerAccountsResponseSchema },
    },
  },
  sendSignerTx: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/signers/send`,
    schema: {
      tags: ["signers"],
      body: SendSignerTxRequestSchema,
      response: { 200: SendSignerTxResponseSchema },
    },
  },
} as const;
