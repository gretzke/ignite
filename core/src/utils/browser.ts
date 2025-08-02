import { exec } from 'child_process';

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
