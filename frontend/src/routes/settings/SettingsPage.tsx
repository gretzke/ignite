import { useLocation, useNavigate } from 'react-router-dom';
import * as Tabs from '@radix-ui/react-tabs';
import { SlidersHorizontal, Users, Plug, Network } from 'lucide-react';
import GeneralTab from './tabs/general/GeneralTab';
import ProfilesTab from './tabs/profiles/ProfilesTab';
import PluginsTab from './tabs/plugins/PluginsTab';
import ChainsTab from './tabs/chains/ChainsTab';

export default function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const hash = (location.hash || '').toLowerCase();
  const activeTab: 'general' | 'profiles' | 'plugins' | 'chains' =
    hash === '#profiles'
      ? 'profiles'
      : hash === '#plugins'
        ? 'plugins'
        : hash === '#chains'
          ? 'chains'
          : 'general';
  const onTabChange = (value: string) => {
    if (value === 'general') navigate('/settings');
    else navigate(`/settings#${value}`);
  };
  return (
    <div className="text-[var(--text)]">
      <h2 className="page-title">Settings</h2>
      <Tabs.Root value={activeTab} onValueChange={onTabChange}>
        <Tabs.List aria-label="Settings sections" className="tabs-list">
          <Tabs.Trigger value="general" className="tabs-trigger">
            <SlidersHorizontal size={14} />
            General
          </Tabs.Trigger>
          <Tabs.Trigger value="profiles" className="tabs-trigger">
            <Users size={14} />
            Profiles
          </Tabs.Trigger>
          <Tabs.Trigger value="chains" className="tabs-trigger">
            <Network size={14} />
            Chains
          </Tabs.Trigger>
          <Tabs.Trigger value="plugins" className="tabs-trigger">
            <Plug size={14} />
            Plugins
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="general">
          <GeneralTab />
        </Tabs.Content>
        <Tabs.Content value="profiles">
          <ProfilesTab />
        </Tabs.Content>
        <Tabs.Content value="chains">
          <ChainsTab />
        </Tabs.Content>
        <Tabs.Content value="plugins">
          <PluginsTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
