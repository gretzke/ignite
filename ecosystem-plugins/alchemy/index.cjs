#!/usr/bin/env node
// Ignite third-party RPC-provider plugin for Alchemy.
//
// Protocol (see Ignite's pluginTransport / plugin-runner / finalizeImage,
// and ../ignite-waffle-plugin/index.cjs for a fully worked example):
//   - The operation name is the last argv element.
//   - Options arrive as a JSON object on stdin (read to EOF).
//   - The PluginResponse JSON is written to stdout framed by sentinels:
//       <<<IGNITE_RESULT_BEGIN>>>{...}<<<IGNITE_RESULT_END>>>
//     Framing is mandatory — there is no bare-JSON fallback.
//   - Everything else on stdout is streamed into user-visible job logs
//     (the sentinel block is filtered out).
//
// This plugin has no filesystem/network side effects of its own: it just
// maps a user-supplied Alchemy API key onto Alchemy's per-chain URL scheme.
// The key itself never touches disk here — Ignite resolves it from the
// encrypted vault and passes it in on stdin as `options.config['api-key']`.

const fs = require('fs');

// Result framing sentinels (mirrors @ignite/plugin-types utils/protocol).
const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const PLUGIN_VERSION = '0.1.0';
const META = {
  id: 'alchemy',
  type: 'rpc-provider',
  name: 'Alchemy',
  version: PLUGIN_VERSION,
  baseImage: `ignite/installed_alchemy:${PLUGIN_VERSION}`,
  permissions: [],
  configFields: [
    {
      key: 'api-key',
      label: 'API Key',
      type: 'string',
      secret: true,
      required: true,
      description:
        'Your Alchemy project API key. Stored in the encrypted vault; ' +
        'endpoints appear for every chain Alchemy supports.',
    },
  ],
};

// subdomain -> { chainId, name } used to build both the URL and the label.
const NETWORKS = [
  { subdomain: 'eth-mainnet', chainId: 1, name: 'Ethereum' },
  { subdomain: 'eth-sepolia', chainId: 11155111, name: 'Ethereum Sepolia' },
  { subdomain: 'opt-mainnet', chainId: 10, name: 'Optimism' },
  { subdomain: 'opt-sepolia', chainId: 11155420, name: 'Optimism Sepolia' },
  { subdomain: 'arb-mainnet', chainId: 42161, name: 'Arbitrum' },
  { subdomain: 'arb-sepolia', chainId: 421614, name: 'Arbitrum Sepolia' },
  { subdomain: 'polygon-mainnet', chainId: 137, name: 'Polygon' },
  { subdomain: 'polygon-amoy', chainId: 80002, name: 'Polygon Amoy' },
  { subdomain: 'base-mainnet', chainId: 8453, name: 'Base' },
  { subdomain: 'base-sepolia', chainId: 84532, name: 'Base Sepolia' },
  { subdomain: 'zksync-mainnet', chainId: 324, name: 'zkSync' },
  { subdomain: 'worldchain-mainnet', chainId: 480, name: 'World Chain' },
  { subdomain: 'unichain-mainnet', chainId: 130, name: 'Unichain' },
  {
    subdomain: 'unichain-sepolia',
    chainId: 1301,
    name: 'Unichain Sepolia',
  },
];

function ok(data) {
  return { success: true, data };
}

function fail(code, message, details) {
  return {
    success: false,
    error: details ? { code, message, details } : { code, message },
  };
}

function getInfo() {
  return ok(META);
}

function getSupportedChains(options) {
  const apiKey =
    options && options.config && typeof options.config['api-key'] === 'string'
      ? options.config['api-key'].trim()
      : '';
  if (!apiKey) return ok({ chains: [] });

  const chains = NETWORKS.map(({ subdomain, chainId, name }) => ({
    chainId,
    url: `https://${subdomain}.g.alchemy.com/v2/${apiKey}`,
    label: `Alchemy ${name}`,
  }));
  return ok({ chains });
}

// --- CLI runner ---

function readOptions() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

const OPERATIONS = {
  getInfo,
  getSupportedChains,
};

async function main() {
  const op = process.argv[process.argv.length - 1];
  const handler = OPERATIONS[op];
  let response;
  if (!handler) {
    response = fail(
      'OPERATION_NOT_IMPLEMENTED',
      `Unknown operation: ${op}`
    );
  } else {
    const options = readOptions();
    try {
      response = await handler(options);
    } catch (error) {
      response = fail(
        'PLUGIN_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  process.stdout.write(
    `\n${RESULT_BEGIN}${JSON.stringify(response)}${RESULT_END}\n`
  );
}

main();
