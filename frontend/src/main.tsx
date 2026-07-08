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
