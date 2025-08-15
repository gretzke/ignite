export type NoParams = Record<string, never>;
export type NoResult = Record<string, never>;

// Re-export all base plugin types and classes
export * from "./compiler/index.js";
export * from "./repo-manager/index.js";
