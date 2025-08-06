import type { FastifyInstance } from 'fastify';
import type { PluginManager, PluginType } from '../filesystem/PluginManager.js';
import type { PluginOrchestrator } from '../plugins/containers/PluginOrchestrator.js';

// Plugin management and execution API routes
export async function registerPluginRoutes(
  app: FastifyInstance,
  pluginManager: PluginManager,
  pluginOrchestrator: PluginOrchestrator
) {
  // List plugins
  app.get('/api/plugins', async (request) => {
    const { type } = request.query as { type?: string };
    const plugins = await pluginManager.listPluginsWithTrust(
      type as PluginType
    );
    return { plugins };
  });

  // Get specific plugin
  app.get('/api/plugins/:pluginId', async (request) => {
    const { pluginId } = request.params as { pluginId: string };
    const pluginWithTrust = await pluginManager.getPluginWithTrust(pluginId);
    return pluginWithTrust;
  });

  // Plugin detection endpoint (MVP: foundry detection)
  app.post('/api/detect', async () => {
    try {
      // Use the pre-mounted default workspace (mounted at CLI startup)
      const result = await pluginOrchestrator.executePlugin(
        'foundry',
        'detect',
        { repoContainerName: 'ignite-repo-local-default-workspace' }
      );

      return result;
    } catch (error) {
      return { error: String(error) };
    }
  });

  // Workflow execution endpoint (MVP: repo -> foundry workflow)
  app.post('/api/workflows/foundry', async (request) => {
    const { hostPath: requestPath } = request.body as { hostPath?: string };

    // Use provided path or fall back to CLI-provided workspace path
    const hostPath =
      requestPath || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

    try {
      // Execute foundry workflow: local-repo -> foundry detection -> compilation
      const workflow = {
        steps: [
          {
            id: 'repo',
            plugin: 'local-repo',
            operation: 'mount',
            options: { hostPath },
          },
          {
            id: 'detect',
            plugin: 'foundry',
            operation: 'detect',
            dependencies: ['repo'],
          },
          {
            id: 'compile',
            plugin: 'foundry',
            operation: 'compile',
            dependencies: ['repo'],
          },
        ],
      };

      const context = await pluginOrchestrator.executeWorkflow(workflow);

      return {
        success: pluginOrchestrator.isWorkflowSuccessful(context),
        steps: Object.fromEntries(context.stepResults),
        workflow,
      };
    } catch (error) {
      return { error: String(error) };
    }
  });

  // TODO: SECURITY - Add authentication middleware to prevent plugins from self-elevating trust
  // Plugin containers should NOT be able to call localhost:1301 to grant themselves permissions
  // Need to implement: network isolation, UI-only trust modification, user confirmation flow
  app.post('/api/plugins/:pluginId/trust', async (request) => {
    const { pluginId } = request.params as { pluginId: string };
    const { trustLevel } = request.body as { trustLevel: string };

    if (!pluginId || !trustLevel) {
      throw new Error('Plugin ID and trust level are required');
    }

    // TODO: Implement actual trust modification
    return {
      success: true,
      message: `Trust level for ${pluginId} set to ${trustLevel}`,
    };
  });
}
