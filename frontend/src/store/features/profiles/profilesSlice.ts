import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ProfileConfig } from '@ignite/api';
import { apiClient, apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';

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
    fetchProfilesFailed() {},
    setCurrentProfile(state, action: PayloadAction<string>) {
      state.currentId = action.payload;
    },
    fetchArchivedSucceeded(
      state,
      action: PayloadAction<{ profiles: ProfileConfig[] }>
    ) {
      state.archivedProfiles = action.payload.profiles;
    },
    fetchArchivedFailed() {},
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
      onError: () => fetchProfilesFailed(),
    }),

  // Switch to a specific profile
  switchProfile: (profileId: string) => {
    const apiAction = apiClient.dispatch.switchProfile({
      params: { id: profileId },
      onSuccess: () => {
        // Immediately update current profile and refresh list to get updated lastUsed values
        return [
          setCurrentProfile(profileId),
          apiClient.dispatch.listProfiles({
            onSuccess: (data) => fetchProfilesSucceeded(data),
            onError: () => fetchProfilesFailed(),
          }),
        ];
      },
      onError: () => fetchProfilesFailed(),
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Switching profile...',
        description: 'Switching to selected profile',
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Profile switched',
        description: 'Successfully switched to the selected profile',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err: unknown) => ({
        title: 'Failed to switch profile',
        description:
          (err as { message?: string })?.message ||
          'An unexpected error occurred',
        variant: 'error',
        duration: 6000,
      }),
    });
  },

  // Create a new profile
  createProfile: (profileData: {
    name: string;
    color?: string;
    icon?: string;
  }) => {
    const apiAction = apiClient.dispatch.createProfile({
      body: profileData,
      onSuccess: (_data) => {
        // After successful creation, refetch profiles
        return apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: () => fetchProfilesFailed(),
        });
      },
      onError: () => fetchProfilesFailed(),
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Creating profile...',
        description: `Creating "${profileData.name}"`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Profile created',
        description: `"${profileData.name}" was created successfully`,
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title,
          description,
          variant: 'error',
          duration: 6000,
        };
      },
    });
  },

  // Update an existing profile
  updateProfile: (profileData: {
    id: string;
    name?: string;
    color?: string;
    icon?: string;
  }) => {
    const profileName = profileData.name || 'profile';

    const apiAction = apiClient.dispatch.updateProfile({
      body: profileData,
      onSuccess: () => {
        // Refresh list to reflect updated properties and sorting
        return apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: () => fetchProfilesFailed(),
        });
      },
      onError: () => [fetchProfilesFailed()],
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Updating profile...',
        description: `Updating "${profileName}"`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Profile updated',
        description: `"${profileName}" was updated successfully`,
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title,
          description,
          variant: 'error',
          duration: 6000,
        };
      },
    });
  },

  // Delete an existing profile
  deleteProfile: (profileId: string) => {
    const apiAction = apiClient.dispatch.deleteProfile({
      params: { id: profileId },
      onSuccess: () => [
        apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: () => fetchProfilesFailed(),
        }),
        apiClient.dispatch.listArchivedProfiles({
          onSuccess: (data) => fetchArchivedSucceeded(data),
          onError: () => fetchArchivedFailed(),
        }),
      ],
      onError: () => fetchProfilesFailed(),
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Deleting profile...',
        description: 'Removing the selected profile',
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Profile deleted',
        description: 'Profile was deleted successfully',
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title,
          description,
          variant: 'error',
          duration: 6000,
        };
      },
    });
  },

  // Archive an existing profile
  archiveProfile: (profileId: string) => {
    const apiAction = apiClient.dispatch.archiveProfile({
      params: { id: profileId },
      onSuccess: () =>
        apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: () => fetchProfilesFailed(),
        }),
      onError: () => fetchProfilesFailed(),
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Archiving profile...',
        description: 'Moving profile to archive',
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Profile archived',
        description: 'Profile was archived successfully',
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title,
          description,
          variant: 'error',
          duration: 6000,
        };
      },
    });
  },

  // Fetch archived profiles
  fetchArchived: () =>
    apiClient.dispatch.listArchivedProfiles({
      onSuccess: (data) => fetchArchivedSucceeded(data),
      onError: () => fetchArchivedFailed(),
    }),

  // Restore an archived profile
  restoreProfile: (profileId: string) => {
    const apiAction = apiClient.dispatch.restoreProfile({
      params: { id: profileId },
      onSuccess: () => [
        apiClient.dispatch.listArchivedProfiles({
          onSuccess: (data) => fetchArchivedSucceeded(data),
          onError: () => fetchArchivedFailed(),
        }),
        apiClient.dispatch.listProfiles({
          onSuccess: (data) => fetchProfilesSucceeded(data),
          onError: () => fetchProfilesFailed(),
        }),
      ],
      onError: () => fetchArchivedFailed(),
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Restoring profile...',
        description: 'Restoring profile from archive',
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Profile restored',
        description: 'Profile was restored successfully',
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title,
          description,
          variant: 'error',
          duration: 6000,
        };
      },
    });
  },
};
