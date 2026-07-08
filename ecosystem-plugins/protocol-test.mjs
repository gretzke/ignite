#!/usr/bin/env node
// Standalone protocol conformance test for Ignite ecosystem plugins.
//
// No test framework: these plugins are dependency-free CLI programs (see
// ../ignite-waffle-plugin/index.cjs for the protocol they implement), so a
// plain node script keeps the test suite dependency-free too. Run with:
//
//   node ecosystem-plugins/protocol-test.mjs
//
// Generic by design: add a plugin by appending to PLUGINS below (Task 5
// appends "chainz" the same way).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

const PLUGINS = [
  {
    dir: 'infura',
    id: 'infura',
    name: 'Infura',
    configFieldKey: 'api-key',
    // Strongest available check: every generated URL must actually embed
    // the configured API key (TESTKEY), not merely look like an https URL.
    assertUrls: (chains) => chains.every((c) => c.url.includes('TESTKEY')),
  },
  {
    dir: 'alchemy',
    id: 'alchemy',
    name: 'Alchemy',
    configFieldKey: 'api-key',
    assertUrls: (chains) => chains.every((c) => c.url.includes('TESTKEY')),
  },
  {
    dir: 'chainz',
    id: 'chainz',
    name: 'chainz',
    configFieldKey: 'chainz-config',
    // chainz URLs are user-supplied and don't all carry a key (e.g. a bare
    // public RPC URL) — the strongest available check is that the
    // interpolated *selected* URL contains the configured variable value.
    assertUrls: (chains) => {
      const selected = chains.find((c) => c.label.includes('(selected)'));
      return Boolean(selected) && selected.url.includes('KEY123');
    },
  },
];

let failures = 0;
let passes = 0;

function pass(message) {
  passes++;
  console.log(`PASS: ${message}`);
}

function fail(message, details) {
  failures++;
  console.error(`FAIL: ${message}`);
  if (details !== undefined) {
    console.error(
      typeof details === 'string' ? details : JSON.stringify(details, null, 2)
    );
  }
}

function assert(condition, message, details) {
  if (condition) {
    pass(message);
  } else {
    fail(message, details);
  }
}

// Runs `node <plugin>/index.cjs <op>` with `options` JSON on stdin, and
// parses the sentinel-framed PluginResponse from stdout.
function runOp(pluginDir, op, options) {
  const entry = path.join(__dirname, pluginDir, 'index.cjs');
  const input = JSON.stringify(options ?? {});
  const result = spawnSync(process.execPath, [entry, op], {
    input,
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(
      `failed to spawn plugin ${pluginDir} for op ${op}: ${result.error}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `plugin ${pluginDir} op ${op} exited with status ${result.status}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  const stdout = result.stdout;
  const beginIdx = stdout.indexOf(RESULT_BEGIN);
  const endIdx = stdout.indexOf(RESULT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `plugin ${pluginDir} op ${op} did not emit a sentinel-framed result.\n` +
        `stdout:\n${stdout}`
    );
  }
  const jsonText = stdout.slice(beginIdx + RESULT_BEGIN.length, endIdx);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `plugin ${pluginDir} op ${op} emitted unparseable JSON: ${jsonText}\n` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }
}

for (const plugin of PLUGINS) {
  console.log(`\n== ${plugin.name} (${plugin.dir}) ==`);

  // --- getInfo shape ---
  const infoResponse = runOp(plugin.dir, 'getInfo', {});
  assert(
    infoResponse.success === true,
    `${plugin.name}: getInfo returns success:true`,
    infoResponse
  );
  const info = infoResponse.data || {};
  assert(
    info.id === plugin.id,
    `${plugin.name}: getInfo id === '${plugin.id}'`,
    info
  );
  assert(
    info.type === 'rpc-provider',
    `${plugin.name}: getInfo type === 'rpc-provider'`,
    info
  );
  assert(
    Array.isArray(info.configFields) && info.configFields.length >= 1,
    `${plugin.name}: getInfo has at least one configField`,
    info
  );
  const apiKeyField = (info.configFields || [])[0];
  assert(
    apiKeyField && apiKeyField.secret === true,
    `${plugin.name}: getInfo configFields[0].secret === true`,
    apiKeyField
  );
  assert(
    apiKeyField && apiKeyField.key === plugin.configFieldKey,
    `${plugin.name}: getInfo configFields[0].key === '${plugin.configFieldKey}'`,
    apiKeyField
  );

  // --- getSupportedChains without config ---
  const emptyResponse = runOp(plugin.dir, 'getSupportedChains', {});
  assert(
    emptyResponse.success === true &&
      Array.isArray(emptyResponse.data?.chains) &&
      emptyResponse.data.chains.length === 0,
    `${plugin.name}: getSupportedChains with no config returns empty chains`,
    emptyResponse
  );

  const emptyKeyResponse = runOp(plugin.dir, 'getSupportedChains', {
    config: { [plugin.configFieldKey]: '   ' },
  });
  assert(
    emptyKeyResponse.success === true &&
      Array.isArray(emptyKeyResponse.data?.chains) &&
      emptyKeyResponse.data.chains.length === 0,
    `${plugin.name}: getSupportedChains with blank ${plugin.configFieldKey} returns empty chains`,
    emptyKeyResponse
  );

  // --- getSupportedChains with config ---
  // Use appropriate test config for the plugin type
  let testConfig;
  if (plugin.id === 'chainz') {
    testConfig = {
      [plugin.configFieldKey]: JSON.stringify({
        chains: [
          {
            name: 'Test',
            chain_id: 1,
            rpc_urls: ['https://test.example.com/${TEST_KEY}'],
            selected_rpc: 'https://test.example.com/${TEST_KEY}',
          },
        ],
        variables: { TEST_KEY: 'KEY123' },
      }),
    };
  } else {
    testConfig = { [plugin.configFieldKey]: 'TESTKEY' };
  }

  const chainsResponse = runOp(plugin.dir, 'getSupportedChains', {
    config: testConfig,
  });
  assert(
    chainsResponse.success === true,
    `${plugin.name}: getSupportedChains with ${plugin.configFieldKey} returns success:true`,
    chainsResponse
  );
  const chains = chainsResponse.data?.chains || [];
  assert(
    chains.length > 0,
    `${plugin.name}: getSupportedChains with ${plugin.configFieldKey} returns a non-empty chain list`,
    chains
  );

  const badUrl = chains.find(
    (c) => !c.url.startsWith('https://')
  );
  assert(
    !badUrl,
    `${plugin.name}: every chain URL starts with https://`,
    badUrl
  );

  assert(
    typeof plugin.assertUrls === 'function' && plugin.assertUrls(chains),
    `${plugin.name}: chain URLs satisfy the plugin-specific key-containment check`,
    chains
  );

  const chainIds = chains.map((c) => c.chainId);
  const allPositiveInts = chainIds.every(
    (id) => Number.isInteger(id) && id > 0
  );
  assert(
    allPositiveInts,
    `${plugin.name}: every chainId is a positive integer`,
    chainIds
  );
  const uniqueChainIds = new Set(chainIds);
  assert(
    uniqueChainIds.size === chainIds.length,
    `${plugin.name}: chainIds are unique`,
    chainIds
  );

  const missingLabel = chains.find(
    (c) => typeof c.label !== 'string' || c.label.trim() === ''
  );
  assert(
    !missingLabel,
    `${plugin.name}: every chain entry has a non-empty label`,
    missingLabel
  );

  // --- unknown operation ---
  const unknownResponse = runOp(plugin.dir, 'thisOperationDoesNotExist', {});
  assert(
    unknownResponse.success === false &&
      typeof unknownResponse.error?.code === 'string',
    `${plugin.name}: unknown operation returns a success:false error envelope`,
    unknownResponse
  );

  // --- chainz-specific tests ---
  if (plugin.id === 'chainz') {
    const chainzConfig = JSON.stringify({
      chains: [
        {
          name: 'Sepolia',
          chain_id: 11155111,
          rpc_urls: [
            'https://rpc.sepolia.org',
            'https://sepolia.infura.io/v3/${INFURA_API_KEY}',
            'https://rpc.sepolia.org', // duplicate
            'ws://bad.example', // non-https
            'https://x.example/${MISSING_VAR}', // unmatched variable
          ],
          selected_rpc: 'https://sepolia.infura.io/v3/${INFURA_API_KEY}',
        },
      ],
      variables: {
        INFURA_API_KEY: 'KEY123',
      },
    });

    const chainzResponse = runOp(plugin.dir, 'getSupportedChains', {
      config: { 'chainz-config': chainzConfig },
    });
    assert(
      chainzResponse.success === true,
      'chainz: getSupportedChains with config returns success:true',
      chainzResponse
    );

    const chainzChains = chainzResponse.data?.chains || [];
    assert(
      chainzChains.length > 0,
      'chainz: getSupportedChains returns non-empty chain list',
      chainzChains
    );

    // Selected RPC should be first with "(selected)" label
    const selectedChain = chainzChains[0];
    assert(
      selectedChain &&
        selectedChain.label === 'Sepolia (selected)' &&
        selectedChain.url.includes('KEY123'),
      'chainz: selected RPC appears first with "(selected)" label and interpolated key',
      selectedChain
    );

    // rpc.sepolia.org should appear exactly once (deduped)
    const sepoliaUrlCount = chainzChains.filter((c) =>
      c.url.includes('rpc.sepolia.org')
    ).length;
    assert(
      sepoliaUrlCount === 1,
      'chainz: rpc.sepolia.org appears exactly once (deduped)',
      { sepoliaUrlCount, chains: chainzChains }
    );

    // No ws:// URLs
    const wsUrl = chainzChains.find((c) => c.url.startsWith('ws://'));
    assert(
      !wsUrl,
      'chainz: no websocket URLs are included',
      wsUrl
    );

    // No URLs with unmatched variables. Checking for a literal '${' is not
    // enough — the historical bug coerced a null replacer return value into
    // the *string* "null" via String.prototype.replace, silently emitting
    // "https://x.example/null" instead of skipping the URL. Assert the
    // unmatched-variable URL is absent entirely: neither its synthetic host
    // (x.example) nor a null-coercion artifact may appear in any URL.
    const unmatchedHostUrl = chainzChains.find((c) => c.url.includes('x.example'));
    assert(
      !unmatchedHostUrl,
      'chainz: URLs with unmatched variables are skipped entirely (x.example host absent)',
      unmatchedHostUrl
    );
    const nullCoercedUrl = chainzChains.find((c) => c.url.includes('null'));
    assert(
      !nullCoercedUrl,
      'chainz: no URL contains a null-coerced placeholder',
      nullCoercedUrl
    );

    // Exact entry count for the Sepolia chain: selected (interpolated KEY123)
    // + rpc.sepolia.org, with the Infura-key duplicate, literal duplicate,
    // ws:// URL, and unmatched-variable URL all skipped. A skipped-URL
    // regression (e.g. the null-coercion bug re-emitting the MISSING_VAR
    // URL) changes this count.
    assert(
      chainzChains.length === 2,
      'chainz: exactly 2 chain entries survive dedup/https/variable filtering for Sepolia',
      chainzChains
    );

    // All chainIds should be 11155111
    const allSepoliaId = chainzChains.every((c) => c.chainId === 11155111);
    assert(
      allSepoliaId,
      'chainz: all chain entries have chainId 11155111',
      chainzChains
    );

    // Test malformed JSON
    const badJsonResponse = runOp(plugin.dir, 'getSupportedChains', {
      config: { 'chainz-config': '{invalid json}' },
    });
    assert(
      badJsonResponse.success === true &&
        Array.isArray(badJsonResponse.data?.chains) &&
        badJsonResponse.data.chains.length === 0,
      'chainz: malformed JSON config returns empty chains (never errors)',
      badJsonResponse
    );

    // Test missing config
    const noConfigResponse = runOp(plugin.dir, 'getSupportedChains', {
      config: {},
    });
    assert(
      noConfigResponse.success === true &&
        Array.isArray(noConfigResponse.data?.chains) &&
        noConfigResponse.data.chains.length === 0,
      'chainz: missing chainz-config returns empty chains',
      noConfigResponse
    );

    // Verify getInfo configField is secret
    const chainzApiKeyField = (info.configFields || [])[0];
    assert(
      chainzApiKeyField &&
        chainzApiKeyField.key === 'chainz-config' &&
        chainzApiKeyField.secret === true,
      'chainz: getInfo configFields[0] is secret chainz-config field',
      chainzApiKeyField
    );
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
