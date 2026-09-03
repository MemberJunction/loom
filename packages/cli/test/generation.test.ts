import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { createRng, IdentityService, Validator } from '@memberjunction/loom-engine';
import { DomainConfigSchema, type DomainConfig } from '@memberjunction/loom-contracts';
import { generateEntityRecord } from '../src/generation.js';

describe('CLI Record Generator: generateEntityRecord', () => {
  const enterpriseDomainPath = path.resolve(__dirname, '../../../projects/enterprise/domain.json');
  const namespaceUuid = 'b1e4c4d5-8f6a-4d2b-9e3a-7a5c8d1f2e34';

  it('generates rows where emitted keys strictly equal declared fields for all 7 enterprise entities', async () => {
    const raw = await fs.readFile(enterpriseDomainPath, 'utf8');
    const domain: DomainConfig = JSON.parse(raw);
    const rng = createRng(42);
    const identityService = new IdentityService();
    identityService.RegisterNamespace(domain.name, namespaceUuid);

    const pools: Record<string, Record<string, unknown>[]> = {};

    // Generate in topological order so parent pools exist
    const entityOrder = [
      'Company',
      'Product',
      'Member',
      'Subscription',
      'OrderHeader',
      'OrderLine',
      'Payment',
    ];

    for (const entity of entityOrder) {
      pools[entity] = [];
      const entityCfg = domain.entities[entity];
      const declaredFieldNames = Object.keys(entityCfg.fields).sort();

      for (let i = 1; i <= 5; i++) {
        const row = generateEntityRecord({
          domain,
          entity,
          i,
          parentPool: pools,
          rng,
          identityService,
        });

        pools[entity].push(row);

        const emittedKeys = Object.keys(row).sort();
        expect(
          emittedKeys,
          `Mismatch in entity '${entity}' between emitted keys and declared fields`
        ).toEqual(declaredFieldNames);
      }
    }
  });

  it('mints primary key UUIDs from declared business keys (same business keys produce identical UUID)', async () => {
    const raw = await fs.readFile(enterpriseDomainPath, 'utf8');
    const domain: DomainConfig = JSON.parse(raw);
    const rng = createRng(100);
    const identityService = new IdentityService();
    identityService.RegisterNamespace(domain.name, namespaceUuid);

    // For Company, businessKey is ["Name"]
    const rowA = generateEntityRecord({
      domain,
      entity: 'Company',
      i: 1,
      parentPool: {},
      rng,
      identityService,
    });

    const expectedUuid = identityService.MintId(domain.name, 'Company', [String(rowA.Name)]);
    expect(rowA.ID).toBe(expectedUuid);

    // Another row generated with identical Name must mint the exact same UUID
    const rowB = generateEntityRecord({
      domain,
      entity: 'Company',
      i: 1,
      parentPool: {},
      rng,
      identityService,
    });

    expect(rowA.ID).toBe(rowB.ID);
  });

  it('throws an explicit error when required foreign key parent records are missing', async () => {
    const raw = await fs.readFile(enterpriseDomainPath, 'utf8');
    const domain: DomainConfig = JSON.parse(raw);
    const rng = createRng(42);
    const identityService = new IdentityService();
    identityService.RegisterNamespace(domain.name, namespaceUuid);

    // Member requires Company, but parentPool is empty
    expect(() =>
      generateEntityRecord({
        domain,
        entity: 'Member',
        i: 1,
        parentPool: {},
        rng,
        identityService,
      })
    ).toThrow(/No parent records available for foreign key Member\.CompanyID -> Company/);
  });

  it('N2 round-trip: generation and validation resolve the same column on a domain with an unnamed foreign key', () => {
    const rawDomain = {
      name: 'unnamed-fk-domain',
      namespace: 'b1e4c4d5-8f6a-4d2b-9e3a-7a5c8d1f2e34',
      packs: { core: { name: 'core' } },
      entities: {
        Parent: {
          name: 'Parent',
          entityName: 'Parent',
          targetTable: 'Parent',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['Code'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            Code: { name: 'Code', type: 'string' },
          },
        },
        Child: {
          name: 'Child',
          entityName: 'Child',
          targetTable: 'Child',
          schema: 'dbo',
          pack: 'core',
          businessKey: ['Code'],
          fields: {
            ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
            Code: { name: 'Code', type: 'string' },
            ParentID: { name: 'ParentID', type: 'uuid' },
          },
          foreignKeys: {
            ParentID: {
              targetEntity: 'Parent',
              targetField: 'ID',
              cardinality: 'many-to-one',
            },
          },
        },
      },
    };

    const parsedDomain = DomainConfigSchema.parse(rawDomain);
    const rng = createRng(42);
    const identityService = new IdentityService();
    identityService.RegisterNamespace(parsedDomain.name, parsedDomain.namespace);

    // 1. Generate parent row
    const parentRow = generateEntityRecord({
      domain: parsedDomain,
      entity: 'Parent',
      i: 1,
      parentPool: {},
      rng,
      identityService,
    });

    // 2. Generate child row with parent in parentPool
    const childRow = generateEntityRecord({
      domain: parsedDomain,
      entity: 'Child',
      i: 1,
      parentPool: { Parent: [parentRow] },
      rng,
      identityService,
    });

    // Generation must have populated Child.ParentID matching Parent.ID
    expect(childRow['ParentID']).toBe(parentRow['ID']);

    // 3. Validator must validate the relationship without error
    const validator = new Validator();
    const report = validator.Validate(parsedDomain, {
      Parent: [parentRow],
      Child: [childRow],
    });

    expect(report.passed).toBe(true);
    expect(
      report.gates.some((g) => g.name.includes('FK Closure: Child.ParentID -> Parent.ID') && g.passed)
    ).toBe(true);
  });
});
