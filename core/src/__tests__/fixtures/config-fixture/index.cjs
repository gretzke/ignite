// Fixture plugin for the config/vault/secrets injection integration test
// (pluginConfigInjection.integration.test.ts). Implements the Ignite runner
// contract directly (operation = last argv, options via stdin to EOF,
// sentinel-framed PluginResponse JSON on stdout), mirroring
// fixtures/git-plugin/index.cjs — no shared-image/esbuild dependency needed.
//
// Declares one secret field, one perChain+secret field, and one plain field,
// and echoes back exactly the `config` object core injected so the test can
// assert precisely what was (and wasn't) resolved for a given trust grant.
const fs = require('fs');

const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const META = {
  id: 'config-fixture',
  type: 'compiler',
  name: 'Config Fixture',
  version: '0.0.1',
  baseImage: 'ignite/installed_config-fixture:0.0.1',
  configFields: [
    { key: 'endpoint', label: 'Endpoint', type: 'string' },
    { key: 'api-key', label: 'API Key', type: 'string', secret: true },
    {
      key: 'rpc-url',
      label: 'RPC URL',
      type: 'string',
      secret: true,
      perChain: true,
    },
  ],
};

async function main() {
  const op = process.argv[process.argv.length - 1];
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  let result;
  if (op === 'getInfo') {
    result = { success: true, data: META };
  } else if (op === 'detect') {
    // Never claim detection for a real repo: this fixture exists only to
    // exercise config/vault injection via echoConfig. Unlike compile/install
    // fixtures used solely inside a throwaway IGNITE_HOME (git-fixture,
    // stub-compiler), this one also gets installed into a real dev
    // environment for the manual UI drive — detected:true would make every
    // repo in the profile "detect" this compiler and trigger its
    // getWatchPaths (whose generic fallback below is not schema-shaped for
    // that path), corrupting real repo listings.
    result = { success: true, data: { detected: false } };
  } else if (op === 'echoConfig') {
    let options = {};
    try {
      options = input.trim() ? JSON.parse(input) : {};
    } catch (e) {
      result = { success: false, error: { code: 'BAD_INPUT', message: String(e) } };
    }
    if (!result) {
      result = { success: true, data: { received: options.config ?? null } };
    }
  } else if (op === 'getWatchPaths') {
    // Schema-shaped empty result (defensive: detect:false means core's
    // framework-detection sweep never actually calls this, but a
    // directly-invoked call must still satisfy WatchPathsResult).
    result = {
      success: true,
      data: { config: [], sources: [], artifacts: [] },
    };
  } else {
    result = { success: true, data: {} };
  }
  process.stdout.write(
    `${RESULT_BEGIN}${JSON.stringify(result)}${RESULT_END}\n`
  );
}
main();
