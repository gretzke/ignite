import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ProfileConfig } from '@ignite/api';
import { apiClient } from '../../api/client';

export interface IProfilesState {
  profiles: ProfileConfig[];
  currentId: string | null;
  archivedProfiles: ProfileConfig[];
}

const initialState: IProfilesState = {
  profiles: [],
  currentId: null,
  archivedProfiles: [],
};

const profilesSlice = createSlice({
  name: 'profiles',
  initialState,
  reducers: {
    fetchProfilesSucceeded(
      state,
      action: PayloadAction<{ profiles: ProfileConfig[]; currentId: string }>
    ) {
      state.profiles = action.payload.profiles;
      state.currentId = action.payload.currentId;
    },
    fetchProfilesFailed(_state, _action: PayloadAction<string>) {},
    setCurrentProfile(state, action: PayloadAction<string>) {
      state.currentId = action.payload;
    },
    fetchArchivedSucceeded(
      state,
      action: PayloadAction<{ profiles: ProfileConfig[] }>
    ) {
      state.archivedProfiles = action.payload.profiles;
    },
    fetchArchivedFailed(_state, _action: PayloadAction<string>) {},
  },
});

export const {
  fetchProfilesSucceeded,
  fetchProfilesFailed,
  setCurrentProfile,
  fetchArchivedSucceeded,
  fetchArchivedFailed,
} = profilesSlice.actions;

export const profilesReducer = profilesSlice.reducer;

// Enhanced API actions using the typed client
// These return actions that work with your connection gating middleware
export const profilesApi = {
  // Fetch all profiles
  fetchProfiles: () =>
    apiClient.dispatch.listProfiles({
      onSuccess: (data) => {
        return fetchProfilesSucceeded(data);
      },
      onError: (error) => fetchProfilesFailed(error.message),
    }),

  // Switch to a specific profile
  switchProfile: (profileId: string) =>
    apiClient.dispatch.switchProfile({
      params: { id: profileId },
      onSuccess: () => {
        // Immediately update current profile and refresh list to get updated lastUsed values
        return [
          setCurrentProfile(profileId),
          apiClient.dispatch.listProfiles({
            onSuccess: (data) => fetchProfilesSucceeded(data),
            onError: (error) => fetchProfilesFailed(error.message),
          }),
        ];
      },
      onError: (error) =>
        fetchProfilesFailed(`Failed to switch profile: ${error.message}`),
    }),

  // Create a new profile
  createProfile: (profileData: {
    name: string;
    color?: string;
    icon?: string;
  }) =>
    apiClient.dispatch.createProfile({
      body: profileData,
      onSuccess: () => {
        // After successful creation, refetch profiles
        return apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: (error) => fetchProfilesFailed(error.message),
        });
      },
      onError: (error) =>
        fetchProfilesFailed(`Failed to create profile: ${error.message}`),
    }),

  // Update an existing profile
  updateProfile: (profileData: {
    id: string;
    name?: string;
    color?: string;
    icon?: string;
  }) =>
    apiClient.dispatch.updateProfile({
      body: profileData,
      onSuccess: () => {
        // Refresh list to reflect updated properties and sorting
        return apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: (error) => fetchProfilesFailed(error.message),
        });
      },
      onError: (error) =>
        fetchProfilesFailed(`Failed to update profile: ${error.message}`),
    }),

  // Delete an existing profile
  deleteProfile: (profileId: string) =>
    apiClient.dispatch.deleteProfile({
      params: { id: profileId },
      onSuccess: () => [
        apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: (error) => fetchProfilesFailed(error.message),
        }),
        apiClient.dispatch.listArchivedProfiles({
          onSuccess: (data) => fetchArchivedSucceeded(data),
          onError: (error) => fetchArchivedFailed(error.message),
        }),
      ],
      onError: (error) =>
        fetchProfilesFailed(`Failed to delete profile: ${error.message}`),
    }),

  // Archive an existing profile
  archiveProfile: (profileId: string) =>
    apiClient.dispatch.archiveProfile({
      params: { id: profileId },
      onSuccess: () =>
        apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: (error) => fetchProfilesFailed(error.message),
        }),
      onError: (error) =>
        fetchProfilesFailed(`Failed to archive profile: ${error.message}`),
    }),

  // Fetch archived profiles
  fetchArchived: () =>
    apiClient.dispatch.listArchivedProfiles({
      onSuccess: (data) => fetchArchivedSucceeded(data),
      onError: (error) => fetchArchivedFailed(error.message),
    }),

  // Restore an archived profile
  restoreProfile: (profileId: string) =>
    apiClient.dispatch.restoreProfile({
      params: { id: profileId },
      onSuccess: () => [
        apiClient.dispatch.listArchivedProfiles({
          onSuccess: (data) => fetchArchivedSucceeded(data),
          onError: (error) => fetchArchivedFailed(error.message),
        }),
        apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: (error) => fetchProfilesFailed(error.message),
        }),
      ],
      onError: (error) => fetchArchivedFailed(error.message),
    }),
};
