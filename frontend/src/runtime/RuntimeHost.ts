import { apiClient } from '../store/api/client';
import type { ListPluginsData } from '@ignite/api';

export type PluginResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

interface RuntimeRequestFrame {
  requestId: string;
  pluginId: string;
  operation: string;
  params: unknown;
}

interface RuntimePlugin {
  [operation: string]: unknown;
}

const HOST_ERROR_MAX_CHARS = 200;

function errorResponse(code: string, message: string): PluginResponse<never> {
  return {
    success: false,
    error: { code, message: message.slice(0, HOST_ERROR_MAX_CHARS) },
  };
}

function isPluginResponse(value: unknown): value is PluginResponse<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { success?: unknown }).success === 'boolean'
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasData<T>(response: unknown): response is { data: T } {
  return (
    typeof response === 'object' && response !== null && 'data' in response
  );
}

class RuntimeHost {
  private plugins = new Map<string, RuntimePlugin>();
  private loadPromise: Promise<string[]> | null = null;

  async load(): Promise<string[]> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFrontendPlugins().catch((error) => {
      this.loadPromise = null;
      console.warn('Failed to load frontend plugins', error);
      return this.getLoadedPluginIds();
    });
    return this.loadPromise;
  }

  getLoadedPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  isLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  async handleRequest(
    frame: RuntimeRequestFrame
  ): Promise<{ requestId: string; result: PluginResponse<unknown> }> {
    return {
      requestId: frame.requestId,
      result: await this.invokeLocal(
        frame.pluginId,
        frame.operation,
        frame.params
      ),
    };
  }

  async invokeLocal(
    pluginId: string,
    operation: string,
    params?: unknown
  ): Promise<PluginResponse<unknown>> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return errorResponse(
        'HOST_PLUGIN_NOT_LOADED',
        `Frontend plugin ${pluginId} is not loaded`
      );
    }

    const handler = plugin[operation];
    if (typeof handler !== 'function') {
      return errorResponse(
        'HOST_OPERATION_NOT_FOUND',
        `Frontend plugin ${pluginId} does not implement ${operation}`
      );
    }

    try {
      const result = await handler.call(plugin, params ?? {});
      return isPluginResponse(result)
        ? result
        : errorResponse(
            'HOST_MALFORMED_RESULT',
            `Frontend plugin ${pluginId} returned a malformed result`
          );
    } catch (error) {
      return errorResponse('HOST_DISPATCH_ERROR', messageFromError(error));
    }
  }

  private async loadFrontendPlugins(): Promise<string[]> {
    const response = await apiClient.request('listPlugins', {});
    if (!hasData<ListPluginsData>(response)) {
      return this.getLoadedPluginIds();
    }
    const plugins = Object.entries(response.data.plugins).filter(
      ([, metadata]) => metadata.runtime === 'frontend'
    );

    await Promise.all(
      plugins.map(async ([pluginId]) => {
        if (this.plugins.has(pluginId)) return;
        try {
          const code = await apiClient.request('getPluginBundle', {
            params: { pluginId },
          });
          const url = URL.createObjectURL(
            new Blob([code], { type: 'text/javascript' })
          );
          try {
            const mod = (await import(/* @vite-ignore */ url)) as {
              default?: RuntimePlugin;
            };
            if (mod.default && typeof mod.default === 'object') {
              this.plugins.set(pluginId, mod.default);
            } else {
              console.warn(`Frontend plugin ${pluginId} has no default export`);
            }
          } finally {
            URL.revokeObjectURL(url);
          }
        } catch (error) {
          console.warn(`Failed to load frontend plugin ${pluginId}`, error);
        }
      })
    );

    return this.getLoadedPluginIds();
  }
}

export const runtimeHost = new RuntimeHost();
