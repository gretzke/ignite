import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../../../store';
import {
  setShowDetails,
  setTheme,
} from '../../../../store/features/app/appSlice';
import Switch from '../../../../components/Switch';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import { apiClient } from '../../../../store/api/client';
import { triggerToast } from '../../../../store/middleware/toastListener';
import { formatApiError } from '../../../../store/middleware/apiGate';

export default function GeneralTab() {
  const dispatch = useAppDispatch();
  const showDetails = useAppSelector((s) => s.app.showDetails);
  const darkMode = useAppSelector((s) => s.app.theme) === 'dark';
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const runFactoryReset = () => {
    setResetting(true);
    dispatch(
      apiClient.dispatch.factoryReset({
        onSuccess: () => {
          // The backend re-bootstrapped from scratch; reload so every slice
          // rehydrates against the fresh installation state.
          window.location.reload();
          return [];
        },
        onError: (error) => {
          setResetting(false);
          const { description } = formatApiError(error);
          return triggerToast({
            title: 'Factory Reset Failed',
            description,
            variant: 'error',
            duration: 8000,
          });
        },
      })
    );
  };

  return (
    <div>
      <div className="text-sm opacity-70 mb-2">UI</div>
      <div className="flex flex-col gap-4 mb-3">
        <div className="flex items-center justify-between">
          <div className="text-base font-medium">Dark Mode</div>
          <Switch
            checked={darkMode}
            onCheckedChange={(v) => dispatch(setTheme(v ? 'dark' : 'light'))}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-base font-medium">Show Details</div>
          <Switch
            checked={showDetails}
            onCheckedChange={(v) => dispatch(setShowDetails(v))}
          />
        </div>
      </div>

      <div className="text-sm opacity-70 mb-2 mt-8">Danger Zone</div>
      <div className="flex items-center justify-between gap-6">
        <div>
          <div className="text-base font-medium">Factory Reset</div>
          <div className="text-sm opacity-70">
            Wipe all profiles, repositories, trust grants, installed plugins,
            and jobs, and restart with a fresh installation. Local repositories
            on disk are not touched.
          </div>
        </div>
        <button
          className="btn btn-danger shrink-0"
          disabled={resetting}
          onClick={() => setResetOpen(true)}
        >
          {resetting ? 'Resetting…' : 'Factory Reset'}
        </button>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Factory reset Ignite?"
        description="This permanently deletes every profile, saved repository, cloned workspace, trust decision, and installed plugin, then restarts from a clean state. Local repositories on your disk are not modified. This cannot be undone."
        confirmText="Reset everything"
        variant="danger"
        onConfirm={runFactoryReset}
      />
    </div>
  );
}
