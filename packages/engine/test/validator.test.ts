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
          Status: { name: 'Status', type: 'string' },
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
      Person: [{ ID: 'p-1', CompanyID: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', Status: 'Active' }],
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

  it('fails PK uniqueness gate when records are missing primary keys', () => {
    const data = {
      Organization: [{ ID: 'org-1' }],
      Person: [
        { Name: 'Missing ID 1' },
        { Name: 'Missing ID 2' },
      ],
    };

    const report = validator.Validate(domain, data, []);
    const pkGate = report.gates.find((g) => g.name.includes('Person.ID'));
    expect(pkGate?.passed).toBe(false);
    expect(pkGate?.message).toContain('missing primary key');
  });

  it('evaluates explicit outcome feature against observed data', () => {
    const factor: FactorContract = {
      id: 'f-renewal',
      effect: 'Person',
      target: 0.75, // 75% renewal rate
      tolerance: 0.05,
      evidence: { source: 'historical', confidence: 'high' },
      outcome: {
        from: 'self',
        where: { Status: 'Renewed' },
      },
      arrows: {},
    };

    const data = {
      Organization: [],
      Person: [
        { ID: 'p-1', Status: 'Renewed' },
        { ID: 'p-2', Status: 'Renewed' },
        { ID: 'p-3', Status: 'Renewed' },
        { ID: 'p-4', Status: 'Lapsed' },
      ], // 3/4 = 75%
    };

    const report = validator.Validate(domain, data, [factor]);
    const factorGate = report.gates.find((g) => g.id === factor.id || g.name.includes(factor.id));
    expect(factorGate?.passed).toBe(true);
    expect(factorGate?.actual).toBe(0.75);
    expect(factorGate?.populationCount).toBe(4);
  });

  it('evaluates relational arrows across entities without throwing', () => {
    const factor: FactorContract = {
      id: 'f-relational',
      effect: 'Person',
      target: 0.5,
      tolerance: 0.1,
      evidence: { source: 'test', confidence: 'high' },
      arrows: {
        orgEmployees: {
          name: 'orgEmployees',
          beta: 0.01,
          feature: {
            from: 'Organization',
            path: ['CompanyID:Organization', 'Employees'],
          },
        },
      },
    };

    const data = {
      Organization: [{ ID: 'org-1', Employees: 50 }],
      Person: [
        { ID: 'p-1', CompanyID: 'org-1' },
        { ID: 'p-2', CompanyID: 'org-1' },
      ],
    };

    const report = validator.Validate(domain, data, [factor]);
    const factorGate = report.gates.find((g) => g.name.includes(factor.id));
    expect(factorGate?.passed).toBe(true);
    expect(factorGate?.populationCount).toBe(2);
  });
});
