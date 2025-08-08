import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App.tsx';
import SettingsPage from './routes/SettingsPage';
import RepositoriesPage from './routes/RepositoriesPage';
import WorkflowsPage from './routes/WorkflowsPage';
import DeploymentsPage from './routes/DeploymentsPage';
import './index.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <RepositoriesPage /> },
      { path: 'repositories', element: <RepositoriesPage /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
