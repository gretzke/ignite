import type { ChainInfo, ExplorerTargetSnapshot } from '@ignite/api';

function eip3091Explorer(chain: ChainInfo | undefined) {
  return chain?.explorers?.find((explorer) => explorer.standard === 'EIP3091');
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function explorerAddressUrl(
  chain: ChainInfo | undefined,
  targets: ExplorerTargetSnapshot[],
  address: string
): string | undefined {
  const explorer = eip3091Explorer(chain);
  if (explorer) return `${withoutTrailingSlash(explorer.url)}/address/${address}`;
  const target = targets.find((candidate) => candidate.pageUrlTemplate);
  return target?.pageUrlTemplate?.replace('{address}', address);
}

export function explorerTxUrl(
  chain: ChainInfo | undefined,
  txHash: string
): string | undefined {
  const explorer = eip3091Explorer(chain);
  return explorer
    ? `${withoutTrailingSlash(explorer.url)}/tx/${txHash}`
    : undefined;
}
