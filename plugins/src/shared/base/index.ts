export type NoParams = Record<string, never>;
export type NoResult = Record<string, never>;

// Re-export all base plugin types and classes
export * from "./compiler/index.js";
export * from "./rpc-provider/index.js";
export * from "./signer-provider/index.js";
export * from "./verifier/index.js";
