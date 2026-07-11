import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ArgValues, ContractSource } from '@ignite/api';
import ArtifactPicker from '../../components/ArtifactPicker';
import ConstructorArgsForm, { constructorInputs } from '../../components/ConstructorArgsForm';
import Select from '../../components/Select';
import ExplorerMultiSelect from '../deploy/steps/ExplorerMultiSelect';
import { useAppDispatch, useAppSelector } from '../../store';
import { chainsApi } from '../../store/features/chains/chainsSlice';
import { apiClient } from '../../store/api/client';
import { verificationTasksReceived } from '../../store/features/verifications/verificationsSlice';
import { ApiError } from '@ignite/api/client';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function verificationSubmitBody({
  contract,
  chainId,
  address,
  args,
  encodedConstructorArgs,
  creationTxHash,
  explorerEntryIds,
}: {
  contract: ContractSource;
  chainId: number;
  address: string;
  args: ArgValues;
  encodedConstructorArgs?: string;
  creationTxHash?: string;
  explorerEntryIds: string[];
}) {
  return {
    contract,
    chainId,
    address,
    ...(encodedConstructorArgs ? { encodedConstructorArgs } : { args }),
    ...(creationTxHash ? { creationTxHash } : {}),
    explorerEntryIds,
  };
}

function submissionErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) return cause.body.message || cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export default function VerifyContractPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const chains = useAppSelector((state) => state.chains.chains);
  const [contract, setContract] = useState<ContractSource | undefined>(() => {
    const required = ['contractId', 'repoPathOrUrl', 'frameworkId', 'artifactPath', 'contractName', 'sourcePath'];
    if (!required.every((key) => params.get(key))) return undefined;
    return {
      id: params.get('contractId')!,
      repoPathOrUrl: params.get('repoPathOrUrl')!,
      frameworkId: params.get('frameworkId')!,
      artifactPath: params.get('artifactPath')!,
      contractName: params.get('contractName')!,
      sourcePath: params.get('sourcePath')!,
    };
  });
  const [abi, setAbi] = useState<unknown[]>([]);
  const [chainId, setChainId] = useState(params.get('chainId') ?? '');
  const [address, setAddress] = useState(params.get('address') ?? '');
  const [creationTxHash, setCreationTxHash] = useState('');
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [args, setArgs] = useState<ArgValues>({});
  const [encodedTail, setEncodedTail] = useState<string | undefined>();
  const [guessError, setGuessError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chainsApi.fetchChains(undefined, 500).forEach((action) => dispatch(action));
  }, [dispatch]);
  useEffect(() => {
    if (!contract || abi.length) return;
    void apiClient.request('getArtifactData', { body: { pathOrUrl: contract.repoPathOrUrl, pluginId: contract.frameworkId, artifactPath: contract.artifactPath } }).then((response) => {
      if ('data' in response) setAbi(response.data.abi as unknown[]);
    });
  }, [abi.length, contract]);

  const numericChainId = Number(chainId);
  const explorerIds = selection[chainId] ?? [];
  const hasConstructor = constructorInputs(abi as never[]).length > 0;
  const chainOptions = useMemo(() => chains.map((chain) => ({ value: String(chain.chainId), label: `${chain.name} (${chain.chainId})` })), [chains]);
  const valid = Boolean(contract && Number.isInteger(numericChainId) && ADDRESS.test(address) && explorerIds.length);

  const guess = async () => {
    if (!contract || !ADDRESS.test(address) || !Number.isInteger(numericChainId)) return;
    setGuessError(null);
    try {
      const response = await apiClient.request('guessConstructorArgs', { body: { contract, chainId: numericChainId, address } });
      if (!('data' in response)) throw new Error(response.message);
      setArgs(response.data.args);
      setEncodedTail(response.data.encodedTail);
      setCreationTxHash(response.data.txHash);
    } catch (cause) {
      setGuessError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const submit = async () => {
    if (!contract || !valid) return;
    setSubmitting(true);
    setError(null);
    const body = verificationSubmitBody({ contract, chainId: numericChainId, address, args, encodedConstructorArgs: encodedTail, creationTxHash: creationTxHash || undefined, explorerEntryIds: explorerIds });
    try {
      const response = await apiClient.request('createVerification', { body });
      if (!('data' in response)) throw new Error('Verification submission failed');
      dispatch(verificationTasksReceived(response.data.tasks));
      navigate('/deployments?manualVerification=1');
    } catch (cause) {
      setError(submissionErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="text-[var(--text)] max-w-3xl mx-auto grid gap-4">
    <header><h1 className="page-title mb-0">Verify a contract</h1><p className="text-sm text-muted">Submit an existing deployment to selected explorers.</p></header>
    <section className="card-milky p-4 grid gap-3"><h2 className="font-semibold">1. Contract</h2><ArtifactPicker value={contract} onSelect={(next, nextAbi) => { setContract(next); setAbi(nextAbi as unknown[]); setArgs({}); setEncodedTail(undefined); }} />{contract && <p className="mono-data text-muted">{contract.sourcePath} · {contract.contractName}</p>}</section>
    <section className="card-milky p-4 grid gap-3"><h2 className="font-semibold">2. Chain + address</h2><Select options={chainOptions} value={chainId} placeholder="Select chain" onValueChange={setChainId} /><input className="input-glass" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x contract address" />{address && !ADDRESS.test(address) && <p className="text-sm text-err">Enter a valid EVM address.</p>}<input className="input-glass" value={creationTxHash} onChange={(event) => setCreationTxHash(event.target.value)} placeholder="Creation transaction hash (optional)" /></section>
    {chainId && <section className="card-milky p-4 grid gap-3"><h2 className="font-semibold">3. Explorers</h2><ExplorerMultiSelect chainIds={[numericChainId]} selection={selection} onSelectionChange={setSelection} /></section>}
    {hasConstructor && <section className="card-milky p-4 grid gap-3"><div className="flex justify-between gap-2"><h2 className="font-semibold">4. Constructor arguments</h2><button type="button" className="btn btn-sm btn-secondary" onClick={() => void guess()} disabled={!contract || !ADDRESS.test(address)}>Guess from creation tx</button></div>{guessError && <p className="text-sm text-err">{guessError}</p>}<ConstructorArgsForm abi={abi as never[]} value={args} onChange={(next) => { setArgs(next); setEncodedTail(undefined); }} /></section>}
    {error && <p className="text-err">{error}</p>}<button type="button" className="btn btn-primary justify-self-end" disabled={!valid || submitting} onClick={() => void submit()}>Submit verification</button>
  </div>;
}
