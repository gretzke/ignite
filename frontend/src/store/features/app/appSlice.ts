import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Minimal app slice: controls global theme only
export interface IAppState {
  theme: 'light' | 'dark';
  // When true, enable both animations and shapes
  showDetails: boolean;
  // Selected profile color (hex string)
  colorHex: string;
  // Sidebar collapsed state (UI layout)
  sidebarCollapsed: boolean;
}

// Hydrate initial theme from localStorage at store creation time
function getInitialTheme(): 'light' | 'dark' {
  try {
    const v = window.localStorage.getItem('ignite:theme');
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // ignore
  }
  return 'light';
}

function getInitialShowDetails(): boolean {
  try {
    const v = window.localStorage.getItem('ignite:details');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // ignore
  }
  // Default ON to match previous UI behavior
  return true;
}

function getInitialColorHex(): string {
  try {
    const v = window.localStorage.getItem('ignite:color');
    if (typeof v === 'string' && v.trim().length > 0) return v;
  } catch {
    // ignore
  }
  // Default to Ethereum blue
  return '#627eeb';
}

function getInitialSidebarCollapsed(): boolean {
  try {
    const v = window.localStorage.getItem('ignite:sidebar-collapsed');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // ignore
  }
  return false;
}

const initialState: IAppState = {
  theme: getInitialTheme(),
  showDetails: getInitialShowDetails(),
  colorHex: getInitialColorHex(),
  sidebarCollapsed: getInitialSidebarCollapsed(),
};

// Preserved order color options with titles derived from comments in App.tsx
export const COLOR_OPTIONS: ReadonlyArray<{ hex: string; title: string }> = [
  { hex: '#627eeb', title: 'Ethereum Blue' },
  { hex: '#f7931a', title: 'Bitcoin Orange' },
  { hex: '#ff007a', title: 'Uniswap Pink' },
  { hex: '#8247e5', title: 'Polygon Purple' },
  { hex: '#00d1ff', title: 'Synthetix Cyan' },
  { hex: '#ffa17b', title: 'Rocketpool Peach' },
  { hex: '#0df2a8', title: 'Solana Green' },
  { hex: '#ba9f30', title: 'Doge Yellow' },
  { hex: '#3d8130', title: 'Pepe Green' },
];

const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    // Explicit setter used by UI (dispatch setTheme('dark'|'light'))
    // Persist to localStorage inside the action via prepare()
    setTheme: {
      reducer(state, action: PayloadAction<'light' | 'dark'>) {
        state.theme = action.payload;
      },
      prepare(nextTheme: 'light' | 'dark') {
        try {
          window.localStorage.setItem('ignite:theme', nextTheme);
        } catch {
          // ignore
        }
        return { payload: nextTheme };
      },
    },
    // Single flag to toggle both animations and shapes together
    setShowDetails: {
      reducer(state, action: PayloadAction<boolean>) {
        state.showDetails = action.payload;
      },
      prepare(next: boolean) {
        try {
          window.localStorage.setItem('ignite:details', next ? '1' : '0');
        } catch {
          // ignore
        }
        return { payload: next };
      },
    },
    // Explicitly set the selected profile color and persist it
    setColor: {
      reducer(state, action: PayloadAction<string>) {
        state.colorHex = action.payload;
      },
      prepare(hex: string) {
        try {
          window.localStorage.setItem('ignite:color', hex);
        } catch {
          // ignore
        }
        return { payload: hex };
      },
    },
    // Set sidebar collapsed and persist
    setSidebarCollapsed: {
      reducer(state, action: PayloadAction<boolean>) {
        state.sidebarCollapsed = action.payload;
      },
      prepare(next: boolean) {
        try {
          window.localStorage.setItem(
            'ignite:sidebar-collapsed',
            next ? '1' : '0'
          );
        } catch {
          // ignore
        }
        return { payload: next };
      },
    },
  },
});

export const { setTheme, setShowDetails, setColor, setSidebarCollapsed } =
  appSlice.actions;
export const appReducer = appSlice.reducer;
