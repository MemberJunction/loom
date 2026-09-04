import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeBuild } from '../src/commands/build.js';
import { executeValidate } from '../src/commands/validate.js';
import { readEntityMetadata } from '@memberjunction/loom-engine';

describe('Loom Schema-Agnostic & Custom Output Layout Integration', () => {
  const tempDir = path.join(os.tmpdir(), `loom-agnostic-${Date.now()}`);
  const projectDir = path.join(tempDir, 'project');
  const metadataDir = path.join(tempDir, 'metadata');

  beforeAll(async () => {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, 'catalogs'), { recursive: true });

    // Write external catalog
    await fs.writeFile(
      path.join(projectDir, 'catalogs', 'org-types.json'),
      JSON.stringify(
        [
          { ID: '11111111-1111-1111-1111-111111111111', Name: 'LLC' },
          { ID: '22222222-2222-2222-2222-222222222222', Name: 'Corporation' },
        ],
        null,
        2
      )
    );

    // Write loom.config.json
    await fs.writeFile(
      path.join(projectDir, 'loom.config.json'),
      JSON.stringify(
        {
          name: 'test-custom-layout',
          version: '1.0.0',
          domain: 'custom-layout',
          uuidNamespace: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
          startCycle: 2024,
          releaseDate: '2026-09-02',
          cycleUnit: 'year',
          catalogs: {
            'MJ_BizApps_Common: Organization Types': './catalogs/org-types.json',
          },
          output: {
            metadataDir: './metadata',
          },
        },
        null,
        2
      )
    );

    // Write domain.json with custom outputDirectory and lookupPattern
    await fs.writeFile(
      path.join(projectDir, 'domain.json'),
      JSON.stringify(
        {
          name: 'custom-layout',
          namespace: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
          packs: {
            core: {
              name: 'core',
              description: 'Core Pack',
            },
          },
          entities: {
            Organization: {
              name: 'Organization',
              entityName: 'Test: Organizations',
              targetTable: 'Organizations',
              schema: 'test',
              pack: 'core',
              outputDirectory: 'test-organizations',
              businessKey: ['Name'],
              fields: {
                ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
                Name: { name: 'Name', type: 'string' },
                OrgTypeID: { name: 'OrgTypeID', type: 'string' },
              },
              foreignKeys: {
                OrgTypeID: {
                  fieldName: 'OrgTypeID',
                  targetEntity: 'MJ_BizApps_Common: Organization Types',
                  targetField: 'ID',
                  lookupPattern: '@lookup:MJ_BizApps_Common: Organization Types.Name=${parent.Name}',
                },
              },
            },
            Member: {
              name: 'Member',
              entityName: 'Test: Members',
              targetTable: 'Members',
              schema: 'test',
              pack: 'core',
              outputDirectory: 'test-members',
              businessKey: ['Email'],
              fields: {
                ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
                OrganizationID: { name: 'OrganizationID', type: 'uuid' },
                Email: { name: 'Email', type: 'string' },
              },
              foreignKeys: {
                OrganizationID: {
                  fieldName: 'OrganizationID',
                  targetEntity: 'Organization',
                  targetField: 'ID',
                },
              },
            },
          },
        },
        null,
        2
      )
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates metadata into custom output directories with dot-prefixed files and zero sync blocks', async () => {
    // 1. Build using config file path option (-c)
    await executeBuild({
      config: path.join(projectDir, 'loom.config.json'),
      seed: '42',
      output: metadataDir,
    });

    // 2. Verify directories and dot-prefixed file names
    const orgDir = path.join(metadataDir, 'test-organizations');
    const memberDir = path.join(metadataDir, 'test-members');

    const orgFiles = await fs.readdir(orgDir);
    expect(orgFiles).toContain('.mj-sync.json');
    expect(orgFiles).toContain('.test-organizations.json');

    const memberFiles = await fs.readdir(memberDir);
    expect(memberFiles).toContain('.mj-sync.json');
    expect(memberFiles).toContain('.test-members.json');

    // 3. Verify root .mj-sync.json has directoryOrder matching outputDirectories
    const rootSync = JSON.parse(await fs.readFile(path.join(metadataDir, '.mj-sync.json'), 'utf8'));
    expect(rootSync.directoryOrder).toContain('test-organizations');
    expect(rootSync.directoryOrder).toContain('test-members');

    // 4. Verify no sync blocks exist in generated json
    const orgContent = await fs.readFile(path.join(orgDir, '.test-organizations.json'), 'utf8');
    expect(orgContent).not.toContain('"sync"');

    // 5. Read back via readEntityMetadata
    const { records: orgRecords } = await readEntityMetadata(orgDir, 'Test: Organizations');
    expect(orgRecords.length).toBe(10);
    expect(orgRecords[0]!['OrgTypeID']).toBe('@lookup:MJ_BizApps_Common: Organization Types.Name=LLC');
    expect(orgRecords[1]!['OrgTypeID']).toBe('@lookup:MJ_BizApps_Common: Organization Types.Name=Corporation');

    // 6. Execute validation gates and verify 100% pass including @lookup gate
    const report = await executeValidate({
      config: path.join(projectDir, 'loom.config.json'),
      data: metadataDir,
    });

    expect(report.passed).toBe(true);
    expect(report.failedCount).toBe(0);

    const lookupGate = report.gates.find((g) => g.name.includes('@lookup Expression Integrity'));
    expect(lookupGate).toBeDefined();
    expect(lookupGate?.passed).toBe(true);
  });
});
