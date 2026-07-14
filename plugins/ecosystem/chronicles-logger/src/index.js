'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const RESULT_BEGIN = '<<<IGNITE_RESULT_BEGIN>>>';
const RESULT_END = '<<<IGNITE_RESULT_END>>>';
const BEGIN = '<!-- ignite:chronicles:begin -->';
const END = '<!-- ignite:chronicles:end -->';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const metadata = {
  id: 'chronicles-logger',
  types: ['deployment-hook'],
  name: 'Chronicles Logger',
  version: '0.1.0',
  baseImage: 'ignite/installed_chronicles-logger:0.1.0',
  permissions: [{ id: 'repoWrite', description: 'Maintain deployment history and markdown in the workflow repository.' }],
  repoRead: true,
  operations: ['describeDeploymentHook', 'onRunCompleted', 'suggestAddresses'],
  operationPermissions: { onRunCompleted: 'repoWrite' },
  configFields: [],
};

function getInfo() { return { success: true, data: metadata }; }
function describeDeploymentHook() {
  return { success: true, data: { label: 'Chronicles Logger', description: 'Maintains idempotent JSON deployment history and human-readable markdown in the workflow repository.' } };
}

async function onRunCompleted(options) {
  const artifact = options?.artifact;
  const workflowName = options?.workflowName ?? artifact?.workflow?.name;
  if (!artifact || typeof artifact !== 'object' || typeof artifact.runId !== 'string' || typeof workflowName !== 'string')
    throw new Error('artifact and workflowName are required');
  const root = workspace(options);
  const groups = eventsFromArtifact(artifact, workflowName);
  const notes = [];
  let wrote = false;
  for (const [chainId, events] of groups) {
    const rel = `deployments/json/${chainId}.json`;
    const file = path.join(root, ...rel.split('/'));
    let existing;
    try { existing = await readLog(file, chainId); }
    catch {
      notes.push(`Chronicles could not parse ${rel}; file was left unchanged`);
      continue;
    }
    const merged = mergeLog(existing, chainId, events);
    await atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`);
    await updateMarkdown(path.join(root, 'deployments', `${chainId}.md`), renderChain(merged));
    wrote = true;
  }
  if (wrote) await updateIndex(root);
  return { success: true, data: notes.length ? { notes } : {} };
}

async function suggestAddresses(options) {
  const root = workspace(options);
  const requested = new Set(Array.isArray(options?.chainIds) ? options.chainIds.map(Number) : []);
  const contractName = typeof options?.contractName === 'string' ? options.contractName : undefined;
  const entries = [];
  const directory = path.join(root, 'deployments', 'json');
  let files = [];
  try { files = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const dirent of files) {
    if (!dirent.isFile() || dirent.isSymbolicLink() || !dirent.name.endsWith('.json')) continue;
    try {
      const log = await readLog(path.join(directory, dirent.name), Number(dirent.name.slice(0, -5)));
      if (requested.size && !requested.has(Number(log.chainId))) continue;
      for (const item of log.history) {
        if (contractName && item.name !== contractName) continue;
        if (!ADDRESS.test(item.address)) continue;
        entries.push({ chainId: Number(log.chainId), address: item.address, label: `${item.workflow ?? 'deployment'} · ${item.timestamp}`, contractName: item.name, ...(item.versionLabel ? { versionLabel: item.versionLabel } : {}), timestamp: item.timestamp });
      }
    } catch { /* malformed collaborator file is omitted from suggestions */ }
  }
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { success: true, data: { suggestions: entries.slice(0, 64).map(({ timestamp: _timestamp, ...entry }) => entry) } };
}

function eventsFromArtifact(artifact, workflowName) {
  const contracts = new Map((artifact.contracts ?? []).map((contract) => [contract.id, contract]));
  const grouped = new Map();
  for (const lane of Object.values(artifact.lanes ?? {})) {
    const chainId = Number(lane?.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) continue;
    for (const step of lane.steps ?? []) {
      if (step?.kind !== 'deploy' || !ADDRESS.test(step.address ?? '') || !['confirmed', 'skipped'].includes(step.status)) continue;
      const contract = contracts.get(step.contractId);
      if (!contract || typeof contract.contractName !== 'string') continue;
      const attempt = [...(step.attempts ?? [])].reverse().find((candidate) => typeof candidate?.txHash === 'string');
      const entry = {
        name: contract.contractName,
        ...(contract.versionLabel ? { versionLabel: contract.versionLabel } : {}),
        address: step.address,
        ...(attempt?.txHash ? { txHash: attempt.txHash } : {}),
        ...(ADDRESS.test(step.signerAddress ?? '') ? { deployer: step.signerAddress } : {}),
        timestamp: artifact.updatedAt,
        runId: artifact.runId,
        eventId: `${artifact.runId}:${chainId}:${step.stepId}`,
        workflow: workflowName,
      };
      const list = grouped.get(chainId) ?? []; list.push(entry); grouped.set(chainId, list);
    }
  }
  return grouped;
}

async function readLog(file, fallbackChainId) {
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { chainId: fallbackChainId, latest: {}, history: [] };
    throw error;
  }
  if (!plain(value) || !plain(value.latest) || !Array.isArray(value.history)) throw new Error('invalid chronicles log shape');
  for (const entry of value.history) {
    if (!plain(entry) || typeof entry.name !== 'string' || typeof entry.address !== 'string' || typeof entry.timestamp !== 'string') throw new Error('invalid chronicles history entry');
  }
  return value;
}

function mergeLog(existing, chainId, incoming) {
  const history = existing.history.map((entry) => ({ ...entry }));
  for (const event of incoming) {
    const index = history.findIndex((entry) => entry.eventId === event.eventId);
    if (index >= 0) history[index] = { ...history[index], ...event };
    else history.push(event);
  }
  const newest = new Map();
  for (const entry of history) {
    const key = entry.versionLabel ? `${entry.name}@${entry.versionLabel}` : entry.name;
    const current = newest.get(key);
    if (!current || entry.timestamp > current.timestamp) newest.set(key, entry);
  }
  const latest = Object.fromEntries([...newest].map(([key, entry]) => [key, entry.address]));
  return { ...existing, chainId, latest, history };
}

async function updateIndex(root) {
  const directory = path.join(root, 'deployments', 'json');
  let files = [];
  try { files = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  const logs = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try { logs.push(await readLog(path.join(directory, entry.name), Number(entry.name.slice(0, -5)))); } catch { /* preserve malformed file, omit from index */ }
  }
  logs.sort((a, b) => Number(a.chainId) - Number(b.chainId));
  const lines = ['# Deployment chronicles', '', '| Chain | Contract | Address |', '| --- | --- | --- |'];
  for (const log of logs) for (const [name, address] of Object.entries(log.latest)) lines.push(`| ${escapeMd(String(log.chainId))} | ${escapeMd(name)} | \`${escapeMd(address)}\` |`);
  await updateMarkdown(path.join(root, 'deployments', 'index.md'), lines.join('\n'));
}

function renderChain(log) {
  const rows = [...log.history].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const lines = [`# Chain ${escapeMd(String(log.chainId))}`, '', '| Contract | Address | Workflow | Timestamp |', '| --- | --- | --- | --- |'];
  for (const item of rows) {
    const name = item.versionLabel ? `${item.name}@${item.versionLabel}` : item.name;
    lines.push(`| ${escapeMd(name)} | \`${escapeMd(item.address)}\` | ${escapeMd(item.workflow ?? '')} | ${escapeMd(item.timestamp)} |`);
  }
  return lines.join('\n');
}

async function updateMarkdown(file, body) {
  let existing = '';
  try { existing = await fs.readFile(file, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const region = `${BEGIN}\n${body}\n${END}`;
  const begin = existing.indexOf(BEGIN); const end = existing.indexOf(END, begin + BEGIN.length);
  let next;
  if (begin >= 0 && end >= begin) next = `${existing.slice(0, begin)}${region}${existing.slice(end + END.length)}`;
  else {
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${separator}${region}\n`;
  }
  await atomicWrite(file, next);
}

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try { await fs.writeFile(temp, contents, 'utf8'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

function escapeMd(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1');
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function workspace(options) { return options?.workspacePath || process.env.WORKSPACE_PATH || '/workspace'; }
function frame(result) { return `\n${RESULT_BEGIN}${JSON.stringify(result)}${RESULT_END}`; }
function failure(code, message, details) { return { success: false, error: { code, message, ...(details ? { details } : {}) } }; }
async function readStdin() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }
async function runPluginCLI() {
  try {
    const operation = process.argv.at(-1); const raw = (await readStdin()).trim() || '{}'; const options = JSON.parse(raw);
    options.workspacePath ||= process.env.WORKSPACE_PATH || '/workspace';
    const handler = operations[operation];
    if (typeof handler !== 'function') return console.log(frame(failure('OPERATION_NOT_IMPLEMENTED', `Operation '${operation}' not implemented by plugin`)));
    try { console.log(frame(await handler(options))); }
    catch (error) { console.log(frame(failure('PLUGIN_EXECUTION_ERROR', `Plugin execution failed: ${error instanceof Error ? error.message : String(error)}`))); }
  } catch (error) { console.log(frame(failure('CLI_EXECUTION_FAILED', `CLI execution failed: ${error instanceof Error ? error.message : String(error)}`))); }
}

const operations = { getInfo, describeDeploymentHook, onRunCompleted, suggestAddresses };
module.exports = { ...operations, _internals: { mergeLog, escapeMd, eventsFromArtifact } };
if (require.main === module) void runPluginCLI();
