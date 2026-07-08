// frontend/src/routes/settings/tabs/chains/ChainIcon.tsx
// Chain avatar: chainlist icon (icons.llamao.fi) when available, falling
// back to the letter tile when absent or the image fails to load (offline).
import { useState } from 'react';
import type { ChainInfo } from '@ignite/api';

export default function ChainIcon({ chain }: { chain: ChainInfo }) {
  const [failed, setFailed] = useState(false);
  if (chain.iconUrl && !failed) {
    return (
      <img
        src={chain.iconUrl}
        alt=""
        aria-hidden
        loading="lazy"
        width={32}
        height={32}
        className="shrink-0"
        // Match the .icon-tile box (32px, 10px radius) so rows line up
        // whether the remote icon loaded or not.
        style={{ borderRadius: 10, objectFit: 'cover' }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="icon-tile shrink-0" aria-hidden>
      {chain.name.slice(0, 1).toUpperCase()}
    </div>
  );
}
