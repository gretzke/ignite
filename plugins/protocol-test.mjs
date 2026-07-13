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
import { spawnSync, spawn } from 'node:child_process';
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
function runOp(entry, op, options, env) {
  const input = JSON.stringify(options ?? {});
  const result = spawnSync(process.execPath, [entry, op], {
    input,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
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
    info.type === 'rpc-provider' || info.types?.includes('rpc-provider'),
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
  // null means "needs configuration" — distinct from an empty array, which
  // would mean the provider ran fine but has nothing to report.
  const emptyResponse = runOp(plugin.entry, 'getSupportedChains', {});
  assert(
    emptyResponse.success === true && emptyResponse.data?.chains === null,
    `${plugin.name}: getSupportedChains with no config returns chains: null`,
    emptyResponse
  );

  const emptyKeyResponse = runOp(plugin.entry, 'getSupportedChains', {
    config: { [plugin.configFieldKey]: '   ' },
  });
  assert(
    emptyKeyResponse.success === true && emptyKeyResponse.data?.chains === null,
    `${plugin.name}: getSupportedChains with blank ${plugin.configFieldKey} returns chains: null`,
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

async function startMock() {
  const child = spawn(process.execPath, [path.join(__dirname, 'test-fixtures', 'mock-explorer.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock explorer did not become ready')), 5000);
    child.stdout.on('data', (chunk) => { const match = String(chunk).match(/READY (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.once('error', reject);
  });
  return { child, port };
}

const verifierEntries = [
  ['Etherscan', 'etherscan', { config: { apiKey: 'TESTKEY' } }],
  ['Blockscout', 'blockscout', {}],
  ['Sourcify', 'sourcify', {}],
];
const mock = await startMock();
try {
  for (const [name, id, extra] of verifierEntries) {
    const entry = path.join(BUILTIN_BUNDLE_DIR, `verifier_${id}.js`);
    assert(existsSync(entry), `${name}: built verifier entry exists`, entry);
    if (!existsSync(entry)) continue;
    const base = { chainId: 1, address: `0x000000000000000000000000000000000000000${verifierEntries.indexOf(verifierEntries.find((entry) => entry[1] === id)) + 1}`, explorerUrl: `http://127.0.0.1:${mock.port}`, apiUrl: `http://127.0.0.1:${mock.port}/api`, standardJsonInput: { language: 'Solidity', sources: { 'A.sol': { content: 'contract A {}' } }, settings: {} }, solcVersion: 'v0.8.26+commit.8a97fa7a', contractIdentifier: 'A.sol:A', encodedConstructorArgs: '0x1234', compilerSummary: { pluginId: 'foundry', optimizer: false, runs: 0, viaIR: false }, ...extra };
    const info = runOp(entry, 'getInfo', {});
    assert(info.success && info.data?.id === id, `${name}: metadata is verifier-shaped`, info);
    if (id === 'etherscan') {
      const empty = runOp(entry, 'getSupportedExplorers', {});
      assert(empty.success && empty.data?.explorers === null, 'Etherscan: blank key needs config', empty);
    }
    if (id === 'sourcify') base.apiUrl = `http://127.0.0.1:${mock.port}`;
    if (id === 'sourcify') {
      const detected = runOp(entry, 'getSupportedExplorers', { apiUrl: base.apiUrl });
      const explorer = detected.data?.explorers?.find((candidate) => candidate.chainId === 1);
      assert(
        explorer?.explorerUrl === base.apiUrl && explorer?.explorerPageUrlTemplate === 'https://repo.sourcify.dev/1/{address}',
        'Sourcify: detection preserves explorerUrl and returns a concrete-chain page URL template',
        detected
      );
    }
    const submit = runOp(entry, 'verify', base);
    assert(submit.success && submit.data?.status === 'pending', `${name}: submit returns pending`, submit);
    if (id !== 'sourcify') {
      const pending = runOp(entry, 'checkVerification', { ...base, pollTicket: submit.data.pollTicket });
      const complete = runOp(entry, 'checkVerification', { ...base, pollTicket: submit.data.pollTicket });
      assert(pending.data?.status === 'pending' && complete.data?.status === 'verified', `${name}: GUID poll transitions`, { pending, complete });
      const resubmit = runOp(entry, 'verify', base);
      assert(resubmit.data?.status === 'failed' && resubmit.data?.retryable === true && resubmit.data?.detail === 'verification already in progress', `${name}: re-submit while verification is in progress is retryable`, resubmit);
      const alreadyVerified = runOp(entry, 'verify', base);
      assert(alreadyVerified.data?.status === 'already-verified', `${name}: an existing verified contract is terminal`, alreadyVerified);
      const notIndexed = runOp(entry, 'verify', { ...base, address: '0x000000000000000000000000000000000000dead' });
      assert(
        notIndexed.data?.status === 'failed' && notIndexed.data?.retryable === true && /unable to locate contractcode/i.test(notIndexed.data?.detail ?? ''),
        `${name}: not-yet-indexed bytecode is retryable and carries the explorer message`,
        notIndexed
      );
    } else {
      const pending = runOp(entry, 'checkVerification', { ...base, pollTicket: submit.data.pollTicket });
      const complete = runOp(entry, 'checkVerification', { ...base, pollTicket: submit.data.pollTicket });
      assert(pending.data?.status === 'pending' && pending.data?.pollTicket === submit.data.pollTicket && complete.data?.status === 'verified' && complete.data?.detail === 'match:exact_match', 'Sourcify: v2 job poll transitions from pending to match detail', { pending, complete });
      const inProgress = runOp(entry, 'verify', { ...base, address: '0x0000000000000000000000000000000000000004' });
      assert(inProgress.data?.status === 'failed' && inProgress.data?.retryable === true && inProgress.data?.detail === 'verification already in progress', 'Sourcify: HTTP 429 is a retryable in-progress submission', inProgress);
      const failed = runOp(entry, 'checkVerification', { ...base, pollTicket: 'sourcify-error' });
      assert(failed.data?.status === 'failed' && failed.data?.retryable === false && failed.data?.detail === 'compiler rejected input at [URL]', 'Sourcify: completed v2 job errors are terminal and sanitized', failed);
    }
  }
} finally { mock.child.kill(); }
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
