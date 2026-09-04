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
});
