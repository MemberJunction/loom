import { describe, it, expect } from 'vitest';
import { compileFeature, type RelationalContext } from '../src/features/compiler.js';

describe('compileFeature', () => {
  it('extracts self numeric fields', () => {
    const evaluator = compileFeature({ from: 'self', field: 'Tenure' });
    expect(evaluator({ Tenure: 5 })).toBe(5);
  });

  it('evaluates self boolean equality conditions', () => {
    const evaluator = compileFeature({
      from: 'self',
      where: { Status: 'Active' },
    });
    expect(evaluator({ Status: 'Active' })).toBe(1);
    expect(evaluator({ Status: 'Lapsed' })).toBe(0);
  });

  it('traverses multi-hop paths across entities', () => {
    const evaluator = compileFeature({
      from: 'Organization',
      path: ['CompanyID:Organization', 'Employees'],
    });

    const ctx: RelationalContext = {
      getEntity: (entity, id) => {
        if (entity === 'Organization' && id === 'org-1') {
          return { ID: 'org-1', Employees: 250 };
        }
        return undefined;
      },
      getChildren: () => [],
    };

    expect(evaluator({ CompanyID: 'org-1' }, ctx)).toBe(250);
    expect(evaluator({ CompanyID: 'org-missing' }, ctx)).toBe(0);
  });

  it('aggregates child records (count and sum)', () => {
    const countEval = compileFeature({
      from: 'Order',
      aggregation: 'count',
    });

    const sumEval = compileFeature({
      from: 'Order',
      aggregation: 'sum',
      field: 'Total',
    });

    const ctx: RelationalContext = {
      getEntity: () => undefined,
      getChildren: (_p, parentId) => {
        if (parentId === 'person-1') {
          return [
            { ID: 'o-1', Total: 100 },
            { ID: 'o-2', Total: 150 },
          ];
        }
        return [];
      },
    };

    expect(countEval({ ID: 'person-1' }, ctx)).toBe(2);
    expect(sumEval({ ID: 'person-1' }, ctx)).toBe(250);
    expect(sumEval({ ID: 'person-none' }, ctx)).toBe(0);
  });
});
