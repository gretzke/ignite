// Core type definitions for Ignite
// NOTE: ProfileConfig is defined in shared API as single source of truth
export type { ProfileConfig } from '@ignite/api';

export interface IgniteConfig {
  version: string;
  currentProfile: string; // Currently selected profile key (folder name)
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
