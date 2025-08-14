import { useMemo, useState } from 'react';
import ProfileModal from './ProfileModal';
import { Plus, Trash2, Archive, Edit, RotateCcw } from 'lucide-react';
import Tooltip from '../../../../components/Tooltip';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import { useAppDispatch, useAppSelector } from '../../../../store';
import { profilesApi } from '../../../../store/features/profiles/profilesSlice';
import type { ProfileConfig } from '@ignite/api';

export default function ProfilesTab() {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<
    ProfileConfig | undefined
  >(undefined);
  const profiles = useAppSelector((s) => s.profiles.profiles);
  const currentId = useAppSelector((s) => s.profiles.currentId);
  const archived = useAppSelector((s) => s.profiles.archivedProfiles);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPayload, setConfirmPayload] = useState<{
    type: 'delete' | 'delete-archived';
    id: string;
    name: string;
  } | null>(null);

  const sorted = useMemo(
    () =>
      profiles.slice().sort((a, b) => {
        const ta = a.lastUsed ? Date.parse(a.lastUsed as unknown as string) : 0;
        const tb = b.lastUsed ? Date.parse(b.lastUsed as unknown as string) : 0;
        return tb - ta; // newest first
      }),
    [profiles]
  );

  const openCreateModal = () => {
    setEditingProfile(undefined);
    setOpen(true);
  };

  const openEditModal = (profile: ProfileConfig) => {
    setEditingProfile(profile);
    setOpen(true);
  };

  const handleCloseModal = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setEditingProfile(undefined);
    }
  };
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div></div>
        {!showArchived ? (
          <div className="flex items-center gap-2">
            <Tooltip label="View archived profiles" placement="top">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowArchived(true);
                  dispatch(profilesApi.fetchArchived());
                }}
              >
                Archive
              </button>
            </Tooltip>
            <Tooltip label="Add profile" placement="top">
              <button
                type="button"
                className="btn btn-primary"
                style={{
                  width: 40,
                  height: 36,
                  paddingLeft: 0,
                  paddingRight: 0,
                }}
                aria-label="Add profile"
                title="Add profile"
                onClick={openCreateModal}
              >
                <Plus size={16} />
              </button>
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowArchived(false)}
            >
              Profiles
            </button>
          </div>
        )}
      </div>
      <ProfileModal
        open={open}
        onOpenChange={handleCloseModal}
        profile={editingProfile}
        isCurrent={editingProfile?.id === currentId}
        onSave={(_data) => {
          setOpen(false);
        }}
      />
      {!showArchived && (
        <div className="mt-4 grid gap-2">
          {sorted.map((p) => (
            <div
              key={p.id}
              className="glass-surface nav-item flex items-center justify-between"
              style={{ padding: '0.9rem 1.1rem' }}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="profile-logo"
                  style={{
                    background: p.color,
                    width: 28,
                    height: 28,
                  }}
                >
                  <span style={{ fontSize: 14 }}>{p.icon || ''}</span>
                </span>
                <div className="flex items-center gap-2">
                  <span className="nav-label" style={{ fontWeight: 600 }}>
                    {p.name}
                  </span>
                  {currentId === p.id && (
                    <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
                      Current
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {currentId !== p.id && (
                  <>
                    <Tooltip label="Delete profile" placement="top">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        style={{ width: 32, height: 32, padding: 0 }}
                        aria-label="Delete profile"
                        onClick={() => {
                          setConfirmPayload({
                            type: 'delete',
                            id: p.id,
                            name: p.name,
                          });
                          setConfirmOpen(true);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Archive profile" placement="top">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ width: 32, height: 32, padding: 0 }}
                        aria-label="Archive profile"
                        onClick={() =>
                          dispatch(profilesApi.archiveProfile(p.id))
                        }
                      >
                        <Archive size={14} />
                      </button>
                    </Tooltip>
                  </>
                )}
                <Tooltip label="Edit profile" placement="top">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ width: 32, height: 32, padding: 0 }}
                    aria-label="Edit profile"
                    onClick={() => openEditModal(p)}
                  >
                    <Edit size={14} />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}

      {showArchived && (
        <div className="mt-4 grid gap-2">
          {archived.length === 0 ? (
            <div className="opacity-60 text-sm">No archived profiles</div>
          ) : (
            archived.map((p) => (
              <div
                key={p.id}
                className="glass-surface nav-item flex items-center justify-between"
                style={{ padding: '0.9rem 1.1rem' }}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="profile-logo"
                    style={{ background: p.color, width: 28, height: 28 }}
                  >
                    <span style={{ fontSize: 14 }}>{p.icon || ''}</span>
                  </span>
                  <span className="nav-label" style={{ fontWeight: 600 }}>
                    {p.name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Tooltip label="Delete permanently" placement="top">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      style={{ width: 32, height: 32, padding: 0 }}
                      aria-label="Delete archived profile"
                      onClick={() => {
                        setConfirmPayload({
                          type: 'delete-archived',
                          id: p.id,
                          name: p.name,
                        });
                        setConfirmOpen(true);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Restore profile" placement="top">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ width: 32, height: 32, padding: 0 }}
                      aria-label="Restore profile"
                      onClick={() => dispatch(profilesApi.restoreProfile(p.id))}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          confirmPayload?.type === 'delete-archived'
            ? 'Delete archived profile?'
            : 'Delete profile?'
        }
        description={
          confirmPayload ? (
            confirmPayload.type === 'delete-archived' ? (
              <>
                Permanently delete <strong>{confirmPayload.name}</strong>? This
                cannot be undone.
              </>
            ) : (
              <>
                Delete profile <strong>{confirmPayload.name}</strong>? This
                action cannot be undone.
              </>
            )
          ) : null
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        confirmVariant="danger"
        onConfirm={() => {
          if (!confirmPayload) return;
          dispatch(profilesApi.deleteProfile(confirmPayload.id));
        }}
      />
    </div>
  );
}
