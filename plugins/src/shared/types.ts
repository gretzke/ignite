// Core plugin types
export interface PluginResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Compiler plugin types
export type DetectionResult = boolean;
