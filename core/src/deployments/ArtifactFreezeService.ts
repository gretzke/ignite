// Freeze compiler artifacts once at launch so validation and execution use
// identical ABI/creation-bytecode inputs.
import crypto from 'node:crypto';
import type {
  ArtifactData,
  ContractSource,
  FrozenInputs,
} from '@ignite/api';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { RepoService } from '../repos/RepoService.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { statFingerprint } from '../repos/fingerprint.js';
import { getCompilerArtifactData } from '../api/plugins/compiler/index.js';
import { getCompilerVerificationBundle } from '../api/plugins/compiler/index.js';
import { BundleStore, type VerificationBundle } from '../verifications/BundleStore.js';
import { validateUnlinkedBytecode } from './linking.js';
import { getLogger } from '../utils/logger.js';
import { IgniteError } from '../types/errors.js';

export interface ArtifactFreezeDeps {
  getArtifactData: (input: {
    contract: ContractSource;
    profileId: string;
  }) => Promise<ArtifactData>;
  getPluginConfig: PluginRegistryLoader['getPluginConfig'];
  repoDirty: (profileId: string, contract: ContractSource) => Promise<boolean>;
  getVerificationBundle: (input: {
    contract: ContractSource; profileId: string;
  }) => Promise<import('@ignite/plugin-types/base/compiler').VerificationBundleData>;
  bundleStore: Pick<BundleStore, 'write'>;
}

export class ArtifactFreezeService {
  private readonly deps: ArtifactFreezeDeps;

  constructor(deps?: Partial<ArtifactFreezeDeps>) {
    const registry = PluginRegistryLoader.getInstance();
    const repos = RepoService.getInstance();
    const repoRegistry = new ProfileRepoRegistry();
    this.deps = {
      getArtifactData:
        deps?.getArtifactData ??
        (async ({ contract, profileId }) =>
          getCompilerArtifactData(
            {
              executor: PluginExecutor.getInstance(),
              registryLoader: registry,
              repos,
            },
            { contract, profileId }
          )),
      getPluginConfig:
        deps?.getPluginConfig ?? registry.getPluginConfig.bind(registry),
      repoDirty:
        deps?.repoDirty ??
        (async (profileId, contract) => {
          if (contract.origin === 'contract-type') throw new IgniteError('contract-type sources are not supported here yet (contract-types plan phase 7)', 'CONTRACT_TYPE_UNSUPPORTED');
          const records = await repoRegistry.list(profileId);
          const record = [...records.local, ...records.cloned].find(
            (item) => item.pathOrUrl === contract.repoPathOrUrl
          );
          const framework = record?.frameworks?.find(
            (item) => item.id === contract.frameworkId
          );
          if (!framework?.watchPaths || !framework.fingerprint) return false;
          try {
            const workspace = await repos.resolveExistingWorkspacePath(
              contract.repoPathOrUrl,
              profileId
            );
            const sources = await statFingerprint(workspace, [
              ...framework.watchPaths.config,
              ...framework.watchPaths.sources,
            ]);
            const artifacts = await statFingerprint(
              workspace,
              framework.watchPaths.artifacts
            );
            return (
              sources !== framework.fingerprint.sources ||
              artifacts !== framework.fingerprint.artifacts
            );
          } catch {
            // Existing lifecycle behavior tolerates an unavailable workspace;
            // freezing will surface artifact retrieval errors separately.
            return false;
          }
        }),
      getVerificationBundle: deps?.getVerificationBundle ??
        (async ({ contract, profileId }) =>
          getCompilerVerificationBundle(
            { executor: PluginExecutor.getInstance(), registryLoader: registry, repos },
            { contract, profileId }
          )),
      bundleStore: deps?.bundleStore ?? new BundleStore(),
    };
  }

  async freezeInputs(
    profileId: string,
    contracts: ContractSource[]
  ): Promise<FrozenInputs> {
    const entries = await Promise.all(
      contracts.map(async (contract) => {
        if (contract.origin === 'contract-type') throw new IgniteError('contract-type sources are not supported here yet (contract-types plan phase 7)', 'CONTRACT_TYPE_UNSUPPORTED');
        const [artifact, config, repoDirty] = await Promise.all([
          this.deps.getArtifactData({
            contract,
            profileId,
          }),
          this.deps.getPluginConfig(contract.frameworkId),
          contract.pin ? Promise.resolve(false) : this.deps.repoDirty(profileId, contract),
        ]);
        const hasLinks = hasLinkReferences(artifact.creationCodeLinkReferences);
        try {
          if (hasLinks) validateUnlinkedBytecode(artifact.creationCode, artifact.creationCodeLinkReferences!);
          else if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(artifact.creationCode)) throw new Error('invalid');
        } catch (error) {
          throw Object.assign(
            new Error('Artifact creation bytecode is invalid'),
            {
              code: typeof error === 'object' && error !== null && 'code' in error ? (error as { code: string }).code : 'ARTIFACT_DATA_ERROR',
            }
          );
        }
        const settings = {
          solidityVersion: artifact.solidityVersion,
          optimizer: artifact.optimizer,
          optimizerRuns: artifact.optimizerRuns,
          evmVersion: artifact.evmVersion ?? null,
          viaIR: artifact.viaIR,
          bytecodeHash: artifact.bytecodeHash,
        };
        const creationBytecode = artifact.creationCode;
        const runtimeBytecode = artifact.deployedBytecode;
        const runtimeRefs = artifact.deployedBytecodeLinkReferences;
        const hasRuntime = runtimeBytecode !== undefined && runtimeBytecode !== '' && runtimeBytecode !== '0x';
        const hasRuntimeLinks = hasLinkReferences(runtimeRefs);
        let runtime: { code: string; refs?: import('@ignite/api').LinkReferencesWire } | undefined;
        if (hasRuntime) {
          try {
            // Same 1 MiB byte ceiling DeploymentTypeService enforces at use
            // time — freeze is the only other door into persisted state.
            if ((runtimeBytecode.length - 2) / 2 > 1024 * 1024) throw new Error('runtime bytecode exceeds 1 MiB');
            if (hasRuntimeLinks && runtimeRefs) validateUnlinkedBytecode(runtimeBytecode, runtimeRefs);
            else if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(runtimeBytecode)) throw new Error('invalid runtime bytecode');
            runtime = { code: runtimeBytecode, ...(hasRuntimeLinks && runtimeRefs ? { refs: runtimeRefs } : {}) };
          } catch (error) {
            getLogger().warn(`Runtime bytecode omitted for ${contract.id} (${contract.artifactPath}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return [
          contract.id,
          {
            abi: artifact.abi,
            creationBytecode,
            ...(hasLinks ? { creationCodeLinkReferences: artifact.creationCodeLinkReferences } : {}),
            ...(runtime ? { runtimeBytecode: runtime.code, ...(runtime.refs ? { runtimeBytecodeLinkReferences: runtime.refs } : {}) } : {}),
            compiler: {
              pluginId: contract.frameworkId,
              version: config.metadata.version,
              settingsHash: sha256(canonicalJson(settings)),
            },
            artifactHash: sha256(
              canonicalJson({
                abi: artifact.abi,
                creationCode: creationBytecode,
                ...(runtime ? { runtimeCode: runtime.code, ...(runtime.refs ? { runtimeCodeLinkReferences: runtime.refs } : {}) } : {}),
              })
            ),
            repoDirty,
          },
        ] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  // Capture is deliberately separate from freezeInputs(): source verification
  // availability is optional and must never turn into the global freeze error
  // that blocks argument, estimate, and balance validation.
  async captureBundles(
    frozen: FrozenInputs,
    contracts: ContractSource[],
    profileId: string
  ): Promise<Record<string, { bundleHash: string } | { error: string }>> {
    const entries = await Promise.all(contracts.map(async (contract) => {
      try {
        const input = frozen[contract.id];
        if (!input) throw new Error('Frozen input is missing');
        const data = await this.deps.getVerificationBundle({
          contract,
          profileId,
        });
        if (data.creationCode.toLowerCase() !== input.creationBytecode.toLowerCase()) {
          throw Object.assign(new Error('Verification bundle creation bytecode does not match frozen artifact'), { code: 'BUNDLE_COHERENCE_MISMATCH' });
        }
        const bundle: VerificationBundle = {
          ...data,
          schemaVersion: 1,
          artifactHash: input.artifactHash,
          compilerSummary: summaryFromStandardJson(
            input.compiler.pluginId,
            data.standardJsonInput
          ),
        };
        const bundleHash = await this.deps.bundleStore.write(profileId, bundle);
        input.bundleHash = bundleHash;
        return [contract.id, { bundleHash }] as const;
      } catch (error) {
        return [contract.id, { error: error instanceof Error ? error.message : String(error) }] as const;
      }
    }));
    return Object.fromEntries(entries);
  }
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasLinkReferences(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && Object.keys(value).length > 0
  );
}

// The bundle's own settings are the authoritative record of what solc saw —
// never fabricate summary fields (a conforming verifier may submit them).
export function summaryFromStandardJson(
  pluginId: string,
  standardJsonInput: unknown
): {
  pluginId: string;
  evmVersion?: string;
  optimizer: boolean;
  runs: number;
  viaIR: boolean;
} {
  const settings =
    standardJsonInput && typeof standardJsonInput === 'object'
      ? ((standardJsonInput as { settings?: unknown }).settings as
          | {
              optimizer?: { enabled?: boolean; runs?: number };
              evmVersion?: string;
              viaIR?: boolean;
            }
          | undefined)
      : undefined;
  return {
    pluginId,
    ...(typeof settings?.evmVersion === 'string'
      ? { evmVersion: settings.evmVersion }
      : {}),
    optimizer: settings?.optimizer?.enabled === true,
    runs:
      typeof settings?.optimizer?.runs === 'number'
        ? settings.optimizer.runs
        : 0,
    viaIR: settings?.viaIR === true,
  };
}
