import { describe, it, expect } from 'vitest';
import { SQUID_CONF } from '../../plugins/install/IsolatedBuilder.js';

describe('IsolatedBuilder egress ACL', () => {
  it('denies loopback, all RFC1918 ranges, and link-local before allowing', () => {
    const denyIdx = SQUID_CONF.indexOf('http_access deny private_dst');
    const allowIdx = SQUID_CONF.indexOf('http_access allow');
    expect(denyIdx).toBeGreaterThan(-1);
    // deny rule must appear before any allow rule (squid evaluates top-down)
    expect(denyIdx).toBeLessThan(allowIdx);
    for (const cidr of [
      '127.0.0.0/8',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
    ]) {
      expect(SQUID_CONF).toContain(cidr);
    }
  });
});
