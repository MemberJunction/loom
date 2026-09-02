import { describe, it, expect } from 'vitest';
import { renderRow, type RowTemplate } from '../src/templates/evaluator.js';
import { createRng } from '../src/math/rng.js';

describe('renderRow template evaluator', () => {
  it('evaluates constant, dot-path from, optional from, and formatted strings', () => {
    const template: RowTemplate = {
      let: {
        fullName: { fmt: '{user.firstName} {user.lastName}' },
      },
      row: {
        id: { const: 'fixed-123' },
        name: { from: 'fullName' },
        email: { fromOptional: 'user.missingEmail' },
      },
    };

    const scope = {
      user: { firstName: 'Alice', lastName: 'Smith' },
    };

    const row = renderRow(template, scope);
    expect(row['id']).toBe('fixed-123');
    expect(row['name']).toBe('Alice Smith');
    expect(row['email']).toBeNull();
  });

  it('increments sequence numbers across row renders', () => {
    const template: RowTemplate = {
      row: {
        itemNo: { seq: 'lineItemSeq' },
      },
    };

    const scope = { lineItemSeq: 0 };
    const row1 = renderRow(template, scope);
    const row2 = renderRow(template, scope);
    const row3 = renderRow(template, scope);

    expect(row1['itemNo']).toBe(1);
    expect(row2['itemNo']).toBe(2);
    expect(row3['itemNo']).toBe(3);
  });

  it('throws an error if a chance path cannot be resolved', () => {
    const template: RowTemplate = {
      row: {
        flag: { chance: 'unresolved.path' },
      },
    };

    const rng = createRng(42);
    expect(() => renderRow(template, {}, rng)).toThrowError(/chance path 'unresolved.path' resolved to undefined/);
  });

  it('throws an error if a chance probability is out of bounds', () => {
    const template: RowTemplate = {
      row: {
        flag: { chance: 1.5 },
      },
    };

    const rng = createRng(42);
    expect(() => renderRow(template, {}, rng)).toThrowError(/chance probability must be within \[0, 1\]/);
  });

  it('evaluates pick, mix, and int with deterministic RNG', () => {
    const template: RowTemplate = {
      row: {
        category: { pick: 'categories' },
        level: { int: [1, 5] },
        priority: { mix: 'priorityMix' },
      },
    };

    const scope = {
      categories: ['A', 'B', 'C'],
      priorityMix: [
        { value: 'High', weight: 1 },
        { value: 'Low', weight: 9 },
      ],
    };

    const rng = createRng(123);
    const row = renderRow(template, scope, rng);

    expect(['A', 'B', 'C']).toContain(row['category']);
    expect(row['level']).toBeGreaterThanOrEqual(1);
    expect(row['level']).toBeLessThanOrEqual(5);
    expect(['High', 'Low']).toContain(row['priority']);
  });
});
