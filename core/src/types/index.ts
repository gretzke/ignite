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

export interface IgniteConfig {
  version: string;
  currentProfile: string; // Profile name
  lastStartup: string; // ISO timestamp
}

export interface LocalRepoOptions {
  hostPath: string;
  name: string;
  persistent?: boolean;
}

export interface ClonedRepoOptions {
  gitUrl: string;
  name?: string; // Optional custom name
}
