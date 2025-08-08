import { useOutletContext } from 'react-router-dom';

type Ctx = {
  color: string;
  setColor: (c: string) => void;
  animOn: boolean;
  setAnimOn: (v: boolean) => void;
  shapesOn: boolean;
  setShapesOn: (v: boolean) => void;
  darkMode: boolean;
  setDarkMode: (v: boolean) => void;
  swatches: readonly string[];
};

export default function SettingsPage() {
  const ctx = useOutletContext<Ctx>();
  return (
    <div className="text-[var(--text)]">
      <h3 className="text-sm opacity-70 mb-4">Settings</h3>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-medium">Background tester</h2>
        <div className="text-xs opacity-70">temp controls</div>
      </div>

      <div className="mb-4">
        <div className="text-sm mb-2">Pick a color</div>
        <div className="grid grid-cols-3 gap-2">
          {ctx.swatches.map((c) => {
            const selected = c.toLowerCase() === ctx.color.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                onClick={() => ctx.setColor(c)}
                className={`h-10 rounded-full border border-white/20 transition-transform focus:outline-none focus:ring-2 focus:ring-white/70 ${
                  selected ? 'ring-2 ring-white/80 scale-[1.02]' : ''
                }`}
                style={{ backgroundColor: c }}
                aria-label={`Set color ${c}`}
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 mb-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-current"
            checked={ctx.animOn}
            onChange={(e) => ctx.setAnimOn(e.target.checked)}
          />
          Animations
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-current"
            checked={ctx.shapesOn}
            onChange={(e) => ctx.setShapesOn(e.target.checked)}
          />
          Shapes
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-current"
            checked={ctx.darkMode}
            onChange={(e) => ctx.setDarkMode(e.target.checked)}
          />
          Dark mode
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn btn-primary">
          Primary
        </button>
        <button type="button" className="btn btn-secondary">
          Secondary
        </button>
      </div>
    </div>
  );
}
