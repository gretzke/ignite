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
  { dir: 'infura', id: 'infura', name: 'Infura' },
  { dir: 'alchemy', id: 'alchemy', name: 'Alchemy' },
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
    apiKeyField && apiKeyField.key === 'api-key',
    `${plugin.name}: getInfo configFields[0].key === 'api-key'`,
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
    config: { 'api-key': '   ' },
  });
  assert(
    emptyKeyResponse.success === true &&
      Array.isArray(emptyKeyResponse.data?.chains) &&
      emptyKeyResponse.data.chains.length === 0,
    `${plugin.name}: getSupportedChains with blank api-key returns empty chains`,
    emptyKeyResponse
  );

  // --- getSupportedChains with config ---
  const TEST_KEY = 'TESTKEY';
  const chainsResponse = runOp(plugin.dir, 'getSupportedChains', {
    config: { 'api-key': TEST_KEY },
  });
  assert(
    chainsResponse.success === true,
    `${plugin.name}: getSupportedChains with api-key returns success:true`,
    chainsResponse
  );
  const chains = chainsResponse.data?.chains || [];
  assert(
    chains.length > 0,
    `${plugin.name}: getSupportedChains with api-key returns a non-empty chain list`,
    chains
  );

  const badUrl = chains.find(
    (c) => !c.url.startsWith('https://') || !c.url.includes(TEST_KEY)
  );
  assert(
    !badUrl,
    `${plugin.name}: every chain URL starts with https:// and contains the api key`,
    badUrl
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
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
