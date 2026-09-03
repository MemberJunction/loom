import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { createRng, IdentityService } from '@memberjunction/loom-engine';
import type { DomainConfig } from '@memberjunction/loom-contracts';
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
});
