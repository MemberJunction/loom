import { describe, it, expect } from 'vitest';
import { runWeeklySimulationCycle } from '../src/workflows/weeklyCycle.js';
import type { DomainConfig } from '@memberjunction/loom-contracts';

describe('runWeeklySimulationCycle', () => {
  const domain: DomainConfig = {
    name: 'test-weekly',
    namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    entities: {
      Organization: {
        name: 'Organization',
        targetTable: 'Organization',
        schema: 'dbo',
        pack: 'common',
        businessKey: ['ID'],
        fields: {},
        foreignKeys: {},
        isImmutable: false,
      },
    },
    packs: {
      common: { name: 'common', dependsOn: [] },
    },
  };

  it('runs complete cycle: computes deltas and passes validation gates', async () => {
    const priorState = {
      Organization: [{ ID: 'org-1', Name: 'Org 1' }],
    };

    const currentState = {
      Organization: [
        { ID: 'org-1', Name: 'Org 1' },
        { ID: 'org-2', Name: 'Org 2' },
      ],
    };

    const result = await runWeeklySimulationCycle({
      domain,
      cycleIndex: 1,
      asOfDate: '2026-09-02',
      priorState,
      currentState,
      enableVisualInspection: false, // Visual browser inspection tested in live host environment
    });

    expect(result.passed).toBe(true);
    expect(result.cycleIndex).toBe(1);
    expect(result.newRecordCounts['Organization']).toBe(1);
    expect(result.validation.passed).toBe(true);
    expect(result.validation.totalPopulationExamined).toBe(2);
  });
});
