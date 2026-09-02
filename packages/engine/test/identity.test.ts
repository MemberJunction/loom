import { describe, it, expect } from 'vitest';
import { IdentityService } from '../src/identity/index.js';

describe('IdentityService', () => {
  const service = new IdentityService();
  const testNamespace = '9b1dcbf2-c053-41e8-a2f4-d40e11ce66a1';
  service.RegisterNamespace('test-domain', testNamespace);

  it('generates reproducible UUIDs from the same business key', () => {
    const id1 = service.MintId('test-domain', 'Member', 'MEM-0001');
    const id2 = service.MintId('test-domain', 'Member', 'MEM-0001');
    expect(id1).toBe(id2);
  });

  it('generates distinct UUIDs for different entities with the same business key', () => {
    const id1 = service.MintId('test-domain', 'Member', '123');
    const id2 = service.MintId('test-domain', 'Order', '123');
    expect(id1).not.toBe(id2);
  });
});
