import { useState } from 'react';
import ProfileModal from './ProfileModal';

export default function ProfilesTab() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div></div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setOpen(true)}
        >
          New Profile
        </button>
      </div>
      <ProfileModal
        open={open}
        onOpenChange={setOpen}
        onSave={(data) => {
          // TODO: integrate with profiles store when available
          setOpen(false);
          console.log('save profile', data);
        }}
      />
    </div>
  );
}
