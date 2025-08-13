import Tooltip from '../components/Tooltip';
import {
  Folder,
  Puzzle,
  Rocket,
  Settings as IconSettings,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { setSidebarCollapsed } from '../store/features/app/appSlice';

export default function Sidebar() {
  const dispatch = useAppDispatch();
  const collapsed = useAppSelector((s) => s.app.sidebarCollapsed);
  const onToggle = () => dispatch(setSidebarCollapsed(!collapsed));
  return (
    <aside
      className={`glass-surface glass-sidebar ${collapsed ? 'collapsed' : ''}`}
    >
      <div className="nav-list">
        {collapsed ? (
          <Tooltip label="Repositories" placement="right">
            <Link
              to="/repositories"
              className="btn btn-secondary btn-secondary-borderless nav-item"
            >
              <Folder size={18} />
              <span className="nav-label">Repositories</span>
            </Link>
          </Tooltip>
        ) : (
          <Link
            to="/repositories"
            className="btn btn-secondary btn-secondary-borderless nav-item"
          >
            <Folder size={18} />
            <span className="nav-label">Repositories</span>
          </Link>
        )}

        {collapsed ? (
          <Tooltip label="Workflows" placement="right">
            <Link
              to="/workflows"
              className="btn btn-secondary btn-secondary-borderless nav-item"
            >
              <Puzzle size={18} />
              <span className="nav-label">Workflows</span>
            </Link>
          </Tooltip>
        ) : (
          <Link
            to="/workflows"
            className="btn btn-secondary btn-secondary-borderless nav-item"
          >
            <Puzzle size={18} />
            <span className="nav-label">Workflows</span>
          </Link>
        )}

        {collapsed ? (
          <Tooltip label="Deployments" placement="right">
            <Link
              to="/deployments"
              className="btn btn-secondary btn-secondary-borderless nav-item"
            >
              <Rocket size={18} />
              <span className="nav-label">Deployments</span>
            </Link>
          </Tooltip>
        ) : (
          <Link
            to="/deployments"
            className="btn btn-secondary btn-secondary-borderless nav-item"
          >
            <Rocket size={18} />
            <span className="nav-label">Deployments</span>
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {collapsed ? (
          <>
            <Tooltip label="Settings" placement="right">
              <Link
                to="/settings"
                className="btn btn-secondary btn-secondary-borderless btn-block nav-item"
              >
                <IconSettings size={18} />
              </Link>
            </Tooltip>
            <Tooltip label="Expand" placement="right">
              <button
                type="button"
                className="btn btn-secondary btn-secondary-borderless btn-block"
                onClick={onToggle}
              >
                <ChevronsRight size={18} />
              </button>
            </Tooltip>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              to="/settings"
              className="btn btn-secondary btn-secondary-borderless nav-item nav-item-center"
              style={{ flex: 1 }}
            >
              <IconSettings size={18} />
              <span className="nav-label">Settings</span>
            </Link>
            <Tooltip label="Collapse" placement="top">
              <button
                type="button"
                className="btn btn-secondary btn-secondary-borderless"
                style={{ width: 44, paddingLeft: 0, paddingRight: 0 }}
                onClick={onToggle}
              >
                <ChevronsLeft size={18} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    </aside>
  );
}
