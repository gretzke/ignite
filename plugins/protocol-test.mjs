#!/usr/bin/env node
// Standalone protocol conformance test for Ignite's builtin rpc-provider
// plugin bundles (third-party ecosystem plugins live in their own repos,
// e.g. ../ignite-chainz-plugin, and carry their own copy of this harness).
//
// No test framework: the bundles are dependency-free CLI programs, so a
// plain node script keeps the suite dependency-free too. Requires a plugins
// build (cd plugins && npm run build). Run with:
//
//   node plugins/protocol-test.mjs

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';

// Infura and Alchemy graduated to builtin plugins (plugins/src/rpc-provider/)
// but speak the exact same CLI protocol (runPluginCLI reads the operation
// from the last argv element and options from stdin), so this suite drives
// their built bundles directly.
const BUILTIN_BUNDLE_DIR = path.resolve(__dirname, 'dist', 'js');

const PLUGINS = [
  {
    entry: path.join(BUILTIN_BUNDLE_DIR, 'rpc-provider_infura.js'),
    id: 'infura',
    name: 'Infura',
    configFieldKey: 'api-key',
    // Strongest available check: every generated URL must actually embed
    // the configured API key (TESTKEY), not merely look like an https URL.
    assertUrls: (chains) => chains.every((c) => c.url.includes('TESTKEY')),
  },
  {
    entry: path.join(BUILTIN_BUNDLE_DIR, 'rpc-provider_alchemy.js'),
    id: 'alchemy',
    name: 'Alchemy',
    configFieldKey: 'api-key',
    assertUrls: (chains) => chains.every((c) => c.url.includes('TESTKEY')),
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

// Runs `node <entry> <op>` with `options` JSON on stdin, and parses the
// sentinel-framed PluginResponse from stdout. `entry` is either an
// ecosystem plugin's index.cjs or a built builtin bundle — both read the
// operation from the last argv element and options from stdin.
function runOp(entry, op, options) {
  const input = JSON.stringify(options ?? {});
  const result = spawnSync(process.execPath, [entry, op], {
    input,
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(
      `failed to spawn plugin ${entry} for op ${op}: ${result.error}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `plugin ${entry} op ${op} exited with status ${result.status}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  const stdout = result.stdout;
  const beginIdx = stdout.indexOf(RESULT_BEGIN);
  const endIdx = stdout.indexOf(RESULT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `plugin ${entry} op ${op} did not emit a sentinel-framed result.\n` +
        `stdout:\n${stdout}`
    );
  }
  const jsonText = stdout.slice(beginIdx + RESULT_BEGIN.length, endIdx);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `plugin ${entry} op ${op} emitted unparseable JSON: ${jsonText}\n` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }
}

for (const plugin of PLUGINS) {
  if (!existsSync(plugin.entry)) {
    console.error(
      `FAIL: ${plugin.name}: plugin entry not found: ${plugin.entry}\n` +
        `Built bundles are required — run the plugins build first ` +
        `(cd plugins && npm run build).`
    );
    process.exit(1);
  }

  console.log(`\n== ${plugin.name} (${path.relative(path.resolve(__dirname, '..'), plugin.entry)}) ==`);

  // --- getInfo shape ---
  const infoResponse = runOp(plugin.entry, 'getInfo', {});
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
  const emptyResponse = runOp(plugin.entry, 'getSupportedChains', {});
  assert(
    emptyResponse.success === true &&
      Array.isArray(emptyResponse.data?.chains) &&
      emptyResponse.data.chains.length === 0,
    `${plugin.name}: getSupportedChains with no config returns empty chains`,
    emptyResponse
  );

  const emptyKeyResponse = runOp(plugin.entry, 'getSupportedChains', {
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
  const testConfig = { [plugin.configFieldKey]: 'TESTKEY' };

  const chainsResponse = runOp(plugin.entry, 'getSupportedChains', {
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
  const unknownResponse = runOp(plugin.entry, 'thisOperationDoesNotExist', {});
  assert(
    unknownResponse.success === false &&
      typeof unknownResponse.error?.code === 'string',
    `${plugin.name}: unknown operation returns a success:false error envelope`,
    unknownResponse
  );

}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
