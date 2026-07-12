import Tooltip from '../components/Tooltip';
import {
  Folder,
  Settings as IconSettings,
  ChevronsLeft,
  ChevronsRight,
  Rocket,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { setSidebarCollapsed } from '../store/features/app/appSlice';

function navClass({ isActive }: { isActive: boolean }) {
  return `btn btn-secondary btn-secondary-borderless nav-item${
    isActive ? ' active' : ''
  }`;
}

export default function Sidebar() {
  const dispatch = useAppDispatch();
  const collapsed = useAppSelector((s) => s.app.sidebarCollapsed);
  const draftActive = useAppSelector(
    (s) => s.deployDraft.contracts.length > 0
  );
  const unseenCount = useAppSelector((s) => s.deployDraft.unseenIds.length);
  const location = useLocation();
  // '/deploy' is a prefix of '/deployments', so one check covers the wizard,
  // the runs list, and individual runs.
  const deploymentsActive = location.pathname.startsWith('/deploy');
  const navItems = [
    {
      to: '/repositories',
      label: 'Repositories',
      Icon: Folder,
      badge: 0,
      forceActive: undefined as boolean | undefined,
    },
    {
      // An active deployment makes the tab jump straight into the wizard.
      to: draftActive ? '/deploy' : '/deployments',
      label: 'Deployments',
      Icon: Rocket,
      badge: unseenCount,
      forceActive: deploymentsActive,
    },
  ];
  const onToggle = () => dispatch(setSidebarCollapsed(!collapsed));
  return (
    <aside
      className={`glass-surface glass-sidebar ${collapsed ? 'collapsed' : ''}`}
    >
      <div className="nav-list">
        {navItems.map(({ to, label, Icon, badge, forceActive }) => {
          const link = (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                navClass({ isActive: forceActive ?? isActive })
              }
            >
              <Icon size={18} />
              <span className="nav-label">{label}</span>
              {badge > 0 && <span className="nav-badge">{badge}</span>}
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
