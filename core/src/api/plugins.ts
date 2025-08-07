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
      // Determine host path from CLI or CWD
      const hostPath = process.env.IGNITE_WORKSPACE_PATH || process.cwd();

      // Delegate to handler; it will perform any necessary checks and orchestration
      const result = await pluginOrchestrator.executePlugin(
        'foundry',
        'detect',
        { hostPath }
      );

      return result;
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
