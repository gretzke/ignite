import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import { HexColorPicker, HexColorInput } from 'react-colorful';
import Tooltip from '../../../../components/Tooltip';
import Switch from '../../../../components/Switch';
import { COLOR_OPTIONS } from '../../../../store/features/app/appSlice';
import { useAppDispatch } from '../../../../store';
import { profilesApi } from '../../../../store/features/profiles/profilesSlice';
import type { ProfileConfig } from '@ignite/api';

interface ProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile?: ProfileConfig; // Optional: if provided, we're editing; if not, we're creating
  isCurrent?: boolean; // Whether the edited profile is the active one
  onSave: (data: {
    name: string;
    colorHex: string;
    emoji?: string;
    letter?: string;
  }) => void;
}

export default function ProfileModal({
  open,
  onOpenChange,
  profile,
  isCurrent = false,
  onSave,
}: ProfileModalProps) {
  const dispatch = useAppDispatch();
  const [name, setName] = useState('');
  const defaultColor = useMemo(() => {
    return COLOR_OPTIONS[0]?.hex;
  }, []);
  const [colorHex, setColorHex] = useState<string>(defaultColor);
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [letter, setLetter] = useState<string>('');
  const [hydrated, setHydrated] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const originalColorRef = useRef<string | null>(null);
  const rootElRef = useRef<HTMLElement | null>(null);
  const docElRef = useRef<HTMLElement | null>(null);
  const previewActiveRef = useRef<boolean>(false);
  const originalDarkRef = useRef<boolean | null>(null);
  const originalRootDarkRef = useRef<boolean | null>(null);
  const darkPreviewActiveRef = useRef<boolean>(false);
  const [darkPreview, setDarkPreview] = useState(false);
  const pickerOriginalColorRef = useRef<string | null>(null);
  const wasCustomOpenRef = useRef<boolean>(false);
  const wasSavedRef = useRef<boolean>(false);

  // Color select helper: marks preview active and updates local color
  function handleSelectColor(hex: string) {
    previewActiveRef.current = true;
    setColorHex(hex);
  }

  // Find the app root element that carries the --profile-color variable
  useEffect(() => {
    rootElRef.current = document.querySelector(
      '[data-anim][data-shapes]'
    ) as HTMLElement | null;
    docElRef.current = document.documentElement;
  }, []);

  // Manage preview lifecycle: on open capture original and sync local state; on close revert
  useEffect(() => {
    if (!open) return;

    // Capture original persisted color
    try {
      const stored = window.localStorage.getItem('ignite:color');
      originalColorRef.current =
        typeof stored === 'string' && stored.trim().length > 0
          ? stored
          : defaultColor;
    } catch {
      originalColorRef.current = defaultColor;
    }
  }, [open, defaultColor]);

  // Separate effect for theme setup
  useEffect(() => {
    if (open) {
      // Capture original theme on main modal open
      const isDark = document.documentElement.classList.contains('theme-dark');
      originalDarkRef.current = isDark;
      originalRootDarkRef.current = rootElRef.current
        ? rootElRef.current.classList.contains('theme-dark')
        : null;
      setDarkPreview(isDark);
    }
  }, [open]);

  // Separate effect for form initialization to avoid timing issues
  // Use layout effect so state is set before paint to avoid flashing defaults
  useLayoutEffect(() => {
    if (!open) return;

    setHydrated(false);
    wasSavedRef.current = false; // Reset save status when modal opens

    // Initialize form fields based on mode (create vs edit)
    if (profile) {
      // Edit mode: populate fields from existing profile
      setName(profile.name);
      setColorHex(profile.color);
      // Parse icon: could be emoji or single letter
      const icon = profile.icon || '';
      if (icon && icon.length === 1 && /^[a-zA-Z]$/.test(icon)) {
        setLetter(icon);
        setEmoji(undefined);
      } else {
        setEmoji(icon || undefined);
        setLetter('');
      }
      // Preview the profile's color
      previewActiveRef.current = true;
      if (rootElRef.current) {
        rootElRef.current.style.setProperty('--profile-color', profile.color);
      }
      if (docElRef.current) {
        docElRef.current.style.setProperty('--profile-color', profile.color);
      }
    } else {
      // Create mode: use default values
      setName('');
      setEmoji(undefined);
      setLetter('');
      setColorHex(defaultColor);
      // Immediately preview default color on open
      previewActiveRef.current = true;
      if (rootElRef.current) {
        rootElRef.current.style.setProperty('--profile-color', defaultColor);
      }
      if (docElRef.current) {
        docElRef.current.style.setProperty('--profile-color', defaultColor);
      }
    }
    setHydrated(true);
  }, [open, profile, defaultColor]);

  // Cleanup effect for when modal closes
  useEffect(() => {
    if (!open) {
      setHydrated(false);
      // Revert preview when modal closes, unless we're editing the current profile and saved
      // The uiEffects middleware will handle updating the app color when the profile updates
      if (!isCurrent || !wasSavedRef.current) {
        const targetColor = originalColorRef.current;
        if (targetColor) {
          if (rootElRef.current) {
            rootElRef.current.style.setProperty('--profile-color', targetColor);
          }
          if (docElRef.current) {
            docElRef.current.style.setProperty('--profile-color', targetColor);
          }
        }
      }
      // Revert theme if dark preview was applied
      if (docElRef.current && originalDarkRef.current !== null) {
        const isOrigDark = originalDarkRef.current;
        docElRef.current.classList.toggle('theme-dark', isOrigDark);
        docElRef.current.classList.toggle('theme-light', !isOrigDark);
      }
      if (rootElRef.current && originalRootDarkRef.current !== null) {
        const isOrigRootDark = originalRootDarkRef.current;
        rootElRef.current.classList.toggle('theme-dark', isOrigRootDark);
        rootElRef.current.classList.toggle('theme-light', !isOrigRootDark);
      }
      // Reset all modal-local state so it opens fresh next time
      setName('');
      setEmoji(undefined);
      setLetter('');
      setPickerKey((k) => k + 1);
      setCustomOpen(false);
      previewActiveRef.current = false;
      setColorHex(defaultColor);
      darkPreviewActiveRef.current = false;
      setDarkPreview(false);
      wasSavedRef.current = false;
    }
    // Only handle theme cleanup on unmount - let uiEffects handle color persistence
    return () => {
      // Ensure theme is restored
      if (!open && docElRef.current && originalDarkRef.current !== null) {
        const isOrigDark = originalDarkRef.current;
        docElRef.current.classList.toggle('theme-dark', isOrigDark);
        docElRef.current.classList.toggle('theme-light', !isOrigDark);
      }
      if (!open && rootElRef.current && originalRootDarkRef.current !== null) {
        const isOrigRootDark = originalRootDarkRef.current;
        rootElRef.current.classList.toggle('theme-dark', isOrigRootDark);
        rootElRef.current.classList.toggle('theme-light', !isOrigRootDark);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile]);

  // Apply live preview while the modal is open
  useEffect(() => {
    if (!open) return;
    if (!previewActiveRef.current) return;
    if (!rootElRef.current) return;
    if (typeof colorHex === 'string' && colorHex) {
      rootElRef.current.style.setProperty('--profile-color', colorHex);
      if (docElRef.current) {
        docElRef.current.style.setProperty('--profile-color', colorHex);
      }
    }
  }, [open, colorHex]);

  // Handle open/close of custom color picker: initialize switch only; do not restore theme here
  useEffect(() => {
    if (customOpen && !wasCustomOpenRef.current) {
      const isDark = document.documentElement.classList.contains('theme-dark');
      darkPreviewActiveRef.current = false;
      setDarkPreview(isDark);
      // Capture color when picker opens (for Close revert)
      pickerOriginalColorRef.current = colorHex;
    }
    wasCustomOpenRef.current = customOpen;
    // No-op on close: keep dark preview active until main modal closes
  }, [customOpen, colorHex]);

  function handleToggleDark(next: boolean) {
    setDarkPreview(next);
    darkPreviewActiveRef.current = true;
    if (docElRef.current) {
      docElRef.current.classList.toggle('theme-dark', next);
      docElRef.current.classList.toggle('theme-light', !next);
    }
    if (rootElRef.current) {
      rootElRef.current.classList.toggle('theme-dark', next);
      rootElRef.current.classList.toggle('theme-light', !next);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-surface"
          style={{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            maxWidth: '90vw',
            padding: 16,
          }}
        >
          <Dialog.Title className="text-base font-semibold mb-3">
            {profile ? 'Edit Profile' : 'New Profile'}
          </Dialog.Title>

          {/* avatar + name */}
          <div
            className="mb-4"
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gridTemplateRows: 'auto auto',
              columnGap: 12,
              rowGap: 6,
              alignItems: 'center',
            }}
          >
            {hydrated && (
              <span
                aria-hidden
                className="profile-logo"
                style={{
                  background: colorHex,
                  width: 44,
                  height: 44,
                  gridColumn: '1 / 2',
                  gridRow: '2 / 3',
                }}
              >
                {letter || emoji || ''}
              </span>
            )}
            <input
              id="profile-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-glass"
              style={{
                gridColumn: '2 / 3',
                gridRow: '2 / 3',
              }}
              placeholder="Enter profile name"
            />
          </div>

          {/* color / emoji / letter */}
          <div className="mb-4">
            <div className="text-sm opacity-70 mb-2">Color</div>

            {/* OUTER: width defined ONLY by row-1 */}
            <div style={{ display: 'inline-block', maxWidth: '100%' }}>
              {/* ROW 1: defines total width */}
              <div
                style={{
                  display: 'inline-flex',
                  gap: 8,
                  flexWrap: 'nowrap',
                  whiteSpace: 'nowrap',
                }}
              >
                {COLOR_OPTIONS.map(({ hex, title }) => {
                  const selected = hex.toLowerCase() === colorHex.toLowerCase();
                  return (
                    <Tooltip key={hex} label={title} placement="top">
                      <button
                        type="button"
                        onClick={() => handleSelectColor(hex)}
                        className={`rounded-full transition-transform focus:outline-none ${
                          selected ? 'ring-2 ring-white/80 scale-[1.02]' : ''
                        }`}
                        style={{ width: 36, height: 36, cursor: 'pointer' }}
                        aria-label={`Select ${title}`}
                        title={title}
                      >
                        <span
                          aria-hidden
                          style={{
                            background: hex,
                            width: 36,
                            height: 36,
                            borderRadius: 9999,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: '1px solid rgba(255,255,255,0.4)',
                          }}
                        />
                      </button>
                    </Tooltip>
                  );
                })}
                <button
                  type="button"
                  className="btn btn-secondary btn-secondary-borderless"
                  onClick={() => setCustomOpen(true)}
                  style={{ height: 36, lineHeight: '36px', padding: '0 10px' }}
                >
                  Custom
                </button>
              </div>

              {/* ROW 2: does NOT affect intrinsic width; fills row-1 width */}
              <div
                style={{
                  contain: 'inline-size', // key: row-2 can't widen parent
                  display: 'grid',
                  gridTemplateColumns: 'max-content minmax(0,1fr)',
                  columnGap: 12,
                  rowGap: 8,
                  width: '100%',
                  marginTop: 8,
                  alignItems: 'start',
                }}
              >
                <div>
                  <div className="text-sm opacity-70 mb-2">Emoji</div>
                  <div style={{ display: 'inline-block' }}>
                    <EmojiPicker
                      key={pickerKey}
                      theme={darkPreview ? Theme.DARK : Theme.LIGHT}
                      reactionsDefaultOpen
                      onReactionClick={(e) => {
                        setEmoji(e.emoji);
                        setLetter('');
                        setPickerKey((k) => k + 1);
                      }}
                      onEmojiClick={(e) => {
                        setEmoji(e.emoji);
                        setLetter('');
                        setPickerKey((k) => k + 1);
                      }}
                      previewConfig={{ showPreview: false }}
                      reactions={[
                        '1f6e0-fe0f',
                        '1f680',
                        '2764-fe0f',
                        '2699-fe0f',
                        '1f9e0',
                        '1f525',
                        '1f984',
                      ]}
                    />
                  </div>
                </div>

                <div style={{ minWidth: 0 }}>
                  <div className="text-sm opacity-70 mb-2">Letter</div>
                  <input
                    id="profile-letter"
                    type="text"
                    value={letter}
                    onKeyDown={(e) => {
                      if (
                        e.key.length === 1 &&
                        !e.metaKey &&
                        !e.ctrlKey &&
                        !e.altKey
                      ) {
                        const ch = e.key.trim().slice(0, 1);
                        if (ch) {
                          setLetter(ch);
                          setEmoji(undefined);
                        }
                        e.preventDefault();
                      } else if (e.key === 'Backspace' || e.key === 'Delete') {
                        setLetter('');
                        e.preventDefault();
                      }
                    }}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      const ch = v.slice(-1);
                      setLetter(ch);
                      if (ch) setEmoji(undefined);
                    }}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text').trim();
                      const ch = text.slice(0, 1);
                      setLetter(ch);
                      if (ch) setEmoji(undefined);
                      e.preventDefault();
                    }}
                    className="input-glass"
                    maxLength={1}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const icon =
                    (emoji && emoji.trim()) || (letter && letter.trim()) || '';

                  wasSavedRef.current = true; // Mark as saved

                  if (profile) {
                    // Edit mode: update existing profile
                    dispatch(
                      profilesApi.updateProfile({
                        id: profile.id,
                        name: name.trim(),
                        color: colorHex,
                        icon,
                      })
                    );
                  } else {
                    // Create mode: create new profile
                    dispatch(
                      profilesApi.createProfile({
                        name: name.trim(),
                        color: colorHex,
                        icon,
                      })
                    );
                  }

                  onSave({
                    name,
                    colorHex,
                    emoji,
                    letter: letter || undefined,
                  });
                }}
                disabled={!name.trim()}
              >
                {profile ? 'Update' : 'Save'}
              </button>
            </Dialog.Close>
          </div>

          {/* Custom color picker dialog */}
          <Dialog.Root open={customOpen} onOpenChange={setCustomOpen}>
            <Dialog.Portal>
              <Dialog.Overlay
                className="dialog-overlay"
                style={{ background: 'transparent', zIndex: 1002 }}
              />
              <Dialog.Content
                className="dialog-content glass-surface"
                style={{
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  padding: 16,
                  zIndex: 1003,
                }}
              >
                <div className="text-sm opacity-80 mb-2">
                  Pick a custom color
                </div>
                <div style={{ maxWidth: 240 }}>
                  <HexColorPicker
                    color={colorHex}
                    onChange={(c) => handleSelectColor(c)}
                  />
                </div>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <span className="text-sm">Hex</span>
                  <HexColorInput
                    color={colorHex}
                    onChange={(c) => handleSelectColor(c)}
                    className="card-milky"
                    style={{
                      padding: '8px 10px',
                      width: 140,
                      textAlign: 'center',
                    }}
                    prefixed
                  />
                </div>
                <div className="mt-3 flex items-center justify-center">
                  <Switch
                    label="Dark Mode Preview"
                    checked={darkPreview}
                    onCheckedChange={handleToggleDark}
                  />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        const orig = pickerOriginalColorRef.current;
                        if (orig) {
                          setColorHex(orig);
                          if (rootElRef.current) {
                            rootElRef.current.style.setProperty(
                              '--profile-color',
                              orig
                            );
                          }
                          if (docElRef.current) {
                            docElRef.current.style.setProperty(
                              '--profile-color',
                              orig
                            );
                          }
                        }
                      }}
                    >
                      Close
                    </button>
                  </Dialog.Close>
                  <Dialog.Close asChild>
                    <button type="button" className="btn btn-primary">
                      Apply
                    </button>
                  </Dialog.Close>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
