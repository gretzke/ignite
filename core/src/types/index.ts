// Core type definitions for Ignite

export interface ProfileConfig {
  name: string;
  created: string; // ISO timestamp
  lastAccessed: string; // ISO timestamp
  vault?: {
    encrypted: string; // Encrypted JSON containing keys, RPC endpoints, etc.
    keyDerivation: {
      algorithm: string; // e.g., 'PBKDF2'
      iterations: number;
      salt: string;
    };
  };
}

export interface PluginTrust {
  trust: 'native' | 'trusted' | 'untrusted';
  timestamp: string; // ISO timestamp when decision was made
  permissions: {
    canReadFiles: boolean;
    canWriteFiles: boolean;
    canExecute: boolean;
    canNetwork: boolean;
    canAccessBrowserAPI: boolean;
  };
}

export interface TrustDatabase {
  [pluginId: string]: PluginTrust;
}

export interface PluginRegistryEntry {
  name: string;
  version: string;
  dockerImage: string;
  type: 'compiler' | 'signer' | 'rpc' | 'explorer';
  installed: string; // ISO timestamp
  lastUsed?: string; // ISO timestamp
}

export interface PluginRegistry {
  plugins: {
    [pluginId: string]: PluginRegistryEntry;
  };
}

export interface IgniteConfig {
  version: string;
  currentProfile: string; // Profile name
  lastStartup: string; // ISO timestamp
}

// Repository volume management types
export interface RepoVolumeInfo {
  volumeName: string;
  type: 'local' | 'cloned';
  hostPath?: string; // Only for local repos // TODO: /workspace for cloned repos later on, do not make this optional in the future
  created: string; // ISO timestamp
}

export interface LocalRepoOptions {
  hostPath: string;
  name: string;
}

export interface ClonedRepoOptions {
  gitUrl: string;
  name?: string; // Optional custom name
}
