import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { gunzipSync } from 'zlib';
import { getLogger } from '../utils/logger.js';

export class AssetManager {
  private static instance: AssetManager;
  private readonly isPkgBundled: boolean;
  private readonly basePath: string;

  private constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pkg property not in Node.js types
    this.isPkgBundled = typeof (process as any).pkg !== 'undefined';

    if (this.isPkgBundled) {
      // In pkg bundled mode, assets are in snapshot filesystem under ignite
      // Note: The parent directory where the project was cloned to must be named ignite when building the pkg
      this.basePath = '/snapshot/ignite';
    } else {
      // In development, assets are relative to project root
      if (typeof __dirname !== 'undefined') {
        this.basePath = resolve(__dirname, '../../..');
      } else {
        // When running via tsx in `core`, cwd is .../ignite/core → project root is one level up
        this.basePath = resolve(process.cwd(), '..');
      }
    }

    getLogger().info(
      `📦 AssetManager initialized - Mode: ${this.isPkgBundled ? 'pkg bundled' : 'development'}, Base: ${this.basePath}`
    );
  }

  static getInstance(): AssetManager {
    if (!AssetManager.instance) {
      AssetManager.instance = new AssetManager();
    }
    return AssetManager.instance;
  }

  // Check if an asset exists
  exists(assetPath: string): boolean {
    const fullPath = this.resolveAssetPath(assetPath);

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
      return existsSync(fullPath) || existsSync(`${fullPath}.gz`);
    } catch {
      return false;
    }
  }

  // Get an asset as a Buffer, automatically handling gzip decompression
  getAsset(assetPath: string): Buffer {
    const fullPath = this.resolveAssetPath(assetPath);

    getLogger().info(
      `🔍 AssetManager: Trying to load asset: ${assetPath} -> ${fullPath}`
    );

    try {
      // If the request already includes .gz extension, decompress it directly
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
      if (assetPath.endsWith('.gz') && existsSync(fullPath)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
        const compressed = readFileSync(fullPath);
        return gunzipSync(compressed);
      }

      // Try gzipped version first (for better performance)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
      if (existsSync(`${fullPath}.gz`)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
        const compressed = readFileSync(`${fullPath}.gz`);
        return gunzipSync(compressed);
      }

      // Fall back to uncompressed (for files like index.html)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
      if (existsSync(fullPath)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path traversal protection in resolveAssetPath
        return readFileSync(fullPath);
      }

      getLogger().error(
        `❌ Asset not found: ${assetPath} (tried ${fullPath} and ${fullPath}.gz)`
      );
      throw new Error(`Asset not found: ${assetPath}`);
    } catch (error) {
      getLogger().error(`Failed to load asset ${assetPath}:`, error);
      throw error;
    }
  }

  // Get an asset as a string (UTF-8)
  getAssetText(assetPath: string): string {
    return this.getAsset(assetPath).toString('utf8');
  }

  // Get the MIME type for a file extension
  getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();

    const mimeTypes: Record<string, string> = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      eot: 'application/vnd.ms-fontobject',
    };

    return mimeTypes[ext || ''] || 'application/octet-stream';
  }

  // Resolve an asset path to the full filesystem path and validate it's within basePath
  private resolveAssetPath(assetPath: string): string {
    // Remove leading slash if present
    const cleanPath = assetPath.startsWith('/')
      ? assetPath.slice(1)
      : assetPath;

    // Resolve the full path
    const fullPath = resolve(this.basePath, cleanPath);

    // Security check: ensure the resolved path is still within basePath
    if (!fullPath.startsWith(this.basePath)) {
      throw new Error(`Path traversal attempt detected: ${assetPath}`);
    }

    return fullPath;
  }
}
