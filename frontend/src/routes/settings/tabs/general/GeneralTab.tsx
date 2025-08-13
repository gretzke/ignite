import { useAppDispatch, useAppSelector } from '../../../../store';
import {
  setShowDetails,
  setTheme,
} from '../../../../store/features/app/appSlice';
import Switch from '../../../../components/Switch';

export default function GeneralTab() {
  const dispatch = useAppDispatch();
  const showDetails = useAppSelector((s) => s.app.showDetails);
  const darkMode = useAppSelector((s) => s.app.theme) === 'dark';
  return (
    <div>
      <div className="text-sm opacity-70 mb-2">UI</div>
      <div className="flex flex-col gap-4 mb-3">
        <div className="flex items-center justify-between">
          <div className="text-base font-medium">Dark Mode</div>
          <Switch
            checked={darkMode}
            onCheckedChange={(v) => dispatch(setTheme(v ? 'dark' : 'light'))}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-base font-medium">Show Details</div>
          <Switch
            checked={showDetails}
            onCheckedChange={(v) => dispatch(setShowDetails(v))}
          />
        </div>
      </div>
    </div>
  );
}
