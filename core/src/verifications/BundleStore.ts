// Content-addressed, profile-scoped compiler inputs. Bundles are deliberately
// not exposed through API responses: they may contain the complete source.
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { VerificationBundleData } from '@ignite/plugin-types/base/compiler';
import { FileSystem } from '../filesystem/FileSystem.js';

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

export interface VerificationBundle extends VerificationBundleData {
  schemaVersion: 1;
  artifactHash: string;
  compilerSummary: {
    pluginId: string;
    evmVersion?: string;
    optimizer: boolean;
    runs: number;
    viaIR: boolean;
  };
  // Bundles supplied by installed contract-type plugins have not been
  // independently reproduced. Phase F requires an explicit confirmation
  // before they are submitted to an explorer.
  unverifiedProvenance?: true;
}

export class BundleStore {
  private readonly baseDir?: string;
  private readonly fileSystem: Pick<
    FileSystem,
    'fileExists' | 'getProfilePath' | 'readJsonFile' | 'writeJsonFile'
  >;

  constructor(deps?: { baseDir?: string }) {
    const fileSystem = FileSystem.getInstance();
    this.baseDir = deps?.baseDir;
    this.fileSystem = fileSystem;
  }

  async write(profileId: string, bundle: VerificationBundle): Promise<string> {
    BundleStore.validate(bundle);
    const bundleHash = BundleStore.hash(bundle);
    const file = this.bundlePath(profileId, bundleHash);
    if (!(await this.fileSystem.fileExists(file))) {
      await this.fileSystem.writeJsonFile(file, bundle);
    }
    return bundleHash;
  }

  async read(
    profileId: string,
    bundleHash: string
  ): Promise<VerificationBundle | null> {
    const file = this.bundlePath(profileId, bundleHash);
    if (!(await this.fileSystem.fileExists(file))) return null;
    return this.fileSystem.readJsonFile<VerificationBundle>(file);
  }

  static validate(
    data: VerificationBundleData
  ): asserts data is VerificationBundleData {
    if (!isRecord(data))
      throw bundleError('BUNDLE_INVALID', 'Bundle must be an object');

    const input = data.standardJsonInput;
    if (!isRecord(input)) {
      throw bundleError(
        'BUNDLE_INVALID',
        'Standard JSON input must be an object'
      );
    }
    if (input.language !== 'Solidity') {
      throw bundleError(
        'BUNDLE_INVALID',
        'Standard JSON language must be Solidity'
      );
    }
    if (!isRecord(input.sources)) {
      throw bundleError(
        'BUNDLE_INVALID',
        'Standard JSON sources must be an object'
      );
    }
    for (const [sourcePath, source] of Object.entries(input.sources)) {
      if (!isRelativeSourcePath(sourcePath)) {
        throw bundleError(
          'BUNDLE_INVALID',
          `Invalid source path: ${sourcePath}`
        );
      }
      if (
        !isRecord(source) ||
        typeof source.content !== 'string' ||
        'urls' in source
      ) {
        throw bundleError(
          'BUNDLE_INVALID',
          `Source ${sourcePath} must contain literal content and no URLs`
        );
      }
    }
    if (!isRecord(input.settings)) {
      throw bundleError(
        'BUNDLE_INVALID',
        'Standard JSON settings must be an object'
      );
    }
    // Guess-args prefix-strips against creationCode: an empty or odd-length
    // value would turn the check into a no-op (fail open) or nibble-shift
    // the tail. Enforce well-formed non-empty hex at the source.
    const creationCode = (data as { creationCode?: unknown }).creationCode;
    if (
      typeof creationCode !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(creationCode)
    ) {
      throw bundleError(
        'BUNDLE_INVALID',
        'creationCode must be non-empty even-length 0x hex'
      );
    }

    let size: number;
    try {
      size = Buffer.byteLength(canonicalJson(input), 'utf8');
    } catch {
      throw bundleError(
        'BUNDLE_INVALID',
        'Standard JSON input is not serializable'
      );
    }
    if (size > MAX_BUNDLE_BYTES) {
      throw bundleError(
        'BUNDLE_TOO_LARGE',
        'Standard JSON input exceeds 10 MiB'
      );
    }
  }

  static hash(bundle: VerificationBundle): string {
    return createHash('sha256').update(canonicalJson(bundle)).digest('hex');
  }

  private bundlePath(profileId: string, bundleHash: string): string {
    return path.join(
      this.baseDir
        ? path.join(this.baseDir, 'profiles', profileId)
        : this.fileSystem.getProfilePath(profileId),
      'deployments',
      'bundles',
      `${bundleHash}.json`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRelativeSourcePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !value.split(/[\\/]+/).includes('..')
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function bundleError(
  code: 'BUNDLE_INVALID' | 'BUNDLE_TOO_LARGE',
  message: string
) {
  return Object.assign(new Error(message), { code });
}
