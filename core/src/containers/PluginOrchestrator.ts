import { getLogger } from '../utils/logger.js';
import { PluginExecutor } from './PluginExecutor.js';
import type {
  PluginWorkflow,
  WorkflowStep,
  StepResult,
  ExecutionContext,
} from '../types/plugins.js';

// Orchestrates plugin workflows with dependency resolution
export class PluginOrchestrator {
  private executor: PluginExecutor;

  constructor() {
    this.executor = new PluginExecutor();
  }

  async initialize(): Promise<void> {
    await this.executor.initialize();
  }

  // Execute a single plugin (simple case)
  async executePlugin(
    pluginId: string,
    operation: string,
    options: any
  ): Promise<StepResult> {
    return this.executor.execute(pluginId, operation, options);
  }

  // Execute a complete workflow with dependency resolution
  async executeWorkflow(workflow: PluginWorkflow): Promise<ExecutionContext> {
    getLogger().info(
      `🚀 Starting workflow with ${workflow.steps.length} steps`
    );

    const context: ExecutionContext = {
      stepResults: new Map(),
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
  ): any {
    let resolvedOptions = { ...step.options };

    // Inject resources from dependency steps
    if (step.dependencies) {
      for (const depId of step.dependencies) {
        const depResult = context.stepResults.get(depId);
        if (depResult?.success && depResult.resources) {
          // Merge dependency resources into step options
          resolvedOptions = { ...resolvedOptions, ...depResult.resources };
        }
      }
    }

    return resolvedOptions;
  }

  // Get results from a completed workflow
  getStepResult(
    context: ExecutionContext,
    stepId: string
  ): StepResult | undefined {
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
