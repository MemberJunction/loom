import { describe, it, expect } from 'vitest';
import { Accumulator } from '../src/accumulation/accumulator.js';
import type { DomainConfig } from '@memberjunction/loom-contracts';

describe('Accumulator', () => {
  const domain: DomainConfig = {
    name: 'test-domain',
    namespace: '9b1dcbf2-c053-41e8-a2f4-d40e11ce66a1',
    entities: {
      Person: {
        name: 'Person',
        targetTable: 'Person',
        schema: 'dbo',
        pack: 'common',
        businessKey: ['ID'],
        fields: {},
        foreignKeys: {},
        isImmutable: false,
      },
      Order: {
        name: 'Order',
        targetTable: 'Order',
        schema: 'dbo',
        pack: 'orders',
        businessKey: ['ID'],
        fields: {},
        foreignKeys: {},
        isImmutable: true,
      },
    },
    packs: {
      common: { name: 'common', dependsOn: [] },
      orders: { name: 'orders', dependsOn: ['common'] },
    },
  };

  const accumulator = new Accumulator();

  it('separates brand new records from prior state', () => {
    const priorState = {
      Person: [{ ID: 'p-1', Name: 'Alice', Status: 'Active' }],
    };

    const currentState = {
      Person: [
        { ID: 'p-1', Name: 'Alice', Status: 'Active' },
        { ID: 'p-2', Name: 'Bob', Status: 'Active' },
      ],
    };

    const result = accumulator.ComputeDelta(
      domain,
      2,
      '2026-09-01',
      priorState,
      currentState
    );

    expect(result.newRecordCounts['Person']).toBe(1);
    expect(result.delta.generatedRecords['Person']).toEqual([
      { ID: 'p-2', Name: 'Bob', Status: 'Active' },
    ]);
  });

  it('throws an error when records are deleted from prior state unless allowDeletions is set', () => {
    const priorState = {
      Person: [
        { ID: 'p-1', Name: 'Alice' },
        { ID: 'p-2', Name: 'Bob' },
      ],
    };
    const currentState = {
      Person: [{ ID: 'p-1', Name: 'Alice' }],
    };

    expect(() =>
      accumulator.ComputeDelta(domain, 2, '2026-09-01', priorState, currentState)
    ).toThrowError(/record\(s\) deleted from prior state/);

    const allowed = accumulator.ComputeDelta(
      domain,
      2,
      '2026-09-01',
      priorState,
      currentState,
      { allowDeletions: true }
    );
    expect(allowed.deletedRecordCounts['Person']).toBe(1);
  });

  it('throws an error if a row is missing an ID instead of collapsing onto undefined', () => {
    const priorState = {};
    const currentState = {
      Person: [{ Name: 'Missing ID' }],
    };

    expect(() =>
      accumulator.ComputeDelta(domain, 1, '2026-09-01', priorState, currentState)
    ).toThrowError(/missing required primary key 'ID'/);
  });

  it('enforces that prior IDs are never reassigned across entities', () => {
    const priorState = {
      Person: [{ ID: 'id-100', Name: 'Alice' }],
    };
    const currentState = {
      Order: [{ ID: 'id-100', Total: 50 }],
    };

    expect(() =>
      accumulator.ComputeDelta(domain, 2, '2026-09-01', priorState, currentState)
    ).toThrowError(/cannot be reassigned/);
  });

  it('detects immutable record mutation including nested JSON objects', () => {
    const priorState = {
      Order: [{ ID: 'ord-1', Metadata: { note: 'initial' } }],
    };

    const currentState = {
      Order: [{ ID: 'ord-1', Metadata: { note: 'changed' } }],
    };

    expect(() =>
      accumulator.ComputeDelta(domain, 2, '2026-09-01', priorState, currentState)
    ).toThrowError(/immutable record mutation/);
  });
});
