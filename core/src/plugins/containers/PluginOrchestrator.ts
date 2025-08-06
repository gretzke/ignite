import { getLogger } from '../../utils/logger.js';
import { PluginExecutor } from './PluginExecutor.js';
import type {
  PluginWorkflow,
  WorkflowStep,
  ExecutionContext,
  StepResources,
} from '../../types/plugins.js';
import type { PluginResult } from '@ignite/plugin-types/types';

// Orchestrates plugin workflows with dependency resolution
export class PluginOrchestrator {
  private static instance: PluginOrchestrator;
  private executor: PluginExecutor;

  private constructor() {
    this.executor = PluginExecutor.getInstance();
  }

  /**
   * Get singleton instance of PluginOrchestrator
   */
  static getInstance(): PluginOrchestrator {
    if (!PluginOrchestrator.instance) {
      PluginOrchestrator.instance = new PluginOrchestrator();
    }
    return PluginOrchestrator.instance;
  }

  async initialize(): Promise<void> {
    await this.executor.initialize();
  }

  // Execute a single plugin (simple case)
  async executePlugin(
    pluginId: string,
    operation: string,
    options: Record<string, unknown>
  ): Promise<PluginResult<unknown>> {
    return this.executor.execute(pluginId, operation, options);
  }

  // Execute a complete workflow with dependency resolution
  async executeWorkflow(workflow: PluginWorkflow): Promise<ExecutionContext> {
    getLogger().info(
      `🚀 Starting workflow with ${workflow.steps.length} steps`
    );

    const context: ExecutionContext = {
      stepResults: new Map(),
      stepResources: new Map(),
      workflow,
    };

    // Simple dependency resolution for MVP - execute steps in order
    for (const step of workflow.steps) {
      getLogger().info(
        `📋 Executing step: ${step.id} (${step.plugin}.${step.operation})`
      );

      try {
        // Resolve inputs from previous steps
        const resolvedOptions = this.resolveStepInputs(step, context);

        // Execute the step
        const result = await this.executor.execute(
          step.plugin,
          step.operation,
          resolvedOptions
        );

        // Store result
        context.stepResults.set(step.id, result);

        // Extract resources from plugin data for workflow orchestration
        if (result.success && result.data) {
          const resources: Partial<StepResources> = {};
          const data = result.data as Record<string, unknown>;

          // Extract container information if present
          if (data.containerName && typeof data.containerName === 'string') {
            resources.repoContainerName = data.containerName;
          }
          if (data.workspacePath && typeof data.workspacePath === 'string') {
            resources.workspacePath = data.workspacePath;
          }
          if (
            data.artifacts &&
            typeof data.artifacts === 'object' &&
            data.artifacts !== null
          ) {
            resources.artifacts = data.artifacts as Record<string, unknown>;
          }

          if (Object.keys(resources).length > 0) {
            context.stepResources.set(step.id, resources);
          }
        }

        if (result.success) {
          getLogger().info(`✅ Step ${step.id} completed successfully`);
        } else {
          getLogger().error(`❌ Step ${step.id} failed: ${result.error}`);
          // For MVP, stop on first failure
          break;
        }
      } catch (error) {
        getLogger().error(`💥 Step ${step.id} threw error:`, error);
        context.stepResults.set(step.id, {
          success: false,
          error: String(error),
        });
        break;
      }
    }

    getLogger().info('🏁 Workflow execution completed');
    return context;
  }

  // Resolve step inputs by injecting outputs from dependencies
  private resolveStepInputs(
    step: WorkflowStep,
    context: ExecutionContext
  ): Record<string, unknown> {
    let resolvedOptions = { ...step.options } as Record<string, unknown>;

    // Inject resources from dependency steps
    if (step.dependencies) {
      for (const depId of step.dependencies) {
        const depResult = context.stepResults.get(depId);
        const depResources = context.stepResources.get(depId);
        if (depResult?.success && depResources) {
          // Merge dependency resources into step options
          resolvedOptions = { ...resolvedOptions, ...depResources };
        }
      }
    }

    return resolvedOptions;
  }

  // Get results from a completed workflow
  getStepResult(
    context: ExecutionContext,
    stepId: string
  ): PluginResult<unknown> | undefined {
    return context.stepResults.get(stepId);
  }

  // Check if workflow completed successfully
  isWorkflowSuccessful(context: ExecutionContext): boolean {
    return Array.from(context.stepResults.values()).every(
      (result) => result.success
    );
  }

  async cleanup(): Promise<void> {
    await this.executor.cleanup();
  }
}
