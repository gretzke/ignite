// Self-contained third-party compiler plugin for the isolated-build test.
// Implements the Ignite runner contract directly (operation = last argv,
// options via stdin to EOF, PluginResponse JSON on stdout).
const fs = require('fs');

const META = {
  id: 'git-fixture',
  type: 'compiler',
  name: 'Git Fixture Compiler',
  version: '0.0.1',
  baseImage: 'ignite/installed_git-fixture:0.0.1',
};

async function main() {
  const op = process.argv[process.argv.length - 1];
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  void input;
  let result;
  if (op === 'getInfo') {
    result = { success: true, data: META };
  } else if (op === 'detect') {
    result = { success: true, data: { detected: true } };
  } else if (op === 'compile' || op === 'install') {
    try {
      fs.writeFileSync('/workspace/.git-fixture-ran', new Date().toISOString());
      result = { success: true, data: {} };
    } catch (e) {
      result = { success: false, error: { code: 'FAIL', message: String(e) } };
    }
  } else {
    result = { success: true, data: {} };
  }
  process.stdout.write(JSON.stringify(result));
}
main();
