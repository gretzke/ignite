#!/usr/bin/env node
// Ignite third-party RPC-provider plugin for Infura.
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
// maps a user-supplied Infura API key onto Infura's per-chain URL scheme. The
// key itself never touches disk here — Ignite resolves it from the encrypted
// vault and passes it in on stdin as `options.config['api-key']`.

const fs = require('fs');

// Result framing sentinels (mirrors @ignite/plugin-types utils/protocol).
const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const PLUGIN_VERSION = '0.1.0';
const META = {
  id: 'infura',
  type: 'rpc-provider',
  name: 'Infura',
  version: PLUGIN_VERSION,
  baseImage: `ignite/installed_infura:${PLUGIN_VERSION}`,
  permissions: [],
  configFields: [
    {
      key: 'api-key',
      label: 'API Key',
      type: 'string',
      secret: true,
      required: true,
      description:
        'Your Infura project API key. Stored in the encrypted vault; ' +
        'endpoints appear for every chain Infura supports.',
    },
  ],
};

// subdomain -> { chainId, name } used to build both the URL and the label.
const NETWORKS = [
  { subdomain: 'mainnet', chainId: 1, name: 'Mainnet' },
  { subdomain: 'sepolia', chainId: 11155111, name: 'Sepolia' },
  { subdomain: 'holesky', chainId: 17000, name: 'Holesky' },
  { subdomain: 'optimism-mainnet', chainId: 10, name: 'Optimism' },
  {
    subdomain: 'optimism-sepolia',
    chainId: 11155420,
    name: 'Optimism Sepolia',
  },
  { subdomain: 'arbitrum-mainnet', chainId: 42161, name: 'Arbitrum' },
  {
    subdomain: 'arbitrum-sepolia',
    chainId: 421614,
    name: 'Arbitrum Sepolia',
  },
  { subdomain: 'polygon-mainnet', chainId: 137, name: 'Polygon' },
  { subdomain: 'polygon-amoy', chainId: 80002, name: 'Polygon Amoy' },
  { subdomain: 'base-mainnet', chainId: 8453, name: 'Base' },
  { subdomain: 'base-sepolia', chainId: 84532, name: 'Base Sepolia' },
  { subdomain: 'linea-mainnet', chainId: 59144, name: 'Linea' },
  { subdomain: 'avalanche-mainnet', chainId: 43114, name: 'Avalanche' },
  { subdomain: 'bsc-mainnet', chainId: 56, name: 'BSC' },
  { subdomain: 'scroll-mainnet', chainId: 534352, name: 'Scroll' },
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
    url: `https://${subdomain}.infura.io/v3/${apiKey}`,
    label: `Infura ${name}`,
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
