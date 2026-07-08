#!/usr/bin/env node
// Ignite third-party RPC-provider plugin for chainz.
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
// This plugin reads a user-supplied chainz configuration file (containing
// RPC URLs and API keys) from the encrypted vault and exposes those RPC
// endpoints to Ignite. The key itself never touches disk here — Ignite
// resolves it from the encrypted vault and passes it in on stdin as
// `options.config['chainz-config']`.

const fs = require('fs');

// Result framing sentinels (mirrors @ignite/plugin-types utils/protocol).
const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const PLUGIN_VERSION = '0.1.0';
const META = {
  id: 'chainz',
  type: 'rpc-provider',
  name: 'chainz',
  version: PLUGIN_VERSION,
  baseImage: `ignite/installed_chainz:${PLUGIN_VERSION}`,
  permissions: [],
  configFields: [
    {
      key: 'chainz-config',
      label: 'chainz config (paste ~/.chainz.json)',
      type: 'string',
      secret: true,
      description:
        'Contents of your ~/.chainz.json. It contains RPC keys and API keys, so it is stored in the encrypted vault.',
    },
  ],
};

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

function interpolateUrl(url, variables) {
  // Interpolate ${VAR} with values from variables.
  // If any ${...} has no matching variable, return null (skip this URL).
  if (!variables) return url;

  return url.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    if (varName in variables) {
      return variables[varName];
    }
    // Variable not found — skip this URL by returning null as a sentinel.
    return null;
  });
}

function getSupportedChains(options) {
  const configStr =
    options && options.config && typeof options.config['chainz-config'] === 'string'
      ? options.config['chainz-config'].trim()
      : '';

  if (!configStr) {
    return ok({ chains: [] });
  }

  let config;
  try {
    config = JSON.parse(configStr);
  } catch {
    // Malformed JSON — return empty chains, never an error.
    return ok({ chains: [] });
  }

  if (!Array.isArray(config.chains)) {
    return ok({ chains: [] });
  }

  const chains = [];
  for (const chainEntry of config.chains) {
    if (!chainEntry || typeof chainEntry.chain_id !== 'number') {
      continue;
    }
    const chainId = chainEntry.chain_id;
    if (!Number.isInteger(chainId) || chainId <= 0) {
      continue;
    }

    const chainName = chainEntry.name || `chain ${chainId}`;
    const rpcUrls = Array.isArray(chainEntry.rpc_urls) ? chainEntry.rpc_urls : [];
    const selectedRpc = chainEntry.selected_rpc;
    const variables = config.variables || {};

    // Collect all URLs (selected + remaining) with deduplication.
    const urlSet = new Set();
    const orderedUrls = [];

    // Process selected_rpc first, if it exists.
    if (selectedRpc && typeof selectedRpc === 'string') {
      const interpolated = interpolateUrl(selectedRpc, variables);
      if (interpolated !== null && interpolated.startsWith('https://')) {
        orderedUrls.push({
          url: interpolated,
          label: `${chainName} (selected)`,
          isSelected: true,
        });
        urlSet.add(interpolated);
      }
    }

    // Process remaining rpc_urls.
    for (const url of rpcUrls) {
      if (typeof url !== 'string') continue;
      const interpolated = interpolateUrl(url, variables);
      // Skip if interpolation failed (unmatched variable) or not https.
      if (interpolated === null || !interpolated.startsWith('https://')) {
        continue;
      }
      // Skip if already added (dedup).
      if (urlSet.has(interpolated)) {
        continue;
      }
      orderedUrls.push({
        url: interpolated,
        label: chainName,
        isSelected: false,
      });
      urlSet.add(interpolated);
    }

    // Emit chains in order: selected first, then remaining.
    for (const entry of orderedUrls) {
      chains.push({
        chainId,
        url: entry.url,
        label: entry.label,
      });
    }
  }

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
