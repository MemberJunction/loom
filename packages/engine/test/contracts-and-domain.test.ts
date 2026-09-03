import { describe, it, expect } from 'vitest';
import {
  HeroConfigSchema,
  validateHeroesAgainstDomain,
  validateMotifsAgainstDomain,
  validateLaddersAgainstDomain,
  validateErasAgainstDomain,
  type DomainConfig,
  type HeroesManifest,
  type MotifsManifest,
  type LaddersManifest,
  type ErasManifest,
} from '@memberjunction/loom-contracts';

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
});
