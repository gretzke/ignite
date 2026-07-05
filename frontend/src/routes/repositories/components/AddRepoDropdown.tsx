import Dropdown from '../../../components/Dropdown';
import { Plus, Folder, GitBranch } from 'lucide-react';

interface AddRepoDropdownProps {
  onAddLocal: () => void;
  onClone: () => void;
}

export default function AddRepoDropdown({
  onAddLocal,
  onClone,
}: AddRepoDropdownProps) {
  return (
    <Dropdown
      renderTrigger={({ ref, toggle }) => (
        <button
          ref={ref}
          type="button"
          className="btn btn-primary"
          style={{
            width: 40,
            height: 36,
            paddingLeft: 0,
            paddingRight: 0,
          }}
          aria-label="Add repository"
          title="Add repository"
          onClick={toggle}
        >
          <Plus size={16} />
        </button>
      )}
      menuClassName="tooltip-content"
      menuStyle={{
        padding: 12,
        minWidth: 160,
        background:
          'color-mix(in oklch, var(--bg-base) calc(var(--glass-milk) + 20%), transparent)',
        borderColor: 'color-mix(in oklch, #fff 28%, transparent)',
      }}
    >
      {({ close }) => (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
            onClick={() => {
              onAddLocal();
              close();
            }}
          >
            <Folder size={16} />
            Local Repo
          </button>
          <button
            type="button"
            className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
            onClick={() => {
              onClone();
              close();
            }}
          >
            <GitBranch size={16} />
            Cloned Repo
          </button>
        </div>
      )}
    </Dropdown>
  );
}
