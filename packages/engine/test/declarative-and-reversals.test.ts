import { describe, it, expect } from 'vitest';
import {
  evaluateConditionalDistribution,
  evaluateCatalogLookup,
  evaluateRelativeDateRange,
  applyDeclarativeGeneratorsToRow,
  ReversalEngine,
  Validator,
  createRng,
} from '../src/index.js';
import type { DomainConfig } from '@memberjunction/loom-contracts';

describe('Declarative Generators', () => {
  it('evaluates conditional distribution from source field', () => {
    const rng = createRng(42);
    const config = {
      type: 'conditionalDistribution' as const,
      conditionalOn: 'Gender',
      distributions: {
        Female: { values: ['Ms.', 'Mrs.'], weights: [0.7, 0.3] },
        Male: { values: ['Mr.'], weights: [1.0] },
      },
    };

    const femaleVal = evaluateConditionalDistribution(config, { Gender: 'Female' }, { rng });
    expect(['Ms.', 'Mrs.']).toContain(femaleVal);

    const maleVal = evaluateConditionalDistribution(config, { Gender: 'Male' }, { rng });
    expect(maleVal).toBe('Mr.');
  });

  it('evaluates conditional distribution with parent scope reference', () => {
    const rng = createRng(42);
    const config = {
      type: 'conditionalDistribution' as const,
      conditionalOn: 'parent.Gender',
      distributions: {
        Female: { values: ['she/her'], weights: [1.0] },
        Male: { values: ['he/him'], weights: [1.0] },
      },
    };

    const val = evaluateConditionalDistribution(config, {}, {
      rng,
      parent: { Gender: 'Female' },
    });
    expect(val).toBe('she/her');
  });

  it('evaluates catalog lookup by mapping source field to catalog key', () => {
    const rng = createRng(42);
    const config = {
      type: 'catalogLookup' as const,
      catalog: 'given-names',
      mapBy: 'Gender',
      keyMap: {
        Female: 'female',
        Male: 'male',
      },
    };

    const catalogs: Record<string, readonly Record<string, unknown>[]> = {
      'given-names': [
        {
          female: ['Elena', 'Sophia'],
          male: ['Marcus', 'David'],
        },
      ],
    };

    const name = evaluateCatalogLookup(config, { Gender: 'Female' }, { rng, catalogs });
    expect(['Elena', 'Sophia']).toContain(name);
  });

  it('evaluates relative date range to enforce age >= 18 at intake', () => {
    const rng = createRng(42);
    const config = {
      type: 'relativeDateRange' as const,
      relativeTo: 'intakeDate' as const,
      minOffsetYears: -75,
      maxOffsetYears: -18,
      distribution: 'uniform' as const,
    };

    const intakeDate = '2025-06-01';
    const dobStr = evaluateRelativeDateRange(config, { IntakeDate: intakeDate }, {
      rng,
      asOfDate: intakeDate,
    });

    const dob = new Date(dobStr);
    const intake = new Date(intakeDate);
    const diffYears = (intake.getTime() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(diffYears).toBeGreaterThanOrEqual(18.0);
    expect(diffYears).toBeLessThanOrEqual(75.5);
  });

  it('applies declarative generators to an entity row', () => {
    const rng = createRng(42);
    const entityCfg = {
      name: 'Person',
      fields: {
        Gender: { name: 'Gender', type: 'string' as const },
        Prefix: {
          name: 'Prefix',
          type: 'string' as const,
          generator: {
            type: 'conditionalDistribution' as const,
            conditionalOn: 'Gender',
            distributions: {
              Female: { values: ['Ms.'], weights: [1.0] },
              Male: { values: ['Mr.'], weights: [1.0] },
            },
          },
        },
      },
    };

    const row: Record<string, unknown> = { Gender: 'Female' };
    applyDeclarativeGeneratorsToRow(
      entityCfg as unknown as import('@memberjunction/loom-contracts').EntityConfig,
      row,
      { rng }
    );

    expect(row['Prefix']).toBe('Ms.');
  });
});

describe('Reversal Engine', () => {
  it('coherifies cancellations against confirmed sales', () => {
    const rng = createRng(42);
    const orders: Record<string, unknown>[] = [
      {
        ID: 'order-1',
        OrderType: 'Sale',
        OrderStatus: 'Confirmed',
        OrderDate: '2024-01-10',
        CustomerID: 'cust-1',
        TotalGross: 150.0,
      },
      {
        ID: 'order-2',
        OrderType: 'Cancellation',
        OrderStatus: 'Confirmed',
        OrderDate: '2024-02-15',
        CustomerID: 'cust-1',
        TotalGross: 0,
      },
    ];

    const orderLines: Record<string, unknown>[] = [
      {
        ID: 'line-1',
        OrderHeaderID: 'order-1',
        ProductID: 'prod-1',
        Quantity: 2,
        UnitPrice: 75.0,
        LineTotalGross: 150.0,
      },
      {
        ID: 'line-2',
        OrderHeaderID: 'order-2',
        ProductID: 'prod-dummy',
        Quantity: 1,
        UnitPrice: 10.0,
        LineTotalGross: 10.0,
      },
    ];

    const result = ReversalEngine.CoherifyCancellations({
      orders,
      orderLines,
      rng,
    });

    expect(result.coherentCount).toBe(1);
    expect(orders[1]!['ReversesOrderHeaderID']).toBe('order-1');
    expect(orders[1]!['CustomerID']).toBe('cust-1');
    expect(Number(orders[1]!['TotalGross'])).toBe(-150.0);

    // Line check
    expect(orderLines[1]!['ReversesOrderLineID']).toBe('line-1');
    expect(orderLines[1]!['ProductID']).toBe('prod-1');
    expect(Number(orderLines[1]!['Quantity'])).toBe(-2);
    expect(Number(orderLines[1]!['LineTotalGross'])).toBe(-150.0);
  });
});

describe('Automated Quality & Validation Gates', () => {
  const validator = new Validator();

  it('validates prefix-gender consistency gate', () => {
    const domain: DomainConfig = {
      name: 'prefix-test',
      namespace: '00000000-0000-0000-0000-000000000001',
      packs: { core: { name: 'core', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'Person',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            Prefix: { name: 'Prefix', type: 'string' },
            Gender: { name: 'Gender', type: 'string' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const goodData = {
      Person: [
        { ID: '1', Prefix: 'Ms.', Gender: 'Female' },
        { ID: '2', Prefix: 'Mr.', Gender: 'Male' },
        { ID: '3', Prefix: 'Dr.', Gender: 'Female' },
      ],
    };

    const goodReport = validator.Validate(domain, goodData);
    const goodGate = goodReport.gates.find((g) => g.name.includes('Prefix-Gender'));
    expect(goodGate?.passed).toBe(true);
    expect(goodGate?.populationCount).toBe(3);

    const badData = {
      Person: [
        { ID: '1', Prefix: 'Mr.', Gender: 'Female' }, // Mismatch!
      ],
    };

    const badReport = validator.Validate(domain, badData);
    const badGate = badReport.gates.find((g) => g.name.includes('Prefix-Gender'));
    expect(badGate?.passed).toBe(false);
    expect(badGate?.actual).toBe(1);
  });

  it('validates pronoun-gender consistency gate', () => {
    const domain: DomainConfig = {
      name: 'pronoun-test',
      namespace: '00000000-0000-0000-0000-000000000002',
      packs: { core: { name: 'core', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'Person',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            Gender: { name: 'Gender', type: 'string' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
        Profile: {
          name: 'Profile',
          targetTable: 'Profile',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PersonID: { name: 'PersonID', type: 'uuid' },
            PronounSet: { name: 'PronounSet', type: 'string' },
          },
          foreignKeys: {
            FK_Profile_Person: {
              fieldName: 'PersonID',
              targetEntity: 'Person',
              targetField: 'ID',
            },
          },
          isImmutable: false,
        },
      },
    };

    const goodData = {
      Person: [
        { ID: 'p-1', Gender: 'Female' },
        { ID: 'p-2', Gender: 'Male' },
      ],
      Profile: [
        { ID: 'pr-1', PersonID: 'p-1', PronounSet: 'she/her' },
        { ID: 'pr-2', PersonID: 'p-2', PronounSet: 'he/him' },
      ],
    };

    const goodReport = validator.Validate(domain, goodData);
    const goodGate = goodReport.gates.find((g) => g.name.includes('Pronoun-Gender'));
    expect(goodGate?.passed).toBe(true);
    expect(goodGate?.populationCount).toBe(2);

    const badData = {
      Person: [{ ID: 'p-1', Gender: 'Female' }],
      Profile: [{ ID: 'pr-1', PersonID: 'p-1', PronounSet: 'he/him' }], // Mismatch!
    };

    const badReport = validator.Validate(domain, badData);
    const badGate = badReport.gates.find((g) => g.name.includes('Pronoun-Gender'));
    expect(badGate?.passed).toBe(false);
  });

  it('validates minimum age at intake gate', () => {
    const domain: DomainConfig = {
      name: 'age-test',
      namespace: '00000000-0000-0000-0000-000000000003',
      packs: { core: { name: 'core', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'Person',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            DateOfBirth: { name: 'DateOfBirth', type: 'string' },
            IntakeDate: { name: 'IntakeDate', type: 'string' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const goodData = {
      Person: [
        { ID: '1', DateOfBirth: '1990-01-01', IntakeDate: '2020-01-01' }, // 30 years old
      ],
    };

    const goodReport = validator.Validate(domain, goodData);
    const goodGate = goodReport.gates.find((g) => g.name.includes('Minimum age at intake'));
    expect(goodGate?.passed).toBe(true);
    expect(goodGate?.populationCount).toBe(1);

    const badData = {
      Person: [
        { ID: '1', DateOfBirth: '2010-01-01', IntakeDate: '2020-01-01' }, // 10 years old (< 18)
      ],
    };

    const badReport = validator.Validate(domain, badData);
    const badGate = badReport.gates.find((g) => g.name.includes('Minimum age at intake'));
    expect(badGate?.passed).toBe(false);
    expect(badGate?.actual).toBe(1);
  });

  it('validates avatar uniqueness gate', () => {
    const domain: DomainConfig = {
      name: 'avatar-test',
      namespace: '00000000-0000-0000-0000-000000000004',
      packs: { core: { name: 'core', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'Person',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PhotoURL: {
              name: 'PhotoURL',
              type: 'string',
              avatar: {
                style: 'toon-head',
                format: 'base64',
              },
            },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const data = {
      Person: [
        { ID: '1', PhotoURL: 'data:image/svg+xml;base64,AAA' },
        { ID: '2', PhotoURL: 'data:image/svg+xml;base64,BBB' },
      ],
    };

    const report = validator.Validate(domain, data);
    const gate = report.gates.find((g) => g.name.includes('Avatar Uniqueness'));
    expect(gate?.passed).toBe(true);
    expect(gate?.populationCount).toBe(2);
  });

  it('validates corpus stability gate (base ⊆ head)', () => {
    const domain: DomainConfig = {
      name: 'stability-test',
      namespace: '00000000-0000-0000-0000-000000000005',
      packs: { core: { name: 'core', dependsOn: [] } },
      entities: {
        Record: {
          name: 'Record',
          targetTable: 'Record',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const baseData = {
      Record: [{ ID: 'rec-1' }, { ID: 'rec-2' }],
    };

    const headDataRetained = {
      Record: [{ ID: 'rec-1' }, { ID: 'rec-2' }, { ID: 'rec-3' }], // Added record is fine
    };

    const passReport = validator.Validate(domain, headDataRetained, { baseData });
    const passGate = passReport.gates.find((g) => g.name.includes('Corpus Stability'));
    expect(passGate?.passed).toBe(true);
    expect(passGate?.populationCount).toBe(2);

    const headDataDropped = {
      Record: [{ ID: 'rec-1' }], // rec-2 dropped!
    };

    const failReport = validator.Validate(domain, headDataDropped, { baseData });
    const failGate = failReport.gates.find((g) => g.name.includes('Corpus Stability'));
    expect(failGate?.passed).toBe(false);
    expect(failGate?.actual).toBe(1);

    // Explicit skipped status passes with 0 population
    const skipReport = validator.Validate(domain, headDataRetained, {
      baseData: { status: 'skipped', reason: 'Explicit override (SKIP_BASE_DELTA_CHECK=1)' },
    });
    const skipGate = skipReport.gates.find((g) => g.name.includes('Corpus Stability'));
    expect(skipGate?.passed).toBe(true);
    expect(skipGate?.populationCount).toBe(0);
    expect(skipGate?.message).toContain('Skipped: Explicit override');

    // Error status fails loudly
    const errReport = validator.Validate(domain, headDataRetained, {
      baseData: { status: 'error', reason: 'Could not resolve git merge-base' },
    });
    const errGate = errReport.gates.find((g) => g.name.includes('Corpus Stability'));
    expect(errGate?.passed).toBe(false);
    expect(errGate?.populationCount).toBe(0);
    expect(errGate?.message).toContain('Evaluation failed: Could not resolve git merge-base');
  });

  it('evaluates avatar uniqueness with mixed base64 data URIs and URLs honestly', () => {
    const validator = new Validator();
    const domain: DomainConfig = {
      name: 'test-mixed-avatars',
      description: 'Test mixed avatars',
      version: '1.0.0',
      entities: {
        Person: {
          name: 'Person',
          entityName: 'Person',
          schema: 'test',
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PhotoURL: { name: 'PhotoURL', type: 'string' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const svg1 = '<svg>Elena</svg>';
    const svg2 = '<svg>Marcus</svg>';
    const b64_1 = `data:image/svg+xml;base64,${Buffer.from(svg1).toString('base64')}`;
    const b64_2 = `data:image/svg+xml;base64,${Buffer.from(svg2).toString('base64')}`;
    const url1 = 'https://api.dicebear.com/9.4.2/toon-head/svg?seed=Person-3';

    const data = {
      Person: [
        { ID: 'p-1', PhotoURL: b64_1 },
        { ID: 'p-2', PhotoURL: b64_2 },
        { ID: 'p-3', PhotoURL: url1 },
      ],
    };

    const report = validator.Validate(domain, data, []);
    const gate = report.gates.find((g) => g.name.includes('Avatar Uniqueness'));
    expect(gate?.passed).toBe(true);
    expect(gate?.populationCount).toBe(3);
    expect(gate?.message).toContain('2 rendered SVGs hashed offline, 1 URLs');
  });
});
