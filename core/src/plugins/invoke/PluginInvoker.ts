// Runtime-blind plugin invocation. D2a routes everything to the container
// path; D2b can add a frontend runtime backend here without touching callers.
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../containers/PluginExecutor.js';
import { FrontendRuntimeBridge } from './FrontendRuntimeBridge.js';
import { ErrorCodes } from '../../types/errors.js';

export interface PluginInvokerDeps {
  registryLoader: Pick<PluginRegistryLoader, 'getPluginConfig'>;
  executeContainer: (
    pluginId: string,
    operation: string,
    options: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ) => Promise<PluginResponse<unknown>>;
  bridge: Pick<FrontendRuntimeBridge, 'request'>;
}

export class PluginInvoker {
  private static instance: PluginInvoker;
  private deps: PluginInvokerDeps;

  constructor(deps?: Partial<PluginInvokerDeps>) {
    this.deps = {
      registryLoader:
        deps?.registryLoader ?? PluginRegistryLoader.getInstance(),
      executeContainer:
        deps?.executeContainer ??
        ((pluginId, operation, options, opts) =>
          PluginExecutor.getInstance().execute(
            pluginId,
            operation,
            options,
            opts
          )),
      bridge: deps?.bridge ?? FrontendRuntimeBridge.getInstance(),
    };
  }

  static getInstance(): PluginInvoker {
    if (!PluginInvoker.instance) {
      PluginInvoker.instance = new PluginInvoker();
    }
    return PluginInvoker.instance;
  }

  async invoke(
    pluginId: string,
    operation: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ): Promise<PluginResponse<unknown>> {
    const config = await this.deps.registryLoader.getPluginConfig(pluginId);
    if (config.metadata.runtime === 'frontend') {
      if (config.origin !== 'builtin') {
        return {
          success: false,
          error: {
            code: ErrorCodes.PERMISSION_REQUIRED,
            message: 'Installed plugins cannot use the frontend runtime.',
          },
        };
      }
      const timeoutMs =
        operation === 'sendTransaction' || operation === 'connect'
          ? 120_000
          : operation === 'getAccounts'
            ? 15_000
            : 30_000;
      return this.deps.bridge.request(config.metadata.id, operation, params, {
        signal: opts?.signal,
        timeoutMs,
      });
    }
    return this.deps.executeContainer(pluginId, operation, params, opts);
  }
}
