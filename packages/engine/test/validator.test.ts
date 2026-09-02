import { describe, it, expect } from 'vitest';
import { Validator } from '../src/validation/validator.js';
import type { DomainConfig, FactorContract } from '@memberjunction/loom-contracts';

describe('Validator', () => {
  const domain: DomainConfig = {
    name: 'test-domain',
    namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    packs: {
      common: { name: 'common', dependsOn: [] },
    },
    entities: {
      Organization: {
        name: 'Organization',
        targetTable: 'Organization',
        schema: 'dbo',
        pack: 'common',
        businessKey: ['ID'],
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
        },
        foreignKeys: {},
        isImmutable: false,
      },
      Person: {
        name: 'Person',
        targetTable: 'Person',
        schema: 'dbo',
        pack: 'common',
        businessKey: ['ID'],
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          CompanyID: { name: 'CompanyID', type: 'uuid', nullable: true },
        },
        foreignKeys: {
          FK_Person_Organization: {
            fieldName: 'CompanyID',
            targetEntity: 'Organization',
            targetField: 'ID',
            cardinality: 'many-to-one',
          },
        },
        isImmutable: false,
      },
    },
  };

  const validator = new Validator();

  it('validates referential closure with case-insensitive UUID matching', () => {
    const data = {
      Organization: [{ ID: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' }],
      Person: [{ ID: 'p-1', CompanyID: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }],
    };

    const report = validator.Validate(domain, data, []);
    expect(report.passed).toBe(true);
    expect(report.gates[0]!.passed).toBe(true);
    expect(report.gates[0]!.populationCount).toBe(1);
  });

  it('fails foreign key closure when a reference is dangling', () => {
    const data = {
      Organization: [{ ID: 'org-1' }],
      Person: [{ ID: 'p-1', CompanyID: 'org-nonexistent' }],
    };

    const report = validator.Validate(domain, data, []);
    expect(report.passed).toBe(false);
    expect(report.gates[0]!.passed).toBe(false);
  });

  it('fails factor gate when target entity has 0 records', () => {
    const factor: FactorContract = {
      id: 'f-1',
      effect: 'Person',
      target: 0.85,
      tolerance: 0.05,
      evidence: { source: 'test', confidence: 'high' },
      arrows: {},
    };

    const data = {
      Organization: [],
      Person: [],
    };

    const report = validator.Validate(domain, data, [factor]);
    const factorGate = report.gates.find((g) => g.category === 'factor');
    expect(factorGate?.passed).toBe(false);
    expect(factorGate?.populationCount).toBe(0);
  });

  it('empirically evaluates factor contract over real data', () => {
    const factor: FactorContract = {
      id: 'f-active',
      effect: 'Person',
      target: 0.5,
      tolerance: 0.1,
      evidence: { source: 'test', confidence: 'high' },
      arrows: {
        score: {
          name: 'score',
          beta: 0, // sigmoid(0) = 0.5
          feature: { from: 'self', field: 'ID' },
        },
      },
    };

    const data = {
      Organization: [],
      Person: [{ ID: 'p-1' }, { ID: 'p-2' }, { ID: 'p-3' }],
    };

    const report = validator.Validate(domain, data, [factor]);
    const factorGate = report.gates.find((g) => g.category === 'factor');
    expect(factorGate?.passed).toBe(true);
    expect(factorGate?.actual).toBe(0.5);
    expect(factorGate?.populationCount).toBe(3);
  });
});
