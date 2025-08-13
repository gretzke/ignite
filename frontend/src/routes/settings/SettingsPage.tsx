import { useLocation, useNavigate } from 'react-router-dom';
import * as Tabs from '@radix-ui/react-tabs';
import GeneralTab from './tabs/general/GeneralTab';
import ProfilesTab from './tabs/profiles/ProfilesTab';

export default function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const hash = (location.hash || '').toLowerCase();
  const activeTab: 'general' | 'profiles' =
    hash === '#profiles' ? 'profiles' : 'general';
  const onTabChange = (value: string) => {
    if (value === 'profiles') navigate('/settings#profiles');
    else navigate('/settings');
  };
  return (
    <div className="text-[var(--text)]">
      <h2 className="page-title">Settings</h2>
      <Tabs.Root value={activeTab} onValueChange={onTabChange}>
        <Tabs.List aria-label="Settings sections" className="tabs-list">
          <Tabs.Trigger value="general" className="tabs-trigger">
            General
          </Tabs.Trigger>
          <Tabs.Trigger value="profiles" className="tabs-trigger">
            Profiles
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="general">
          <GeneralTab />
        </Tabs.Content>
        <Tabs.Content value="profiles">
          <ProfilesTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
