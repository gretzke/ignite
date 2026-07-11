// Freeze compiler artifacts once at launch so validation and execution use
// identical ABI/creation-bytecode inputs.
import crypto from 'node:crypto';
import type {
  ArtifactData,
  ContractSource,
  FrozenInputs,
  Hex,
} from '@ignite/api';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { RepoService } from '../repos/RepoService.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { statFingerprint } from '../repos/fingerprint.js';
import { getCompilerArtifactData } from '../api/plugins/compiler/index.js';
import { getCompilerVerificationBundle } from '../api/plugins/compiler/index.js';
import { BundleStore, type VerificationBundle } from '../verifications/BundleStore.js';

export interface ArtifactFreezeDeps {
  getArtifactData: (input: {
    pluginId: string;
    pathOrUrl: string;
    artifactPath: string;
    profileId: string;
  }) => Promise<ArtifactData>;
  getPluginConfig: PluginRegistryLoader['getPluginConfig'];
  repoDirty: (profileId: string, contract: ContractSource) => Promise<boolean>;
  getVerificationBundle: (input: {
    pluginId: string; pathOrUrl: string; artifactPath: string; profileId: string;
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
        (async ({ pluginId, pathOrUrl, artifactPath, profileId }) =>
          getCompilerArtifactData(
            {
              executor: PluginExecutor.getInstance(),
              registryLoader: registry,
              repos,
            },
            { pluginId, pathOrUrl, artifactPath, profileId }
          )),
      getPluginConfig:
        deps?.getPluginConfig ?? registry.getPluginConfig.bind(registry),
      repoDirty:
        deps?.repoDirty ??
        (async (profileId, contract) => {
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
        (async ({ pluginId, pathOrUrl, artifactPath, profileId }) =>
          getCompilerVerificationBundle(
            { executor: PluginExecutor.getInstance(), registryLoader: registry, repos },
            { pluginId, pathOrUrl, artifactPath, profileId }
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
        const [artifact, config, repoDirty] = await Promise.all([
          this.deps.getArtifactData({
            pluginId: contract.frameworkId,
            pathOrUrl: contract.repoPathOrUrl,
            artifactPath: contract.artifactPath,
            profileId,
          }),
          this.deps.getPluginConfig(contract.frameworkId),
          this.deps.repoDirty(profileId, contract),
        ]);
        if (hasLinkReferences(artifact.creationCodeLinkReferences)) {
          throw Object.assign(
            new Error(
              `Contract ${contract.contractName} requires library linking, which is not supported yet`
            ),
            { code: 'LIBRARY_LINKING_UNSUPPORTED' }
          );
        }
        if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(artifact.creationCode)) {
          throw Object.assign(
            new Error('Artifact creation bytecode is invalid'),
            {
              code: 'ARTIFACT_DATA_ERROR',
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
        const creationBytecode = artifact.creationCode as Hex;
        return [
          contract.id,
          {
            abi: artifact.abi,
            creationBytecode,
            compiler: {
              pluginId: contract.frameworkId,
              version: config.metadata.version,
              settingsHash: sha256(canonicalJson(settings)),
            },
            artifactHash: sha256(
              canonicalJson({
                abi: artifact.abi,
                creationCode: creationBytecode,
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
          pluginId: contract.frameworkId,
          pathOrUrl: contract.repoPathOrUrl,
          artifactPath: contract.artifactPath,
          profileId,
        });
        if (data.creationCode.toLowerCase() !== input.creationBytecode.toLowerCase()) {
          throw Object.assign(new Error('Verification bundle creation bytecode does not match frozen artifact'), { code: 'BUNDLE_COHERENCE_MISMATCH' });
        }
        const bundle: VerificationBundle = {
          ...data,
          schemaVersion: 1,
          artifactHash: input.artifactHash,
          compilerSummary: {
            pluginId: input.compiler.pluginId,
            optimizer: false,
            runs: 0,
            viaIR: false,
          },
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
