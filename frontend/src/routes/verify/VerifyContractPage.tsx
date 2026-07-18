import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ArgValues, ContractSource } from '@ignite/api';
import ArtifactPicker from '../../components/ArtifactPicker';
import ConstructorArgsForm, {
  constructorInputs,
} from '../../components/ConstructorArgsForm';
import Select from '../../components/Select';
import ExplorerMultiSelect from '../deploy/steps/ExplorerMultiSelect';
import { useAppDispatch, useAppSelector } from '../../store';
import { mergeChainsSucceeded } from '../../store/features/chains/chainsSlice';
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
  confirmUnverifiedProvenance,
}: {
  contract: ContractSource;
  chainId: number;
  address: string;
  args: ArgValues;
  encodedConstructorArgs?: string;
  creationTxHash?: string;
  explorerEntryIds: string[];
  confirmUnverifiedProvenance?: true;
}) {
  return {
    contract,
    chainId,
    address,
    ...(encodedConstructorArgs ? { encodedConstructorArgs } : { args }),
    ...(creationTxHash ? { creationTxHash } : {}),
    ...(confirmUnverifiedProvenance ? { confirmUnverifiedProvenance } : {}),
    explorerEntryIds,
  };
}

function submissionErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) return cause.body.message || cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export function contractFromSearchParams(params: URLSearchParams): ContractSource | undefined {
  const contractTypeRequired = ['contractId', 'pluginId', 'artifactKey', 'contractName', 'versionLabel', 'contentHash'];
  if (contractTypeRequired.every((key) => params.get(key))) return {
    id: params.get('contractId')!, origin: 'contract-type', pluginId: params.get('pluginId')!,
    artifactKey: params.get('artifactKey')!, contractName: params.get('contractName')!,
    versionLabel: params.get('versionLabel')!, contentHash: params.get('contentHash')!,
  };
  const required = ['contractId', 'repoPathOrUrl', 'frameworkId', 'artifactPath', 'contractName', 'sourcePath'];
  if (!required.every((key) => params.get(key))) return undefined;
  const pinUrl = params.get('pinUrl');
  const pinCommit = params.get('pinCommit');
  const pinRef = params.get('pinRef');
  const pinRefKind = params.get('pinRefKind');
  return {
    id: params.get('contractId')!, repoPathOrUrl: params.get('repoPathOrUrl')!,
    frameworkId: params.get('frameworkId')!, artifactPath: params.get('artifactPath')!,
    contractName: params.get('contractName')!, sourcePath: params.get('sourcePath')!,
    ...(pinUrl && pinCommit ? {
      pin: {
        url: pinUrl,
        commit: pinCommit,
        ...(pinRef && (pinRefKind === 'tag' || pinRefKind === 'branch')
          ? { ref: pinRef, refKind: pinRefKind }
          : {}),
      },
    } : {}),
  };
}

export default function VerifyContractPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const chains = useAppSelector((state) => state.chains.chains);
  const [contract, setContract] = useState<ContractSource | undefined>(() => contractFromSearchParams(params));
  const [abi, setAbi] = useState<unknown[]>([]);
  const [chainId, setChainId] = useState(params.get('chainId') ?? '');
  const [chainSearch, setChainSearch] = useState('');
  const [chainSearchResults, setChainSearchResults] = useState<number[] | null>(
    null
  );
  const [address, setAddress] = useState(params.get('address') ?? '');
  const [creationTxHash, setCreationTxHash] = useState('');
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [args, setArgs] = useState<ArgValues>({});
  const [encodedTail, setEncodedTail] = useState<string | undefined>();
  const [guessError, setGuessError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresProvenanceConfirmation, setRequiresProvenanceConfirmation] = useState(false);
  const [confirmUnverifiedProvenance, setConfirmUnverifiedProvenance] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .request('listChains', { query: { limit: 500 } })
      .then((response) => {
        if (!('data' in response)) throw new Error(response.message);
        if (!cancelled) dispatch(mergeChainsSucceeded(response.data.chains));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dispatch]);
  useEffect(() => {
    if (!chainSearch.trim()) {
      setChainSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void apiClient
        .request('listChains', {
          query: { q: chainSearch.trim(), limit: 500 },
        })
        .then((response) => {
          if (!('data' in response)) throw new Error(response.message);
          if (cancelled) return;
          dispatch(mergeChainsSucceeded(response.data.chains));
          setChainSearchResults(
            response.data.chains.map((chain) => chain.chainId)
          );
        })
        .catch(() => {
          if (!cancelled) setChainSearchResults([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chainSearch, dispatch]);
  useEffect(() => {
    if (!contract || abi.length) return;
    if (contract.origin === 'contract-type') {
      void apiClient.request('getContractTypeArtifact', { params: { pluginId: contract.pluginId, artifactKey: contract.artifactKey } }).then((response) => {
        if ('data' in response) setAbi(response.data.artifact.abi as unknown[]);
      });
      return;
    }
    void apiClient
      .request('getArtifactData', {
        body: {
          pathOrUrl: contract.repoPathOrUrl,
          pluginId: contract.frameworkId,
          artifactPath: contract.artifactPath,
          ...(contract.pin ? { pin: contract.pin } : {}),
        },
      })
      .then((response) => {
        if ('data' in response) setAbi(response.data.abi as unknown[]);
      });
  }, [abi.length, contract]);

  const numericChainId = Number(chainId);
  const explorerIds = selection[chainId] ?? [];
  const hasConstructor = constructorInputs(abi as never[]).length > 0;
  const chainOptions = useMemo(() => {
    const matchingChains =
      chainSearchResults === null
        ? chains
        : chains.filter((chain) => chainSearchResults.includes(chain.chainId));
    const selectedChain = chains.find(
      (chain) => String(chain.chainId) === chainId
    );
    const visibleChains =
      selectedChain && !matchingChains.includes(selectedChain)
        ? [selectedChain, ...matchingChains]
        : matchingChains;
    return visibleChains.map((chain) => ({
      value: String(chain.chainId),
      label: `${chain.name} (${chain.chainId})`,
    }));
  }, [chainId, chainSearchResults, chains]);
  const valid = Boolean(
    contract &&
    Number.isInteger(numericChainId) &&
    ADDRESS.test(address) &&
    explorerIds.length
  );

  const guess = async () => {
    if (
      !contract ||
      !ADDRESS.test(address) ||
      !Number.isInteger(numericChainId)
    )
      return;
    setGuessError(null);
    try {
      const response = await apiClient.request('guessConstructorArgs', {
        body: { contract, chainId: numericChainId, address },
      });
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
    const body = verificationSubmitBody({
      contract,
      chainId: numericChainId,
      address,
      args,
      encodedConstructorArgs: encodedTail,
      creationTxHash: creationTxHash || undefined,
      explorerEntryIds: explorerIds,
      ...(confirmUnverifiedProvenance ? { confirmUnverifiedProvenance: true as const } : {}),
    });
    try {
      const response = await apiClient.request('createVerification', { body });
      if (!('data' in response))
        throw new Error('Verification submission failed');
      dispatch(verificationTasksReceived(response.data.tasks));
      navigate('/deployments?manualVerification=1');
    } catch (cause) {
      if (cause instanceof ApiError && cause.body.code === 'UNVERIFIED_PROVENANCE_CONFIRMATION_REQUIRED') setRequiresProvenanceConfirmation(true);
      setError(submissionErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="text-[var(--text)] grid gap-4">
      <header>
        <h1 className="page-title mb-0">Verify a contract</h1>
        <p className="text-sm text-muted">
          Submit an existing deployment to selected explorers.
        </p>
      </header>
      <section className="card-milky p-4 grid gap-3">
        <h2 className="font-semibold">1. Contract</h2>
        <ArtifactPicker
          value={contract}
          onSelect={(next, nextAbi) => {
            setContract(next);
            setAbi(nextAbi as unknown[]);
            setArgs({});
            setEncodedTail(undefined);
          }}
        />
        {contract && (
          <p className="mono-data text-muted">
            {contract.origin === 'contract-type' ? contract.contractName : `${contract.sourcePath} · ${contract.contractName}`}
          </p>
        )}
        {requiresProvenanceConfirmation && <label className="flex gap-2 text-sm text-warn"><input type="checkbox" checked={confirmUnverifiedProvenance} onChange={(event) => setConfirmUnverifiedProvenance(event.target.checked)} />I understand this contract type’s source provenance is unverified and consent to submit it to the selected explorers.</label>}
      </section>
      <section className="card-milky p-4 grid gap-3">
        <h2 className="font-semibold">2. Chain + address</h2>
        <label className="input-glass flex items-center gap-2">
          <Search size={15} className="text-muted" />
          <input
            className="bg-transparent outline-none flex-1"
            value={chainSearch}
            onChange={(event) => setChainSearch(event.target.value)}
            placeholder="Search chains, including testnets"
          />
        </label>
        <Select
          options={chainOptions}
          value={chainId}
          placeholder="Select chain"
          onValueChange={setChainId}
        />
        <input
          className="input-glass"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="0x contract address"
        />
        {address && !ADDRESS.test(address) && (
          <p className="text-sm text-err">Enter a valid EVM address.</p>
        )}
        <input
          className="input-glass"
          value={creationTxHash}
          onChange={(event) => setCreationTxHash(event.target.value)}
          placeholder="Creation transaction hash (optional)"
        />
      </section>
      {chainId && (
        <section className="card-milky p-4 grid gap-3">
          <h2 className="font-semibold">3. Explorers</h2>
          <ExplorerMultiSelect
            chainIds={[numericChainId]}
            selection={selection}
            onSelectionChange={setSelection}
          />
        </section>
      )}
      {hasConstructor && (
        <section className="card-milky p-4 grid gap-3">
          <div className="flex justify-between gap-2">
            <h2 className="font-semibold">4. Constructor arguments</h2>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void guess()}
              disabled={!contract || !ADDRESS.test(address)}
            >
              Guess from creation tx
            </button>
          </div>
          {guessError && <p className="text-sm text-err">{guessError}</p>}
          <ConstructorArgsForm
            abi={abi as never[]}
            value={args}
            onChange={(next) => {
              setArgs(next);
              setEncodedTail(undefined);
            }}
          />
        </section>
      )}
      {error && <p className="text-err">{error}</p>}
      <button
        type="button"
        className="btn btn-primary justify-self-end"
        disabled={!valid || submitting}
        onClick={() => void submit()}
      >
        Submit verification
      </button>
    </div>
  );
}
