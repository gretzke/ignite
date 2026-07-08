// Fixture plugin for the rpc-provider endpoint integration test
// (rpcProviderEndpoints.integration.test.ts). Implements the Ignite runner
// contract directly (operation = last argv, options via stdin to EOF,
// sentinel-framed PluginResponse JSON on stdout), mirroring
// fixtures/config-fixture/index.cjs — no shared-image/esbuild dependency
// needed.
//
// Declares a single secret config field (api-key). getSupportedChains only
// returns chains when core actually injected the granted secret, so the
// test can prove the grant gate end-to-end; the returned batch deliberately
// includes two invalid entries (bad url, non-positive chainId) that core's
// RpcProviderService validation must drop.
const fs = require('fs');

const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const META = {
  id: 'provider-fixture',
  type: 'rpc-provider',
  name: 'Provider Fixture',
  version: '0.0.1',
  baseImage: 'ignite/installed_provider-fixture:0.0.1',
  permissions: [],
  configFields: [
    { key: 'api-key', label: 'API Key', type: 'string', secret: true },
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
  } else if (op === 'getSupportedChains') {
    let options = {};
    try {
      options = input.trim() ? JSON.parse(input) : {};
    } catch (e) {
      result = {
        success: false,
        error: { code: 'BAD_INPUT', message: String(e) },
      };
    }
    if (!result) {
      const key =
        options.config && typeof options.config['api-key'] === 'string'
          ? options.config['api-key']
          : undefined;
      if (key) {
        result = {
          success: true,
          data: {
            chains: [
              // The only well-formed entry: proves the granted secret was
              // injected (url embeds it) and survives core validation.
              {
                chainId: 1,
                url: 'https://rpc.example.com/' + key,
                label: 'Fixture',
              },
              // Invalid url: core must drop it (nothing for chain 999).
              { chainId: 999, url: 'not-a-url' },
              // Non-positive chainId: fails the zod schema, dropped.
              { chainId: -5, url: 'https://x.example.com' },
            ],
          },
        };
      } else {
        // No injected secret (untrusted / not granted): no chains at all.
        result = { success: true, data: { chains: [] } };
      }
    }
  } else {
    result = { success: true, data: {} };
  }
  process.stdout.write(
    `${RESULT_BEGIN}${JSON.stringify(result)}${RESULT_END}\n`
  );
}
main();
