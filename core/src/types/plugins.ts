// Plugin orchestration types for MVP
export interface PluginMetadata {
  id: string;
  type: 'repo-manager' | 'compiler';
  baseImage: string;
}

export interface WorkflowStep {
  id: string;
  plugin: string;
  operation: string;
  options?: any;
  dependencies?: string[]; // IDs of previous steps
}

export interface PluginWorkflow {
  steps: WorkflowStep[];
}

export interface StepResult {
  success: boolean;
  data?: any;
  error?: string;
  resources?: StepResources; // Resources produced by this step
}

export interface StepResources {
  volumeId?: string;
  artifacts?: any;
  [key: string]: any; // Flexible resource passing
}

export interface ExecutionContext {
  stepResults: Map<string, StepResult>;
  workflow: PluginWorkflow;
}
