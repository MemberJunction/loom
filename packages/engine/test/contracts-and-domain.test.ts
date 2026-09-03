import { describe, it, expect } from 'vitest';
import {
  HeroConfigSchema,
  PinOpSchema,
  DomainConfigSchema,
  FactorOverrideSchema,
  validateHeroesAgainstDomain,
  validateMotifsAgainstDomain,
  validateLaddersAgainstDomain,
  validateErasAgainstDomain,
  type DomainConfig,
  type HeroesManifest,
  type MotifsManifest,
  type LaddersManifest,
  type ErasManifest,
  type FactorContract,
} from '@memberjunction/loom-contracts';
import { HeroInjector } from '../src/heroes/HeroInjector.js';
import { RetrospectiveUnroller } from '../src/simulation/RetrospectiveUnroller.js';
import { MotifSampler } from '../src/motifs/MotifSampler.js';
import { StateLadderEngine } from '../src/ladders/StateLadderEngine.js';
import { createRng } from '../src/math/rng.js';

describe('Plan 02 Strict Schemas and Domain Validation (Gate 0 / L4a)', () => {
  const sampleDomain: DomainConfig = {
    name: 'test-domain',
    namespace: 'b1e4c4d5-8f6a-4d2b-9e3a-7a5c8d1f2e34',
    packs: {},
    entities: {
      Person: {
        name: 'Person',
        targetTable: 'Person',
        schema: 'test',
        pack: 'core',
        businessKey: ['Email'],
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          Email: { name: 'Email', type: 'string' },
          FirstName: { name: 'FirstName', type: 'string' },
          Status: { name: 'Status', type: 'string' },
        },
        foreignKeys: {},
        isImmutable: false,
      },
      CommitteeMember: {
        name: 'CommitteeMember',
        targetTable: 'CommitteeMember',
        schema: 'test',
        pack: 'core',
        businessKey: ['PersonID', 'Role'],
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          PersonID: { name: 'PersonID', type: 'uuid' },
          Role: { name: 'Role', type: 'string' },
          TermID: { name: 'TermID', type: 'uuid' },
        },
        foreignKeys: {
          PersonID: { fieldName: 'PersonID', targetEntity: 'Person', targetField: 'ID', cardinality: 'many-to-one' },
        },
        isImmutable: false,
      },
    },
  };

  it('rejects unexpected keys via strict() schemas (e.g. primaryKey)', () => {
    const validHero = {
      heroKey: 'test-hero',
      entity: 'Person',
      businessKeys: { Email: 'test@example.com' },
      fixedFields: { FirstName: 'Alex' },
      birthCycle: 2022,
      latentDials: { engagement: 1.5 },
      ladderEntries: [],
      eras: [],
      pins: [],
    };

    const validRes = HeroConfigSchema.safeParse(validHero);
    expect(validRes.success).toBe(true);

    // Adding primaryKey must be rejected under .strict()
    const invalidHero = {
      ...validHero,
      primaryKey: '11111111-2222-3333-4444-555555555555',
    };

    const invalidRes = HeroConfigSchema.safeParse(invalidHero);
    expect(invalidRes.success).toBe(false);
  });

  it('validates hero manifest against domain: accepts good fixture and rejects undeclared fields naming them', () => {
    const goodManifest: HeroesManifest = {
      heroes: [
        {
          heroKey: 'good-hero',
          entity: 'Person',
          businessKeys: { Email: 'good@example.com' },
          fixedFields: { FirstName: 'Elena' },
          birthCycle: 2022,
          latentDials: {},
          ladderEntries: [],
          eras: [],
          pins: [
            { kind: 'field', field: 'Status', op: 'eq', value: 'Active' },
          ],
        },
      ],
    };

    const goodRes = validateHeroesAgainstDomain(goodManifest, sampleDomain);
    expect(goodRes.valid).toBe(true);
    expect(goodRes.errors).toHaveLength(0);

    const badManifest: HeroesManifest = {
      heroes: [
        {
          heroKey: 'bad-hero',
          entity: 'Person',
          businessKeys: { Email: 'bad@example.com' },
          fixedFields: { NonExistentField: 'Oops' },
          birthCycle: 2022,
          latentDials: {},
          ladderEntries: [],
          eras: [],
          pins: [
            { kind: 'field', field: 'AnotherBadField', op: 'eq', value: 'Active' },
          ],
        },
      ],
    };

    const badRes = validateHeroesAgainstDomain(badManifest, sampleDomain);
    expect(badRes.valid).toBe(false);
    expect(badRes.errors).toHaveLength(2);
    expect(badRes.errors[0]).toContain('Person.NonExistentField');
    expect(badRes.errors[1]).toContain('Person.AnotherBadField');
  });

  it('validates ladders manifest against domain and rejects invalid binding fields', () => {
    const validLadderManifest: LaddersManifest = {
      ladders: [
        {
          ladderKey: 'gov-ladder',
          entity: 'Person',
          binding: {
            mode: 'childEntity',
            childEntity: 'CommitteeMember',
            foreignKey: 'PersonID',
            stateField: 'Role',
            termField: 'TermID',
          },
          cohortShare: 0.1,
          states: [{ name: 'director', durationCycles: 2, effects: [], exitEffects: [] }],
        },
      ],
    };

    const validLadderRes = validateLaddersAgainstDomain(validLadderManifest, sampleDomain);
    expect(validLadderRes.valid).toBe(true);

    const badLadderManifest: LaddersManifest = {
      ladders: [
        {
          ladderKey: 'bad-gov-ladder',
          entity: 'Person',
          binding: {
            mode: 'childEntity',
            childEntity: 'CommitteeMember',
            foreignKey: 'NonExistentFK',
            stateField: 'NonExistentRole',
          },
          cohortShare: 0.1,
          states: [{ name: 'director', durationCycles: 2, effects: [], exitEffects: [] }],
        },
      ],
    };

    const badLadderRes = validateLaddersAgainstDomain(badLadderManifest, sampleDomain);
    expect(badLadderRes.valid).toBe(false);
    expect(badLadderRes.errors.some((e) => e.includes('CommitteeMember.NonExistentFK'))).toBe(true);
  });

  // N1: PinOpSchema options test
  it('N1: exercises every op in PinOpSchema.options through EvaluatePinOp', () => {
    const ops = PinOpSchema.options;
    expect(ops).toContain('ne');
    expect(ops).toContain('neq');
    expect(ops).toContain('eq');

    expect(HeroInjector.EvaluatePinOp('eq', 'Active', 'Active')).toBe(true);
    expect(HeroInjector.EvaluatePinOp('eq', 'Active', 'Lapsed')).toBe(false);
    expect(HeroInjector.EvaluatePinOp('ne', 'Active', 'Lapsed')).toBe(true);
    expect(HeroInjector.EvaluatePinOp('ne', 'Active', 'Active')).toBe(false);
    expect(HeroInjector.EvaluatePinOp('neq', 'Active', 'Lapsed')).toBe(true);
    expect(HeroInjector.EvaluatePinOp('neq', 'Active', 'Active')).toBe(false);
    expect(HeroInjector.EvaluatePinOp('gt', 10, 5)).toBe(true);
    expect(HeroInjector.EvaluatePinOp('gt', 5, 10)).toBe(false);
    expect(HeroInjector.EvaluatePinOp('gte', 10, 10)).toBe(true);
    expect(HeroInjector.EvaluatePinOp('lt', 5, 10)).toBe(true);
    expect(HeroInjector.EvaluatePinOp('lte', 10, 10)).toBe(true);
    expect(HeroInjector.EvaluatePinOp('in', 'Gold', ['Silver', 'Gold', 'Platinum'])).toBe(true);
    expect(HeroInjector.EvaluatePinOp('in', 'Bronze', ['Silver', 'Gold', 'Platinum'])).toBe(false);
    expect(HeroInjector.EvaluatePinOp('exists', 'value', true)).toBe(true);
    expect(HeroInjector.EvaluatePinOp('exists', null, true)).toBe(false);
    expect(HeroInjector.EvaluatePinOp('withinCyclesOfAsOf', 2, 3)).toBe(true);
    expect(HeroInjector.EvaluatePinOp('withinCyclesOfAsOf', 5, 3)).toBe(false);
  });

  // N2: ForeignKeyConfigSchema transform test
  it('N2: ForeignKeyConfigSchema transform normalizes fieldName to fkKey for both generation and validation', () => {
    const rawDomain = {
      name: 'n2-domain',
      namespace: 'b1e4c4d5-8f6a-4d2b-9e3a-7a5c8d1f2e34',
      packs: {},
      entities: {
        Parent: {
          name: 'Parent',
          targetTable: 'Parent',
          schema: 'test',
          pack: 'core',
          businessKey: ['Code'],
          fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, Code: { name: 'Code', type: 'string' } },
          foreignKeys: {},
        },
        Child: {
          name: 'Child',
          targetTable: 'Child',
          schema: 'test',
          pack: 'core',
          businessKey: ['ChildCode'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            ChildCode: { name: 'ChildCode', type: 'string' },
            ParentID: { name: 'ParentID', type: 'uuid' },
          },
          foreignKeys: {
            // No fieldName explicitly provided; key is 'ParentID'
            ParentID: {
              targetEntity: 'Parent',
              targetField: 'ID',
              cardinality: 'many-to-one',
            },
          },
        },
      },
    };

    const parsed = DomainConfigSchema.parse(rawDomain);
    const childFk = parsed.entities['Child']?.foreignKeys['ParentID'];
    expect(childFk).toBeDefined();
    expect(childFk?.fieldName).toBe('ParentID');
  });

  // N3: Arrow evaluation with RelationalContext and arrow-specific beta override
  it('N3: evaluates childEntity aggregation arrow with RelationalContext, and applies beta override strictly to named arrow', () => {
    // 1. Verify FactorOverrideSchema rejects beta without arrow
    const invalidOverride = {
      factor: 'factor-renewal',
      beta: 1.5,
    };
    const invRes = FactorOverrideSchema.safeParse(invalidOverride);
    expect(invRes.success).toBe(false);

    const validOverride = {
      factor: 'factor-renewal',
      arrow: 'tenure',
      beta: 2.5,
    };
    const valRes = FactorOverrideSchema.safeParse(validOverride);
    expect(valRes.success).toBe(true);

    // 2. Test arrow evaluation with child aggregation in RetrospectiveUnroller
    const contract: FactorContract = {
      id: 'factor-renewal',
      effect: 'Person',
      target: 0.8,
      tolerance: 0.1,
      evidence: { source: 'test', confidence: 'high' },
      outcome: { from: 'self', where: { Status: 'Active' } },
      arrows: {
        tenure: { name: 'tenure', beta: 0.5 },
        committeeCount: {
          name: 'committeeCount',
          beta: 1.0,
          feature: {
            from: 'CommitteeMember',
            aggregation: 'count',
            field: 'ID',
          },
        },
      },
    };

    const heroInjector = new HeroInjector('test', 'b1e4c4d5-8f6a-4d2b-9e3a-7a5c8d1f2e34', []);
    const motifSampler = new MotifSampler([
      {
        motifKey: 'tenure-booster',
        targetEntity: 'Person',
        quota: { mode: 'count', value: 1 },
        childRates: [],
        eras: [],
        factorOverrides: [
          { factor: 'factor-renewal', arrow: 'tenure', beta: 3.0 },
        ],
      },
    ]);
    const ladderEngine = new StateLadderEngine([]);

    const unroller = new RetrospectiveUnroller({
      cycles: [2026],
      entities: [
        { id: 'p1', entity: 'Person', birthCycle: 2022, latentDials: { tenure: 2.0 }, isHero: false },
        { id: 'c1', entity: 'CommitteeMember', birthCycle: 2022, fixedFields: { PersonID: 'p1' }, isHero: false },
      ],
      heroInjector,
      motifSampler,
      ladderEngine,
      factorContracts: [contract],
    });

    const rng = createRng(42, 'test-n3');
    unroller.Initialize(rng);
    // Evaluating child aggregation with RelationalContext should not throw
    const snapshots = unroller.Run(rng);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.outcomesCount['factor-renewal']).toBeDefined();
  });

  // N4: validate*AgainstDomain parses raw unparsed input safely without TypeError
  it('N4: validate*AgainstDomain parses raw unparsed input safely without throwing TypeError', () => {
    const rawMalformedHeroManifest = {
      heroes: [
        {
          // Missing required fields
          heroKey: 'broken-hero',
        },
      ],
    };

    // Must not throw TypeError; must return valid: false with descriptive error messages
    const res = validateHeroesAgainstDomain(rawMalformedHeroManifest, sampleDomain);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toContain('HeroesManifest');
  });
});
