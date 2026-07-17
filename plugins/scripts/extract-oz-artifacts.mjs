#!/usr/bin/env node

// Vendor the canonical OZ 5.3.0 proxy artifacts. The upstream package has a
// single build-info input for its proxy set; each output gets only the
// transitive source closure it needs so verification payloads stay minimal.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const upgrades = join(root, 'node_modules', '@openzeppelin', 'upgrades-core');
const artifacts = join(upgrades, 'artifacts');
const output = join(root, 'src', 'contract-type', 'openzeppelin', 'artifacts');
const buildInfo = JSON.parse(await readFile(join(artifacts, 'build-info-v5.json'), 'utf8'));

const contracts = [
  {
    name: 'TransparentUpgradeableProxy',
    path: '@openzeppelin/contracts-v5/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json',
    sourceIdentifier: '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
    constructor: [['_logic', 'address'], ['initialOwner', 'address'], ['_data', 'bytes']],
  },
  {
    name: 'ProxyAdmin',
    path: '@openzeppelin/contracts-v5/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json',
    sourceIdentifier: '@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
    constructor: [['initialOwner', 'address']],
  },
  {
    name: 'ERC1967Proxy',
    path: '@openzeppelin/contracts-v5/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json',
    sourceIdentifier: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy',
    constructor: [['implementation', 'address'], ['_data', 'bytes']],
  },
];

const hex = /^0x(?:[0-9a-fA-F]{2})+$/;
const imports = /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]\s*;/g;

function fail(message) { throw new Error(`OZ artifact extraction failed: ${message}`); }
function constructorInputs(artifact) {
  const item = artifact.abi.find((entry) => entry?.type === 'constructor');
  return item?.inputs?.map(({ name, type }) => [name, type]);
}
function resolveImport(from, specifier) {
  if (specifier.startsWith('.')) return posix.normalize(posix.join(posix.dirname(from), specifier));
  return specifier;
}
function closure(entry) {
  const sources = buildInfo.input?.sources;
  if (!sources || typeof sources !== 'object' || !sources[entry]) fail(`missing source ${entry}`);
  const seen = new Set();
  const visit = (source) => {
    if (seen.has(source)) return;
    const content = sources[source]?.content;
    if (typeof content !== 'string') fail(`source ${source} has no literal content`);
    seen.add(source);
    for (const match of content.matchAll(imports)) {
      const child = resolveImport(source, match[1]);
      if (!sources[child]) fail(`${source} imports unavailable source ${child}`);
      visit(child);
    }
  };
  visit(entry);
  return Object.fromEntries([...seen].sort().map((name) => [name, { content: sources[name].content }]));
}

if (buildInfo.solcVersion !== '0.8.29') fail(`expected solcVersion 0.8.29, got ${buildInfo.solcVersion}`);
if (!buildInfo.input || buildInfo.input.language !== 'Solidity') fail('build info is not a Solidity standard JSON input');
await mkdir(output, { recursive: true });
for (const spec of contracts) {
  const artifact = JSON.parse(await readFile(join(artifacts, spec.path), 'utf8'));
  if (!hex.test(artifact.bytecode) || !hex.test(artifact.deployedBytecode)) fail(`${spec.name} bytecode is not nonempty 0x hex`);
  if (JSON.stringify(constructorInputs(artifact)) !== JSON.stringify(spec.constructor)) fail(`${spec.name} constructor ABI does not match the pinned contract`);
  const standardJsonInput = {
    language: 'Solidity',
    sources: closure(artifact.sourceName),
    // outputSelection is compiler output configuration, not a source-build
    // setting, and is rejected by some explorer standard-json frontends.
    settings: Object.fromEntries(Object.entries(buildInfo.input.settings ?? {}).filter(([key]) => key !== 'outputSelection')),
  };
  const result = {
    abi: artifact.abi,
    creationBytecode: artifact.bytecode,
    runtimeBytecode: artifact.deployedBytecode,
    solcVersion: buildInfo.solcVersion,
    sourceIdentifier: spec.sourceIdentifier,
    standardJsonInput,
  };
  await writeFile(join(output, `${spec.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${spec.name}: ${Object.keys(standardJsonInput.sources).length} sources`);
}
