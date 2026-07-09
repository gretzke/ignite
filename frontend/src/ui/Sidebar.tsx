import Tooltip from '../components/Tooltip';
import {
  Folder,
  Settings as IconSettings,
  ChevronsLeft,
  ChevronsRight,
  Send,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { setSidebarCollapsed } from '../store/features/app/appSlice';

const NAV_ITEMS = [
  { to: '/repositories', label: 'Repositories', Icon: Folder },
  { to: '/dev/send', label: 'Dev Send', Icon: Send },
] as const;

function navClass({ isActive }: { isActive: boolean }) {
  return `btn btn-secondary btn-secondary-borderless nav-item${
    isActive ? ' active' : ''
  }`;
}

export default function Sidebar() {
  const dispatch = useAppDispatch();
  const collapsed = useAppSelector((s) => s.app.sidebarCollapsed);
  const onToggle = () => dispatch(setSidebarCollapsed(!collapsed));
  return (
    <aside
      className={`glass-surface glass-sidebar ${collapsed ? 'collapsed' : ''}`}
    >
      <div className="nav-list">
        {NAV_ITEMS.map(({ to, label, Icon }) => {
          const link = (
            <NavLink key={to} to={to} className={navClass}>
              <Icon size={18} />
              <span className="nav-label">{label}</span>
            </NavLink>
          );
          return collapsed ? (
            <Tooltip key={to} label={label} placement="right">
              {link}
            </Tooltip>
          ) : (
            link
          );
        })}
      </div>
      <div className="flex flex-col gap-2">
        {collapsed ? (
          <>
            <Tooltip label="Settings" placement="right">
              <NavLink
                to="/settings"
                className={(s) => `${navClass(s)} btn-block`}
              >
                <IconSettings size={18} />
              </NavLink>
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
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `btn btn-secondary nav-item nav-item-center${
                  isActive ? ' active' : ''
                }`
              }
              style={{ flex: 1 }}
            >
              <IconSettings size={18} />
              <span className="nav-label">Settings</span>
            </NavLink>
            <Tooltip label="Collapse" placement="top">
              <button
                type="button"
                className="btn btn-secondary"
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
