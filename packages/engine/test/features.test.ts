import { describe, it, expect } from 'vitest';
import { compileFeature, type RelationalContext } from '../src/features/compiler.js';

describe('compileFeature', () => {
  it('evaluates self-entity field values', () => {
    const fn = compileFeature({ from: 'self', field: 'AutoRenew' });
    expect(fn({ AutoRenew: true })).toBe(1);
    expect(fn({ AutoRenew: false })).toBe(0);
    expect(fn({ AutoRenew: 42 })).toBe(42);
  });

  it('evaluates self-entity where conditions', () => {
    const fn = compileFeature({
      from: 'self',
      where: { Segment: 'Producer', Status: 'Active' },
    });
    expect(fn({ Segment: 'Producer', Status: 'Active' })).toBe(1);
    expect(fn({ Segment: 'Retailer', Status: 'Active' })).toBe(0);
  });

  it('evaluates multi-hop relational path queries across foreign keys', () => {
    const fn = compileFeature({
      from: 'Organization',
      path: ['CompanyID', 'EmployeeCount'],
    });

    const mockContext: RelationalContext = {
      getEntity(entityName: string, id: string) {
        if (entityName === 'Organization' && id === 'org-123') {
          return { ID: 'org-123', EmployeeCount: 85 };
        }
        return undefined;
      },
      getChildren() {
        return [];
      },
    };

    const personRecord = { ID: 'p-1', CompanyID: 'org-123' };
    expect(fn(personRecord, mockContext)).toBe(85);
  });
});
