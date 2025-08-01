// Test setup and utilities for Ignite

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

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
