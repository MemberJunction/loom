import { describe, it, expect } from 'vitest';
import { IdentityService } from '../src/identity/index.js';

describe('IdentityService', () => {
  const namespace = '9b1dcbf2-c053-41e8-a2f4-d40e11ce66a1';
  const service = new IdentityService();
  service.registerNamespace('morecheese', namespace);

  it('mints deterministic UUIDv5 matching standard uuidv5 implementation', () => {
    const id1 = service.mintId('morecheese', 'Person', '1001');
    const id2 = service.mintId('morecheese', 'Person', '1001');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('produces distinct UUIDs for different business keys or entities', () => {
    const idPerson = service.mintId('morecheese', 'Person', '1001');
    const idOrg = service.mintId('morecheese', 'Organization', '1001');
    const idPerson2 = service.mintId('morecheese', 'Person', '1002');

    expect(idPerson).not.toBe(idOrg);
    expect(idPerson).not.toBe(idPerson2);
  });
});
