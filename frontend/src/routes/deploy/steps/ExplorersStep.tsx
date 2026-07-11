import { useCallback } from 'react';
import ExplorerMultiSelect from './ExplorerMultiSelect';
import { useAppDispatch, useAppSelector } from '../../../store';
import { setExplorerSelection } from '../../../store/features/deployments/deployDraftSlice';

export default function ExplorersStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const update = useCallback(
    (explorerSelection: Record<string, string[]>) =>
      dispatch(setExplorerSelection(explorerSelection)),
    [dispatch]
  );

  return (
    <section className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold">Explorers</h2>
        <p className="text-sm text-muted">
          Optionally verify deployed contracts on an explorer for each chain.
        </p>
      </div>
      <ExplorerMultiSelect
        chainIds={draft.chains}
        selection={draft.explorerSelection}
        onSelectionChange={update}
      />
    </section>
  );
}
