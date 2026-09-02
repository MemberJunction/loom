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

  it('detects status transitions on mutable entities', () => {
    const priorState = {
      Person: [{ ID: 'p-1', Name: 'Alice', Status: 'PendingRenewal' }],
    };

    const currentState = {
      Person: [{ ID: 'p-1', Name: 'Alice', Status: 'Renewed' }],
    };

    const result = accumulator.ComputeDelta(
      domain,
      2,
      '2026-09-01',
      priorState,
      currentState
    );

    expect(result.delta.statusTransitions).toHaveLength(1);
    expect(result.delta.statusTransitions[0]).toEqual({
      entity: 'Person',
      id: 'p-1',
      fromStatus: 'PendingRenewal',
      toStatus: 'Renewed',
      effectiveDate: '2026-09-01',
    });
  });

  it('throws an error if an immutable record attempts to mutate', () => {
    const priorState = {
      Order: [{ ID: 'ord-1', Total: 100 }],
    };

    const currentState = {
      Order: [{ ID: 'ord-1', Total: 150 }],
    };

    expect(() =>
      accumulator.ComputeDelta(
        domain,
        2,
        '2026-09-01',
        priorState,
        currentState
      )
    ).toThrowError(/immutable record mutation/);
  });
});
