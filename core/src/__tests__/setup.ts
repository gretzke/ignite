// Test setup and utilities for Ignite

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { PluginManager } from '../filesystem/PluginManager.js';

// Reset every filesystem-rooted singleton so the NEXT getInstance() calls
// build fresh instances against a new test home dir. Dependents
// (ProfileManager/PluginManager cache a FileSystem reference) must be
// dropped whenever FileSystem is. Call this in beforeEach BEFORE
// FileSystem.getInstance(testDir) — otherwise every test after the first
// silently operates on the previous test's (already deleted) temp dir.
export function resetFilesystemSingletons(): void {
  PluginManager.resetInstance();
  ProfileManager.resetInstance();
  FileSystem.resetInstance();
}

// Create a temporary directory for testing
export async function createTestDirectory(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-test-'));
  return tempDir;
}

// Clean up temporary directory
export async function cleanupTestDirectory(testDir?: string): Promise<void> {
  if (!testDir) {
    return; // Nothing to clean up
  }

  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors - directory might not exist or already be cleaned up
    console.warn(`Failed to cleanup test directory ${testDir}:`, error);
  }
}

// Mock logger for testing (no console output)
export const mockLogger = {
  info: () => {}, // No-op functions for clean test output
  warn: () => {},
  error: () => {},
  debug: () => {},
};
