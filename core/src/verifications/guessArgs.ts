import { decodeAbiParameters, type AbiParameter } from 'viem';
import type { ArgValues, ExplorerTargetSnapshot } from '@ignite/api';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';

export async function guessConstructorArgs(args: {
  chainId: number;
  address: string;
  creationCode: string;
  inputs: AbiParameter[];
  explorers: ExplorerTargetSnapshot[];
  selectedIds: string[];
  execute?: Pick<PluginExecutor, 'execute'>;
  getTransaction: (
    hash: string
  ) => Promise<{ to?: string | null; input: string } | undefined>;
}): Promise<{ args: ArgValues; encodedTail: string; txHash: string }> {
  const execute = args.execute ?? PluginExecutor.getInstance();
  const selected = new Set(args.selectedIds);
  const ordered = [...args.explorers].sort(
    (a, b) => Number(selected.has(b.entryId)) - Number(selected.has(a.entryId))
  );
  let txHash: string | undefined;
  for (const explorer of ordered) {
    const response = await execute.execute(
      explorer.verifierPluginId,
      'getCreationTx',
      {
        chainId: args.chainId,
        address: args.address,
        explorerUrl: explorer.url,
        apiUrl: explorer.apiUrl,
      },
      { chainScope: args.chainId }
    );
    if (
      response.success &&
      response.data &&
      typeof (response.data as { txHash?: unknown }).txHash === 'string'
    ) {
      txHash = (response.data as { txHash: string }).txHash;
      break;
    }
  }
  if (!txHash)
    throw Object.assign(
      new Error('No selected explorer can find the creation transaction'),
      { code: 'CREATION_TX_UNAVAILABLE' }
    );
  const tx = await args.getTransaction(txHash);
  if (!tx)
    throw Object.assign(
      new Error('Creation transaction is unavailable from the selected RPC'),
      { code: 'RPC_TX_UNAVAILABLE' }
    );
  if (tx.to !== null && tx.to !== undefined)
    throw Object.assign(
      new Error('Contract was deployed by a factory — enter args manually'),
      { code: 'FACTORY_CREATION_UNSUPPORTED' }
    );
  if (!tx.input.toLowerCase().startsWith(args.creationCode.toLowerCase()))
    throw Object.assign(
      new Error("Current build doesn't match the deployed bytecode"),
      { code: 'BYTECODE_MISMATCH' }
    );
  const encodedTail =
    `0x${tx.input.slice(args.creationCode.length).replace(/^0x/, '')}` as `0x${string}`;
  const decoded = decodeAbiParameters(args.inputs, encodedTail);
  const values: ArgValues = {};
  args.inputs.forEach((input, index) => {
    values[input.name || `arg${index}`] = decoded[index];
  });
  return { args: values, encodedTail, txHash };
}
