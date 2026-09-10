import { describe, it, expect } from 'vitest';
import { Validator } from '../src/validation/validator.js';
import type { DomainConfig, FactorContract, EraConfig, HeroConfig } from '@memberjunction/loom-contracts';

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
      Person: [{ ID: 'p-1', CompanyID: 'org-nonexistent', Status: 'Active' }],
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
    const factorGate = report.gates.find((g) => g.name.includes(factor.id));
    expect(factorGate?.passed).toBe(true);
    expect(factorGate?.actual).toBe(0.75);
    expect(factorGate?.populationCount).toBe(4);
  });

  it('fails factor gate when outcome fails tolerance', () => {
    const factor: FactorContract = {
      id: 'f-renewal-fail',
      effect: 'Person',
      target: 0.90, // Target 90%
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
        { ID: 'p-2', Status: 'Lapsed' },
      ], // 1/2 = 50% vs target 90%
    };

    const report = validator.Validate(domain, data, [factor]);
    const factorGate = report.gates.find((g) => g.name.includes(factor.id));
    expect(factorGate?.passed).toBe(false);
    expect(factorGate?.actual).toBe(0.5);
  });

  it('Gate 0: verifies hero field, feature, and outcome pins (pass and fail)', () => {
    const factor: FactorContract = {
      id: 'factor-status',
      effect: 'Person',
      target: 0.8,
      tolerance: 0.2,
      evidence: { source: 'test', confidence: 'high' },
      outcome: { from: 'self', where: { Status: 'Active' } },
      arrows: {},
    };

    const goodHero = {
      heroKey: 'hero-1',
      entity: 'Person',
      businessKeys: { ID: 'p-hero' },
      fixedFields: { Status: 'Active' },
      birthCycle: 2021,
      latentDials: {},
      ladderEntries: [],
      eras: [],
      pins: [
        { kind: 'field' as const, field: 'Status', op: 'eq' as const, value: 'Active' },
        { kind: 'outcome' as const, factor: 'factor-status', cycle: 2021, value: true },
      ],
    };

    const goodData = {
      Organization: [],
      Person: [{ ID: 'p-hero', Status: 'Active' }],
    };

    const goodReport = validator.Validate(domain, goodData, [factor], [goodHero]);
    const goodHeroGate = goodReport.gates.find((g) => g.name.includes('Gate 0'));
    expect(goodHeroGate).toBeDefined();
    expect(goodHeroGate?.passed).toBe(true);

    const badData = {
      Organization: [],
      Person: [{ ID: 'p-hero', Status: 'Inactive' }],
    };

    const badReport = validator.Validate(domain, badData, [factor], [goodHero]);
    const badHeroGate = badReport.gates.find((g) => g.name.includes('Gate 0'));
    expect(badHeroGate).toBeDefined();
    expect(badHeroGate?.passed).toBe(false);
    expect(badHeroGate?.message).toContain('failed');
  });

  it('validates @lookup expressions and passes on clean references', () => {
    const data = {
      Organization: [{ ID: 'org-1' }],
      Person: [
        {
          ID: 'p-1',
          RoleRef: '@lookup:Committees: Roles.Name=Chair',
          EntityRef: '@lookup:MJ: Entities.Name=MJ_BizApps_Common: People',
          UserRef: '@lookup:MJ: Users.Email=marcus.oduya@morecheesefederation.example',
        },
      ],
    };

    const catalogs = {
      'Committees: Roles': [{ Name: 'Chair' }],
      'MJ: Entities': [{ Name: 'MJ_BizApps_Common: People' }],
      'MJ: Users': [{ Email: 'marcus.oduya@morecheesefederation.example' }],
    };

    const report = validator.Validate(domain, data, catalogs);
    const lookupGate = report.gates.find((g) => g.name.includes('Lookup Resolution'));
    expect(lookupGate).toBeDefined();
    expect(lookupGate?.passed).toBe(true);
    expect(lookupGate?.populationCount).toBe(3);
  });

  it('fails @lookup gate when expression is invalid or points to non-existent record (mutation test)', () => {
    const data = {
      Organization: [{ ID: 'org-1' }],
      Person: [
        {
          ID: 'p-1',
          BadRef: '@lookup:NonExistentEntity.Name=Bogus',
        },
      ],
    };

    const report = validator.Validate(domain, data);
    const lookupGate = report.gates.find((g) => g.name.includes('Lookup Resolution'));
    expect(lookupGate).toBeDefined();
    expect(lookupGate?.passed).toBe(false);
    expect(lookupGate?.actual).toBe(1);
    expect(lookupGate?.message).toContain('unresolved');
  });

  it('evaluates committee comments attribution: passes for members, fails for non-members (mutation test)', () => {
    const committeeDomain: DomainConfig = {
      ...domain,
      entities: {
        ...domain.entities,
        Committee: { name: 'Committee', targetTable: 'c', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } }, foreignKeys: {}, isImmutable: false },
        Meeting: { name: 'Meeting', targetTable: 'm', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, CommitteeID: { name: 'CommitteeID', type: 'uuid' } }, foreignKeys: {}, isImmutable: false },
        AgendaItem: { name: 'AgendaItem', targetTable: 'a', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, MeetingID: { name: 'MeetingID', type: 'uuid' }, Title: { name: 'Title', type: 'string' } }, foreignKeys: {}, isImmutable: false },
        CommitteeMembership: { name: 'CommitteeMembership', targetTable: 'cm', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, CommitteeID: { name: 'CommitteeID', type: 'uuid' }, PersonID: { name: 'PersonID', type: 'uuid' } }, foreignKeys: {}, isImmutable: false },
        Comment: { name: 'Comment', targetTable: 'cmt', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, AgendaItemID: { name: 'AgendaItemID', type: 'uuid' }, PersonID: { name: 'PersonID', type: 'uuid' } }, foreignKeys: {}, isImmutable: false },
      },
      relationalRules: [
        {
          kind: 'path-match',
          name: 'Comment Author Committee Membership',
          sourceEntity: 'Comment',
          path: ['AgendaItemID:AgendaItem', 'MeetingID:Meeting'],
          targetField: 'CommitteeID',
          inclusion: {
            poolEntity: 'CommitteeMembership',
            poolItemField: 'PersonID',
            poolContainerField: 'CommitteeID',
            sourceItemField: 'PersonID',
          },
        },
      ],
    };

    const validData = {
      Organization: [],
      Person: [{ ID: 'p-member' }, { ID: 'p-outsider' }],
      Committee: [{ ID: 'comm-1' }],
      Meeting: [{ ID: 'meet-1', CommitteeID: 'comm-1' }],
      AgendaItem: [{ ID: 'ai-1', MeetingID: 'meet-1', Title: 'Annual Audit' }],
      CommitteeMembership: [{ ID: 'cm-1', CommitteeID: 'comm-1', PersonID: 'p-member' }],
      Comment: [{ ID: 'cmt-1', AgendaItemID: 'ai-1', PersonID: 'p-member' }],
    };

    const passReport = validator.Validate(committeeDomain, validData);
    const commGate = passReport.gates.find((g) => g.name.includes('Comment Author Committee Membership'));
    expect(commGate).toBeDefined();
    expect(commGate?.passed).toBe(true);

    // Mutate comment author to outsider
    const mutatedData = {
      ...validData,
      Comment: [{ ID: 'cmt-1', AgendaItemID: 'ai-1', PersonID: 'p-outsider' }],
    };
    const failReport = validator.Validate(committeeDomain, mutatedData);
    const failCommGate = failReport.gates.find((g) => g.name.includes('Comment Author Committee Membership'));
    expect(failCommGate).toBeDefined();
    expect(failCommGate?.passed).toBe(false);
    expect(failCommGate?.actual).toBe(1);
  });

  it('evaluates member activities tenure: passes within window, fails outside (mutation test)', () => {
    const tenureDomain: DomainConfig = {
      ...domain,
      entities: {
        ...domain.entities,
        MembershipPeriod: { name: 'MembershipPeriod', targetTable: 'mp', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, PersonID: { name: 'PersonID', type: 'uuid' }, StartDate: { name: 'StartDate', type: 'date' }, EndDate: { name: 'EndDate', type: 'date' } }, foreignKeys: {}, isImmutable: false },
        Activity: { name: 'Activity', targetTable: 'act', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, PersonID: { name: 'PersonID', type: 'uuid' }, ActivityDate: { name: 'ActivityDate', type: 'date' } }, foreignKeys: {}, isImmutable: false },
      },
      relationalRules: [
        {
          kind: 'date-window',
          name: 'Activity Within Membership Window',
          sourceEntity: 'Activity',
          dateField: 'ActivityDate',
          windowEntity: 'MembershipPeriod',
          windowForeignKey: 'PersonID',
          windowStartField: 'StartDate',
          windowEndField: 'EndDate',
        },
      ],
    };

    const validData = {
      Organization: [],
      Person: [{ ID: 'p-1' }],
      MembershipPeriod: [{ ID: 'mp-1', PersonID: 'p-1', StartDate: '2023-01-01', EndDate: '2023-12-31' }],
      Activity: [{ ID: 'act-1', PersonID: 'p-1', ActivityDate: '2023-06-15' }],
    };

    const passReport = validator.Validate(tenureDomain, validData);
    const tenureGate = passReport.gates.find((g) => g.name.includes('Activity Within Membership Window'));
    expect(tenureGate).toBeDefined();
    expect(tenureGate?.passed).toBe(true);

    // Mutate activity date to outside membership tenure
    const mutatedData = {
      ...validData,
      Activity: [{ ID: 'act-1', PersonID: 'p-1', ActivityDate: '2025-06-15' }],
    };
    const failReport = validator.Validate(tenureDomain, mutatedData);
    const failTenureGate = failReport.gates.find((g) => g.name.includes('Activity Within Membership Window'));
    expect(failTenureGate).toBeDefined();
    expect(failTenureGate?.passed).toBe(false);
    expect(failTenureGate?.actual).toBe(1);
  });

  it('evaluates meeting minutes context: passes with date and agenda references, fails on generic boilerplate (mutation test)', () => {
    const minutesDomain: DomainConfig = {
      ...domain,
      entities: {
        ...domain.entities,
        Meeting: { name: 'Meeting', targetTable: 'm', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, Name: { name: 'Name', type: 'string' }, MeetingDate: { name: 'MeetingDate', type: 'date' } }, foreignKeys: {}, isImmutable: false },
        AgendaItem: { name: 'AgendaItem', targetTable: 'ai', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, MeetingID: { name: 'MeetingID', type: 'uuid' }, Title: { name: 'Title', type: 'string' } }, foreignKeys: {}, isImmutable: false },
        Minute: { name: 'Minute', targetTable: 'min', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, MeetingID: { name: 'MeetingID', type: 'uuid' }, Content: { name: 'Content', type: 'string' } }, foreignKeys: {}, isImmutable: false },
      },
      relationalRules: [
        {
          kind: 'text-contains-path',
          name: 'Minute Context and Agenda Reference',
          sourceEntity: 'Minute',
          textField: 'Content',
          path: ['MeetingID:Meeting'],
          targetFields: ['Name', 'MeetingDate'],
          childReferences: {
            childEntity: 'AgendaItem',
            foreignKey: 'MeetingID',
            childField: 'Title',
          },
        },
      ],
    };

    const validData = {
      Organization: [],
      Person: [],
      Meeting: [{ ID: 'meet-1', Name: 'Standards Committee Q2 Meeting', MeetingDate: '2024-04-10' }],
      AgendaItem: [{ ID: 'ai-1', MeetingID: 'meet-1', Title: 'Raw Milk Standards Review' }],
      Minute: [{
        ID: 'min-1',
        MeetingID: 'meet-1',
        Content: 'Minutes of Standards Committee Q2 Meeting held on 2024-04-10. Agenda review: Raw Milk Standards Review discussed extensively.',
      }],
    };

    const passReport = validator.Validate(minutesDomain, validData);
    const minGate = passReport.gates.find((g) => g.name.includes('Minute Context and Agenda Reference'));
    expect(minGate).toBeDefined();
    expect(minGate?.passed).toBe(true);

    // Mutate minute to generic text lacking meeting context/agenda
    const mutatedData = {
      ...validData,
      Minute: [{
        ID: 'min-1',
        MeetingID: 'meet-1',
        Content: 'Routine discussion held.',
      }],
    };
    const failReport = validator.Validate(minutesDomain, mutatedData);
    const failMinGate = failReport.gates.find((g) => g.name.includes('Minute Context and Agenda Reference'));
    expect(failMinGate).toBeDefined();
    expect(failMinGate?.passed).toBe(false);
  });

  it('throws upfront when relational rule references an unknown entity (R2-3 mutation test)', () => {
    const ghostDomain: DomainConfig = {
      ...domain,
      relationalRules: [
        {
          kind: 'path-match',
          name: 'Ghost Rule',
          sourceEntity: 'NoSuchEntity',
          path: ['SomeID:OtherEntity'],
          targetField: 'ID',
        },
      ],
    };

    expect(() => validator.Validate(ghostDomain, { Organization: [], Person: [] })).toThrow(
      /Relational rule 'Ghost Rule': unknown entity 'NoSuchEntity' referenced in rule definition/
    );
  });

  it('emits gate with populationCount: 0 when relational rule source entity has zero records (R2-3)', () => {
    const zeroDomain: DomainConfig = {
      ...domain,
      entities: {
        ...domain.entities,
        Meeting: { name: 'Meeting', targetTable: 'm', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } }, foreignKeys: {}, isImmutable: false },
        Comment: { name: 'Comment', targetTable: 'cmt', schema: 's', pack: 'p', businessKey: ['ID'], fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true }, MeetingID: { name: 'MeetingID', type: 'uuid' } }, foreignKeys: {}, isImmutable: false },
      },
      relationalRules: [
        {
          kind: 'path-match',
          name: 'Empty Source Rule',
          sourceEntity: 'Comment',
          path: ['MeetingID:Meeting'],
          targetField: 'ID',
        },
      ],
    };

    const report = validator.Validate(zeroDomain, { Organization: [], Person: [], Meeting: [], Comment: [] });
    const gate = report.gates.find((g) => g.name.includes('Empty Source Rule'));
    expect(gate).toBeDefined();
    expect(gate?.passed).toBe(true);
    expect(gate?.populationCount).toBe(0);
  });

  it('resolves cycle field via endsWith(On), type: date, or explicit cycleField (D.6)', () => {
    const eraDomain: DomainConfig = {
      name: 'era-test',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Registration: {
          name: 'Registration',
          targetTable: 'reg',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            RegisteredOn: { name: 'RegisteredOn', type: 'date' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const era: EraConfig = {
      eraKey: 'era-2020',
      scope: 'all',
      cycles: [2020],
      factorAdjustments: [],
      volumeMultipliers: [{ entity: 'Registration', multiplier: 0.5 }],
    };

    // 10 records in 2019 baseline, 5 in 2020 (exact 0.5x match)
    const records = [
      ...Array.from({ length: 10 }, (_, i) => ({ ID: `b-${i}`, RegisteredOn: '2019-06-01' })),
      ...Array.from({ length: 5 }, (_, i) => ({ ID: `e-${i}`, RegisteredOn: '2020-06-01' })),
    ];

    const report = validator.Validate(eraDomain, { Registration: records }, [], [], [era]);
    const eraGate = report.gates.find((g) => g.name.includes('Realized Era Volume: era-2020 [Registration in 2020]'));
    expect(eraGate).toBeDefined();
    expect(eraGate?.passed).toBe(true);
    expect(eraGate?.populationCount).toBe(5);
  });

  it('emits failing gate when entity has era volume multiplier but unresolvable cycle field (D.6)', () => {
    const eraDomain: DomainConfig = {
      name: 'era-test',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        StaticCatalog: {
          name: 'StaticCatalog',
          targetTable: 'cat',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            Description: { name: 'Description', type: 'string' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const era: EraConfig = {
      eraKey: 'era-shock',
      scope: 'all',
      cycles: [2020],
      factorAdjustments: [],
      volumeMultipliers: [{ entity: 'StaticCatalog', multiplier: 0.5 }],
    };

    const report = validator.Validate(eraDomain, { StaticCatalog: [{ ID: 'c-1', Description: 'Item' }] }, [], [], [era]);
    const unresolvableGate = report.gates.find((g) => g.name.includes('StaticCatalog in 2020'));
    expect(unresolvableGate).toBeDefined();
    expect(unresolvableGate?.passed).toBe(false);
    expect(unresolvableGate?.category).toBe('era');
    expect(unresolvableGate?.message).toContain("no cycle field could be resolved on 'StaticCatalog' or its foreign keys");
  });

  it('fails era volume gate when baseline record count is 0 for non-zero multiplier (D.6a)', () => {
    const eraDomain: DomainConfig = {
      name: 'era-zero-baseline',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Registration: {
          name: 'Registration',
          targetTable: 'reg',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            RegisteredOn: { name: 'RegisteredOn', type: 'date' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const era: EraConfig = {
      eraKey: 'era-2020',
      scope: 'all',
      cycles: [2020],
      factorAdjustments: [],
      volumeMultipliers: [{ entity: 'Registration', multiplier: 0.5 }],
    };

    // Records have invalid/unresolvable dates so year is undefined (attributed to no cycle)
    const records = [
      { ID: 'r-1', RegisteredOn: 'not-a-date' },
    ];

    const report = validator.Validate(eraDomain, { Registration: records }, [], [], [era]);
    const eraGate = report.gates.find((g) => g.name.includes('Realized Era Volume: era-2020 [Registration in 2020]'));
    expect(eraGate).toBeDefined();
    expect(eraGate?.passed).toBe(false);
    expect(eraGate?.message).toContain('0 baseline records found across non-era cycles');
  });

  it('fails hero outcome pin when child entity has no resolvable cycle field and pin specifies cycle (D.7)', () => {
    const heroDomain: DomainConfig = {
      name: 'hero-test',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'p',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } },
          foreignKeys: {},
          isImmutable: false,
        },
        Action: {
          name: 'Action',
          targetTable: 'a',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PersonID: { name: 'PersonID', type: 'uuid' },
            Completed: { name: 'Completed', type: 'boolean' },
          },
          foreignKeys: {
            FK_Action_Person: {
              fieldName: 'PersonID',
              targetEntity: 'Person',
              targetField: 'ID',
              cardinality: 'many-to-one',
            },
          },
          isImmutable: false,
        },
      },
    };

    const factor: FactorContract = {
      id: 'factor-action-completed',
      category: 'behavioral',
      scope: 'individual',
      effect: 'Action',
      outcome: { from: 'self', where: { Completed: true } },
      arrows: {},
    };

    const hero: HeroConfig = {
      heroKey: 'hero-action',
      entity: 'Person',
      businessKeys: { ID: 'p-1' },
      fixedFields: {},
      birthCycle: 2019,
      latentDials: {},
      ladderEntries: [],
      eras: [],
      pins: [
        { kind: 'outcome', factor: 'factor-action-completed', cycle: 2020, value: true },
      ],
    };

    const data = {
      Person: [{ ID: 'p-1' }],
      Action: [{ ID: 'a-1', PersonID: 'p-1', Completed: true }],
    };

    const report = validator.Validate(heroDomain, data, [factor], [hero]);
    const heroGate = report.gates.find((g) => g.name.includes('hero-action'));
    expect(heroGate).toBeDefined();
    expect(heroGate?.passed).toBe(false);
    expect(heroGate?.message).toContain("no cycle field could be resolved on child entity 'Action'");
  });

  it('correctly matches child record by resolved cycle field for hero outcome pin with cycle (D.7)', () => {
    const heroDomain: DomainConfig = {
      name: 'hero-test',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'p',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } },
          foreignKeys: {},
          isImmutable: false,
        },
        Registration: {
          name: 'Registration',
          targetTable: 'reg',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PersonID: { name: 'PersonID', type: 'uuid' },
            RegisteredOn: { name: 'RegisteredOn', type: 'date' },
            Attended: { name: 'Attended', type: 'boolean' },
          },
          foreignKeys: {
            FK_Reg_Person: {
              fieldName: 'PersonID',
              targetEntity: 'Person',
              targetField: 'ID',
              cardinality: 'many-to-one',
            },
          },
          isImmutable: false,
        },
      },
    };

    const factor: FactorContract = {
      id: 'factor-attendance',
      category: 'behavioral',
      scope: 'individual',
      effect: 'Registration',
      outcome: { from: 'self', where: { Attended: true } },
      arrows: {},
    };

    // Hero asserts they attended in 2020
    const hero: HeroConfig = {
      heroKey: 'hero-attendee',
      entity: 'Person',
      businessKeys: { ID: 'p-1' },
      fixedFields: {},
      birthCycle: 2019,
      latentDials: {},
      ladderEntries: [],
      eras: [],
      pins: [
        { kind: 'outcome', factor: 'factor-attendance', cycle: 2020, value: true },
      ],
    };

    // First child is 2019 Attended: false (would cause false failure if matched children[0]);
    // Second child is 2020 Attended: true
    const data = {
      Person: [{ ID: 'p-1' }],
      Registration: [
        { ID: 'r-2019', PersonID: 'p-1', RegisteredOn: '2019-06-15', Attended: false },
        { ID: 'r-2020', PersonID: 'p-1', RegisteredOn: '2020-06-15', Attended: true },
      ],
    };

    const report = validator.Validate(heroDomain, data, [factor], [hero]);
    const heroGate = report.gates.find((g) => g.name.includes('hero-attendee'));
    expect(heroGate).toBeDefined();
    expect(heroGate?.passed).toBe(true);
    expect(heroGate?.message).toContain('All 1 pin(s) satisfied');
  });

  it('fails hero outcome pin when child entity has multiple candidate date fields and no explicit cycleField (D.9)', () => {
    const heroDomain: DomainConfig = {
      name: 'hero-test-multi',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'p',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } },
          foreignKeys: {},
          isImmutable: false,
        },
        MembershipPeriod: {
          name: 'MembershipPeriod',
          targetTable: 'mp',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PersonID: { name: 'PersonID', type: 'uuid' },
            StartDate: { name: 'StartDate', type: 'date' },
            EndDate: { name: 'EndDate', type: 'date' },
            RenewalDate: { name: 'RenewalDate', type: 'date' },
            Active: { name: 'Active', type: 'boolean' },
          },
          foreignKeys: {
            FK_MP_Person: {
              fieldName: 'PersonID',
              targetEntity: 'Person',
              targetField: 'ID',
              cardinality: 'many-to-one',
            },
          },
          isImmutable: false,
        },
      },
    };

    const factor: FactorContract = {
      id: 'factor-renewal',
      category: 'behavioral',
      scope: 'individual',
      effect: 'MembershipPeriod',
      outcome: { from: 'self', where: { Active: true } },
      arrows: {},
    };

    const hero: HeroConfig = {
      heroKey: 'hero-renewal',
      entity: 'Person',
      businessKeys: { ID: 'p-1' },
      fixedFields: {},
      birthCycle: 2024,
      latentDials: {},
      ladderEntries: [],
      eras: [],
      pins: [
        { kind: 'outcome', factor: 'factor-renewal', cycle: 2026, value: true },
      ],
    };

    const data = {
      Person: [{ ID: 'p-1' }],
      MembershipPeriod: [
        { ID: 'mp-1', PersonID: 'p-1', StartDate: '2025-03-21', EndDate: '2026-03-20', RenewalDate: '2026-03-20', Active: true },
      ],
    };

    const report = validator.Validate(heroDomain, data, [factor], [hero]);
    const heroGate = report.gates.find((g) => g.name.includes('hero-renewal'));
    expect(heroGate).toBeDefined();
    expect(heroGate?.passed).toBe(false);
    expect(heroGate?.message).toContain('multiple candidate date fields (StartDate, EndDate, RenewalDate)');
    expect(heroGate?.message).toContain("explicit 'cycleField' declaration required");
  });

  it('succeeds hero outcome pin when child entity has multiple candidate date fields with explicit cycleField configured (D.9)', () => {
    const heroDomain: DomainConfig = {
      name: 'hero-test-explicit',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Person: {
          name: 'Person',
          targetTable: 'p',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } },
          foreignKeys: {},
          isImmutable: false,
        },
        MembershipPeriod: {
          name: 'MembershipPeriod',
          targetTable: 'mp',
          schema: 'dbo',
          pack: 'common',
          cycleField: 'RenewalDate',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            PersonID: { name: 'PersonID', type: 'uuid' },
            StartDate: { name: 'StartDate', type: 'date' },
            EndDate: { name: 'EndDate', type: 'date' },
            RenewalDate: { name: 'RenewalDate', type: 'date' },
            Active: { name: 'Active', type: 'boolean' },
          },
          foreignKeys: {
            FK_MP_Person: {
              fieldName: 'PersonID',
              targetEntity: 'Person',
              targetField: 'ID',
              cardinality: 'many-to-one',
            },
          },
          isImmutable: false,
        },
      },
    };

    const factor: FactorContract = {
      id: 'factor-renewal',
      category: 'behavioral',
      scope: 'individual',
      effect: 'MembershipPeriod',
      outcome: { from: 'self', where: { Active: true } },
      arrows: {},
    };

    const hero: HeroConfig = {
      heroKey: 'hero-renewal-explicit',
      entity: 'Person',
      businessKeys: { ID: 'p-1' },
      fixedFields: {},
      birthCycle: 2024,
      latentDials: {},
      ladderEntries: [],
      eras: [],
      pins: [
        { kind: 'outcome', factor: 'factor-renewal', cycle: 2026, value: true },
      ],
    };

    const data = {
      Person: [{ ID: 'p-1' }],
      MembershipPeriod: [
        { ID: 'mp-1', PersonID: 'p-1', StartDate: '2025-03-21', EndDate: '2026-03-20', RenewalDate: '2026-03-20', Active: true },
      ],
    };

    const report = validator.Validate(heroDomain, data, [factor], [hero]);
    const heroGate = report.gates.find((g) => g.name.includes('hero-renewal-explicit'));
    expect(heroGate).toBeDefined();
    expect(heroGate?.passed).toBe(true);
    expect(heroGate?.message).toContain('All 1 pin(s) satisfied');
  });

  it('fails era volume gate when entity has multiple candidate date fields and no explicit cycleField (D.9)', () => {
    const eraDomain: DomainConfig = {
      name: 'era-multi-candidate',
      namespace: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      packs: { common: { name: 'common', dependsOn: [] } },
      entities: {
        Order: {
          name: 'Order',
          targetTable: 'ord',
          schema: 'dbo',
          pack: 'common',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            OrderDate: { name: 'OrderDate', type: 'date' },
            DueDate: { name: 'DueDate', type: 'date' },
          },
          foreignKeys: {},
          isImmutable: false,
        },
      },
    };

    const era: EraConfig = {
      eraKey: 'era-recession',
      scope: 'all',
      cycles: [2023],
      factorAdjustments: [],
      volumeMultipliers: [{ entity: 'Order', multiplier: 0.8 }],
    };

    const records = [
      { ID: 'o-1', OrderDate: '2022-01-01', DueDate: '2022-01-15' },
    ];

    const report = validator.Validate(eraDomain, { Order: records }, [], [], [era]);
    const eraGate = report.gates.find((g) => g.name.includes('Realized Era Volume: era-recession [Order in 2023]'));
    expect(eraGate).toBeDefined();
    expect(eraGate?.passed).toBe(false);
    expect(eraGate?.message).toContain('multiple candidate date fields (OrderDate, DueDate)');
    expect(eraGate?.message).toContain("explicit 'cycleField' declaration required");
  });
});

