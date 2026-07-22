import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from 'react-router-dom';
import App from './App.tsx';
import { Provider } from 'react-redux';
import { store } from './store';
import SettingsPage from './routes/settings/SettingsPage';
import RepositoriesPage from './routes/repositories/RepositoriesPage';
import RepositoryPage from './routes/repositories/repository/RepositoryPage.tsx';
import FilePage from './routes/repositories/repository/file/FilePage.tsx';
import DeployWizardPage from './routes/deploy/DeployWizardPage.tsx';
import DeploymentsPage from './routes/deployments/DeploymentsPage.tsx';
import RunPage from './routes/deployments/RunPage.tsx';
import WorkflowsPage from './routes/workflows/WorkflowsPage.tsx';
import WorkflowEditorPage from './routes/workflows/edit/WorkflowEditorPage.tsx';
import VerifyContractPage from './routes/verify/VerifyContractPage.tsx';
import './index.css';
import { ToastProvider } from './ui/toast/ToastProvider';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <RepositoriesPage /> },
      { path: 'repositories', element: <RepositoriesPage /> },
      { path: 'repositories/:repoPath', element: <RepositoryPage /> },
      { path: 'repositories/:repoPath/file/*', element: <FilePage /> },
      { path: 'deploy', element: <DeployWizardPage /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      { path: 'workflows/edit', element: <WorkflowEditorPage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'deployments/:runId', element: <RunPage /> },
      { path: 'verify', element: <VerifyContractPage /> },
      { path: 'plugins', element: <Navigate to="/settings#plugins" replace /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </Provider>
  </React.StrictMode>
);
