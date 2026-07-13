import { keccak256 } from 'viem';

// v4-core Hooks.Permissions source order / flag bits:
// beforeInitialize (1 << 13), afterInitialize (1 << 12), beforeAddLiquidity
// (1 << 11), afterAddLiquidity (1 << 10), beforeRemoveLiquidity (1 << 9),
// afterRemoveLiquidity (1 << 8), beforeSwap (1 << 7), afterSwap (1 << 6),
// beforeDonate (1 << 5), afterDonate (1 << 4), beforeSwapReturnDelta (1 << 3),
// afterSwapReturnDelta (1 << 2), afterAddLiquidityReturnDelta (1 << 1),
// afterRemoveLiquidityReturnDelta (1 << 0).
const HOOK_PERMISSION_COUNT = 14;
const asHex = (bytes: Uint8Array): `0x${string}` => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

export async function deriveFlags(initcode: Uint8Array): Promise<number> {
  // EthereumJS pulls optional terminal/debug modules. Keep it behind the
  // operation path so metadata extraction stays a pure, import-safe build
  // step for the builtin registry.
  const [{ createVM }, { hexToBytes }] = await Promise.all([
    import('@ethereumjs/vm'),
    import('@ethereumjs/util'),
  ]);
  const vm = await createVM();
  const deployment = await vm.evm.runCall({ data: initcode, gasLimit: 15_000_000n, skipBalance: true });
  if (deployment.execResult.exceptionError || !deployment.createdAddress) throw new Error('initcode creation failed');
  const selector = hexToBytes(keccak256(new TextEncoder().encode('getHookPermissions()')).slice(0, 10) as `0x${string}`);
  const call = await vm.evm.runCall({ to: deployment.createdAddress, data: selector, gasLimit: 1_000_000n, skipBalance: true });
  if (call.execResult.exceptionError || call.execResult.returnValue.length !== HOOK_PERMISSION_COUNT * 32) throw new Error('getHookPermissions() returned malformed data');
  let flags = 0;
  for (let index = 0; index < HOOK_PERMISSION_COUNT; index++) {
    const word = call.execResult.returnValue.slice(index * 32, (index + 1) * 32);
    if (word.slice(0, 31).some((byte) => byte !== 0) || (word[31] !== 0 && word[31] !== 1)) throw new Error('getHookPermissions() returned non-boolean data');
    if (word[31] === 1) flags |= 1 << (13 - index);
  }
  return flags;
}
