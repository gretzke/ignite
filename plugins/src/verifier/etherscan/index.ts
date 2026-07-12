import { VerifierPlugin, PluginType, type PluginMetadata, type PluginResponse, type VerifierOperation, type SupportedExplorersResult, type VerifyParams, type VerifyStatusResult, type CheckVerificationParams, type GetCreationTxParams, type CreationTxResult } from '../../shared/index.ts';
import { runPluginCLI } from '../../shared/plugin-runner.js';
declare const PLUGIN_VERSION: string;

type WithConfig<T> = T & { config?: Record<string, unknown> };
const patterns = ['etherscan', 'arbiscan', 'optimistic.etherscan', 'basescan', 'polygonscan', 'bscscan', 'snowtrace'];

export class EtherscanPlugin extends VerifierPlugin {
  protected static getMetadata(): PluginMetadata { return { id: 'etherscan', types: [PluginType.VERIFIER], name: 'Etherscan', version: PLUGIN_VERSION, baseImage: 'ignite/verifier_etherscan:latest', permissions: [{ id: 'net', description: 'Call the Etherscan API.' }], configFields: [{ key: 'apiKey', label: 'API Key', type: 'string', secret: true, required: true, description: 'Etherscan V2 API key.' }] }; }
  async getSupportedExplorers(options?: { config?: Record<string, unknown> }): Promise<PluginResponse<SupportedExplorersResult>> {
    const apiKey = key(options?.config); if (!apiKey) return ok({ explorers: null, urlPatterns: patterns });
    try {
      const json = await requestJson('https://api.etherscan.io/v2/chainlist', undefined);
      const rows = Array.isArray(json.result) ? json.result : [];
      return ok({ explorers: rows.filter((row: any) => !/zksync/i.test(String(row.chainname ?? row.chainName ?? '')) && Number.isInteger(Number(row.chainid ?? row.chainId)) && typeof (row.blockexplorer ?? row.explorerUrl) === 'string').map((row: any) => ({ chainId: Number(row.chainid ?? row.chainId), explorerUrl: String(row.blockexplorer ?? row.explorerUrl), label: typeof row.chainname === 'string' ? row.chainname : undefined })), urlPatterns: patterns });
    } catch { return failed('NETWORK_ERROR'); }
  }
  async verify(options: WithConfig<VerifyParams>): Promise<PluginResponse<VerifyStatusResult>> {
    const apiKey = key(options.config); if (!apiKey) return failed('CONFIG_REQUIRED', false);
    try {
      const body = new URLSearchParams({ module: 'contract', action: 'verifysourcecode', contractaddress: options.address, sourceCode: JSON.stringify(options.standardJsonInput), codeformat: 'solidity-standard-json-input', contractname: options.contractIdentifier, compilerversion: options.solcVersion, constructorArguements: options.encodedConstructorArgs.replace(/^0x/i, ''), apikey: apiKey });
      const json = await requestJson(api(options), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      return mapSubmit(json);
    } catch { return failed('NETWORK_ERROR'); }
  }
  async checkVerification(options: WithConfig<CheckVerificationParams>): Promise<PluginResponse<VerifyStatusResult>> {
    try { return mapPoll(await requestJson(`${api(options)}${api(options).includes('?') ? '&' : '?'}module=contract&action=checkverifystatus&guid=${encodeURIComponent(options.pollTicket)}&apikey=${encodeURIComponent(key(options.config))}`)); }
    catch { return failed('NETWORK_ERROR'); }
  }
  async getCreationTx(options: WithConfig<GetCreationTxParams>): Promise<PluginResponse<CreationTxResult>> {
    try { const json = await requestJson(`${api(options)}${api(options).includes('?') ? '&' : '?'}module=contract&action=getcontractcreation&contractaddresses=${encodeURIComponent(options.address)}&apikey=${encodeURIComponent(key(options.config))}`); const row = Array.isArray(json.result) ? json.result[0] : undefined; const txHash = row?.txHash ?? row?.txhash; return ok(typeof txHash === 'string' ? { txHash } : null); }
    catch { return failed('NETWORK_ERROR'); }
  }
}
function api(options: { chainId: number; apiUrl?: string }) { return options.apiUrl ?? `https://api.etherscan.io/v2/api?chainid=${options.chainId}`; }
function key(config?: Record<string, unknown>) { const value = config?.apiKey; return typeof value === 'string' ? value.trim() : ''; }
async function requestJson(url: string, init?: RequestInit): Promise<any> { const response = await fetch(url, init); if (!response.ok) throw new Error(`HTTP_${response.status}`); return response.json(); }
function text(json: any) { return String(json?.result ?? json?.message ?? ''); }
function ok<T>(data: T): PluginResponse<T> { return { success: true, data }; }
function failed(code: string, retryable = true, message?: string): PluginResponse<any> { return ok({ status: 'failed', retryable, detail: message ? `${code}: ${message.slice(0, 300)}` : code }); }
function mapSubmit(json: any): PluginResponse<VerifyStatusResult> { const value = text(json); if (/contract source code already verified|already verified/i.test(value)) return ok({ status: 'already-verified' }); if (/already verifying|is already being verified|pending in queue(?: at submit)?/i.test(value)) return ok({ status: 'failed', retryable: true, detail: 'verification already in progress' }); if (json?.status === '1' && value) return ok({ status: 'pending', pollTicket: value }); const notIndexed = /unable to locate contractcode|not.{0,10}indexed|does not exist/i.test(value); const transient = /rate limit|nonce|temporar|server/i.test(value); return failed(notIndexed || transient ? 'RETRYABLE' : 'SUBMIT_FAILED', notIndexed || transient, value); }
function mapPoll(json: any): PluginResponse<VerifyStatusResult> { const value = text(json); if (/Pending in queue/i.test(value)) return ok({ status: 'pending' }); if (/Pass - Verified/i.test(value)) return ok({ status: 'verified' }); if (/Already Verified/i.test(value)) return ok({ status: 'already-verified' }); if (/Max rate limit|5\d\d|temporar/i.test(value)) return failed('RETRYABLE', true); return ok({ status: 'failed', retryable: false, detail: `VERIFICATION_FAILED: ${value.slice(0, 300)}` }); }
const plugin = new EtherscanPlugin(); export default plugin; runPluginCLI<VerifierOperation>(plugin);
