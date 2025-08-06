import { PluginResult } from '@ignite/plugin-types/types';

export interface WorkflowStep {
  id: string;
  plugin: string;
  operation: string;
  options?: Record<string, unknown>;
  dependencies?: string[]; // IDs of previous steps
}

export interface PluginWorkflow {
  steps: WorkflowStep[];
}

export interface StepResources {
  volumeId?: string;
  repoContainerName?: string;
  workspacePath?: string;
  artifacts?: Record<string, unknown>;
  [key: string]: unknown; // Flexible resource passing
}

export interface ExecutionContext {
  stepResults: Map<string, PluginResult<unknown>>;
  stepResources: Map<string, StepResources>; // Track workflow resources separately
  workflow: PluginWorkflow;
}
