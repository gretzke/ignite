import { exec } from 'child_process';
import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import Docker from 'dockerode';

// Cross-platform browser opening function
export function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    // Linux and other Unix-like systems
    command = `xdg-open "${url}"`;
  }

  // eslint-disable-next-line security/detect-child-process -- Safe: used only for opening browser
  exec(command);
}

// Get version from package.json
export function getVersion(): string {
  const packagePath = path.join(__dirname, '..', '..', 'package.json');
  const packageContent = readFileSync(packagePath, 'utf-8');
  const pkg = JSON.parse(packageContent);
  return pkg.version;
}

// Check if a directory is a git repository
export function isGitRepository(dirPath: string): boolean {
  try {
    const gitPath = path.join(dirPath, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return existsSync(gitPath) && statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

// Check if Docker is available and running
export async function checkDockerAvailability(): Promise<void> {
  const docker = new Docker();

  try {
    process.stdout.write('🐳 Checking Docker availability...\n');

    // Try to ping Docker daemon
    await docker.ping();

    process.stdout.write('✅ Docker is available and running\n');
  } catch (error) {
    const errorMessage = `
🚨 Docker Error: Docker is not available or not running!

Please ensure Docker is installed and running:
  • Start Docker Desktop (if using macOS/Windows)
  • Or start Docker daemon (if using Linux)
  • Run 'docker ps' to verify Docker is working

Error details: ${error instanceof Error ? error.message : String(error)}
    `.trim();

    // Write error to stderr for better visibility
    process.stderr.write(errorMessage + '\n');
    throw new Error(
      'Docker is not available. Please start Docker and try again.'
    );
  }
}
