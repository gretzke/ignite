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
import { validateUnlinkedBytecode } from './linking.js';

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
        return [
          contract.id,
          {
            abi: artifact.abi,
            creationBytecode,
            ...(hasLinks ? { creationCodeLinkReferences: artifact.creationCodeLinkReferences } : {}),
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
