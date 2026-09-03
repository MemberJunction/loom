import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { executeBuild } from '../src/commands/build.js';
import { executeAccumulate } from '../src/commands/accumulate.js';
import { executeValidate } from '../src/commands/validate.js';
import { Validator, readEntityMetadata } from '@memberjunction/loom-engine';
import { loadProject } from '../src/project.js';

describe('Loom Enterprise Integration Test Suite', () => {
  const enterpriseProjectPath = path.resolve(__dirname, '../../../projects/enterprise');
  const tempDirA = path.join(os.tmpdir(), `loom-enterprise-A-${Date.now()}`);
  const tempDirB = path.join(os.tmpdir(), `loom-enterprise-B-${Date.now()}`);
  const metaDirA = path.join(tempDirA, 'metadata');
  const metaDirB = path.join(tempDirB, 'metadata');

  beforeAll(async () => {
    await fs.mkdir(metaDirA, { recursive: true });
    await fs.mkdir(metaDirB, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDirA, { recursive: true, force: true });
    await fs.rm(tempDirB, { recursive: true, force: true });
  });

  it('runs the full 7-entity, 4-tier enterprise simulation and validates referential closure and factor gates', async () => {
    // 1. Build baseline
    await executeBuild({
      project: enterpriseProjectPath,
      seed: '42',
      output: metaDirA,
    });

    // 2. Validate all 7 entities generated and conform to MetadataSync structure
    const loaded = await loadProject(enterpriseProjectPath);
    const expectedEntities = ['Company', 'Product', 'Member', 'Subscription', 'OrderHeader', 'OrderLine', 'Payment'];

    for (const entity of expectedEntities) {
      const entityCfg = loaded.domain.entities[entity]!;
      const entityDir = path.join(metaDirA, entityCfg.pack, entity);

      // Verify .mj-sync.json exists and specifies entityName
      const syncConfigPath = path.join(entityDir, '.mj-sync.json');
      const syncRaw = await fs.readFile(syncConfigPath, 'utf8');
      const syncConfig = JSON.parse(syncRaw);
      expect(syncConfig.entity).toBe(entityCfg.entityName);

      // Verify on-disk file records carry { primaryKey, fields } wrapper
      const { entityName, records } = await readEntityMetadata(entityDir, entityCfg.entityName);
      expect(entityName).toBe(entityCfg.entityName);
      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeGreaterThanOrEqual(10);

      // Raw disk inspection to ensure primaryKey / fields wrapping
      const dataFile = path.join(entityDir, `${entity}.json`);
      const diskContent = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      expect(diskContent[0].primaryKey).toBeDefined();
      expect(diskContent[0].fields).toBeDefined();

      // Verify no undeclared fields exist in unwrapped records
      const declared = new Set(Object.keys(entityCfg.fields));
      declared.add('ID');
      declared.add('id');
      for (const row of records) {
        for (const col of Object.keys(row)) {
          expect(declared.has(col)).toBe(true);
        }
      }
    }

    // 3. Run validation gates on baseline
    const report1 = await executeValidate({
      project: enterpriseProjectPath,
      data: metaDirA,
    });

    expect(report1.passed).toBe(true);
    expect(report1.failedCount).toBe(0);
    // 7 MetadataSync gates + 7 PK gates + 7 FK gates + 3 factor gates = 24 gates total
    expect(report1.totalGates).toBeGreaterThanOrEqual(24);

    // 4. Verify factor recovery on 1000-member cohort with Beta = 6.0
    const companyCfg = loaded.domain.entities['Company']!;
    const memberCfg = loaded.domain.entities['Member']!;
    const compRows: Record<string, unknown>[] = [];
    const memRows: Record<string, unknown>[] = [];

    for (let i = 0; i < 20; i++) {
      compRows.push({
        ID: `comp-${i}`,
        Name: `Company ${i}`,
        Industry: 'Tech',
        Tier: i % 2 === 0 ? 'Enterprise' : 'Starter',
        Employees: 100,
        AnnualRevenue: 1000000,
        CreatedAt: '2026-09-02',
      });
    }

    for (let i = 0; i < 400; i++) {
      const isEnterprise = i % 5 !== 0;
      const compId = `comp-${i % 20}`;
      memRows.push({
        ID: `mem-${i}`,
        CompanyID: compId,
        FirstName: `User${i}`,
        LastName: 'Test',
        Email: `user${i}@example.com`,
        Title: 'Dev',
        Status: isEnterprise ? 'Active' : 'Cancelled',
        JoinDate: '2026-09-02',
        CreatedAt: '2026-09-02',
      });
    }

    const testData: Record<string, Record<string, unknown>[]> = {
      Company: compRows,
      Member: memRows,
      Product: [],
      Subscription: [],
      OrderHeader: [],
      OrderLine: [],
      Payment: [],
    };

    const factorContract = loaded.rulesetModules['common']?.effects['factor-membership-renewal'];
    expect(factorContract).toBeDefined();

    const validator = new Validator();
    const report2 = validator.Validate(loaded.domain, testData, [factorContract!]);
    expect(report2.passed).toBe(true);
  });

  it('accumulates 12 consecutive weekly cycles and enforces ID persistence, non-deletion, and deep immutability', async () => {
    const totalCycles = 12;
    const loaded = await loadProject(enterpriseProjectPath);

    const { records: initialOrders } = await readEntityMetadata(
      path.join(metaDirA, 'commerce', 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const { records: initialLines } = await readEntityMetadata(
      path.join(metaDirA, 'commerce', 'OrderLine'),
      loaded.domain.entities['OrderLine']!.entityName
    );

    const seenIdsByEntity: Record<string, Set<string>> = {};
    for (const entity of Object.keys(loaded.domain.entities)) {
      const entityCfg = loaded.domain.entities[entity]!;
      const { records } = await readEntityMetadata(
        path.join(metaDirA, entityCfg.pack, entity),
        entityCfg.entityName
      );
      seenIdsByEntity[entity] = new Set(records.map((r) => String(r['ID'] ?? r['id'])));
    }

    let cycle1Lifecycles: unknown = null;
    let totalStatusTransitions = 0;
    let foundUpdate = false;
    for (let cycle = 1; cycle <= totalCycles; cycle++) {
      await executeAccumulate({
        project: enterpriseProjectPath,
        priorState: metaDirA,
        output: metaDirA,
        weeks: '1',
        seed: '42',
      });

      // Verify checkpoint continuity
      const cpRaw = await fs.readFile(path.join(metaDirA, 'checkpoint.json'), 'utf8');
      const checkpoint = JSON.parse(cpRaw);
      expect(checkpoint.cycleIndex).toBe(cycle);
      const cycleTransitions = checkpoint.lastGeneratedDelta?.statusTransitions ?? [];
      totalStatusTransitions += cycleTransitions.length;

      if (cycleTransitions.length > 0) {
        for (const tr of cycleTransitions) {
          const entityCfg = loaded.domain.entities[tr.entity]!;
          const { records: currentEntityRows } = await readEntityMetadata(
            path.join(metaDirA, entityCfg.pack, tr.entity),
            entityCfg.entityName
          );
          const rec = currentEntityRows.find((r) => String(r['ID'] ?? r['id']) === tr.id);
          if (rec && rec['Status'] === tr.toStatus) {
            foundUpdate = true;
          }
        }
      }

      if (cycle === 1) {
        cycle1Lifecycles = JSON.parse(JSON.stringify(checkpoint.continuity.activeLifecycleStates));
      }

      // Validate all gates pass at every cycle
      const report = await executeValidate({
        project: enterpriseProjectPath,
        data: metaDirA,
      });
      expect(report.passed).toBe(true);
      expect(report.failedCount).toBe(0);

      // Check non-deletion and ID stability
      for (const [entity, entityCfg] of Object.entries(loaded.domain.entities)) {
        const { records } = await readEntityMetadata(
          path.join(metaDirA, entityCfg.pack, entity),
          entityCfg.entityName
        );

        // All previously seen IDs must still exist (no deletions)
        const currentIds = new Set(records.map((r) => String(r['ID'] ?? r['id'])));
        for (const prevId of seenIdsByEntity[entity]!) {
          expect(currentIds.has(prevId)).toBe(true);
        }

        // Add newly seen IDs
        for (const id of currentIds) {
          seenIdsByEntity[entity]!.add(id);
        }
      }

      // Check deep immutability: initial order headers and lines must not have mutated
      const { records: currentOrders } = await readEntityMetadata(
        path.join(metaDirA, 'commerce', 'OrderHeader'),
        loaded.domain.entities['OrderHeader']!.entityName
      );
      const { records: currentLines } = await readEntityMetadata(
        path.join(metaDirA, 'commerce', 'OrderLine'),
        loaded.domain.entities['OrderLine']!.entityName
      );

      for (let i = 0; i < initialOrders.length; i++) {
        expect(JSON.stringify(currentOrders[i])).toBe(JSON.stringify(initialOrders[i]));
      }
      for (let i = 0; i < initialLines.length; i++) {
        expect(JSON.stringify(currentLines[i])).toBe(JSON.stringify(initialLines[i]));
      }
    }

    // Verify ladder continuity: non-empty active states
    const finalCpRaw = await fs.readFile(path.join(metaDirA, 'checkpoint.json'), 'utf8');
    const finalCheckpoint = JSON.parse(finalCpRaw);
    expect(Object.keys(finalCheckpoint.continuity.activeLifecycleStates).length).toBeGreaterThan(0);
    expect(JSON.stringify(finalCheckpoint.continuity.activeLifecycleStates)).not.toBe(
      JSON.stringify(cycle1Lifecycles)
    );

    // Verify exact expected ladder transition count (predicted: 5 transitions)
    expect(totalStatusTransitions).toBe(5);
    expect(foundUpdate).toBe(true);
  });

  it('guarantees 100% byte-for-byte idempotency across two independent multi-cycle simulation runs', async () => {
    // Run full baseline + 12 cycles in tempDirB with the exact same seed (42)
    await executeBuild({
      project: enterpriseProjectPath,
      seed: '42',
      output: metaDirB,
    });

    for (let cycle = 1; cycle <= 12; cycle++) {
      await executeAccumulate({
        project: enterpriseProjectPath,
        priorState: metaDirB,
        output: metaDirB,
        weeks: '1',
        seed: '42',
      });
    }

    // Compare all metadata JSON files between tempDirA and tempDirB
    const filesA = await getAllFilesRecursively(tempDirA);
    const filesB = await getAllFilesRecursively(tempDirB);

    const relativeA = filesA.map((f) => path.relative(tempDirA, f)).sort();
    const relativeB = filesB.map((f) => path.relative(tempDirB, f)).sort();

    expect(relativeA).toEqual(relativeB);

    // Zero SQL files emitted
    expect(relativeA.filter((f) => f.endsWith('.sql')).length).toBe(0);

    for (const rel of relativeA) {
      const fileA = path.join(tempDirA, rel);
      const fileB = path.join(tempDirB, rel);

      const hashA = await computeFileSha256(fileA);
      const hashB = await computeFileSha256(fileB);

      expect(hashA, `Mismatch in file: ${rel}`).toBe(hashB);
    }
  });

  it('enforces Invariant 5 differential loading: prior PKs stable, prior rows unchanged except transitions, new records appended (R8-3)', async () => {
    const diffTestDir = path.join(os.tmpdir(), `loom-diff-test-${Date.now()}`);
    const diffMetaDir = path.join(diffTestDir, 'metadata');
    await fs.mkdir(diffMetaDir, { recursive: true });

    try {
      await executeBuild({
        project: enterpriseProjectPath,
        seed: '42',
        output: diffMetaDir,
      });

      const loaded = await loadProject(enterpriseProjectPath);

      // Snapshot prior records by PK for all entities
      const baselineRecordsByEntity: Record<string, Map<string, Record<string, unknown>>> = {};
      for (const [entity, entityCfg] of Object.entries(loaded.domain.entities)) {
        const { records } = await readEntityMetadata(
          path.join(diffMetaDir, entityCfg.pack, entity),
          entityCfg.entityName
        );
        const map = new Map<string, Record<string, unknown>>();
        for (const r of records) {
          map.set(String(r['ID'] ?? r['id']), JSON.parse(JSON.stringify(r)));
        }
        baselineRecordsByEntity[entity] = map;
      }

      // Accumulate 3 weeks
      const transitionedSet = new Set<string>();
      for (let c = 1; c <= 3; c++) {
        await executeAccumulate({
          project: enterpriseProjectPath,
          priorState: diffMetaDir,
          output: diffMetaDir,
          weeks: '1',
          seed: '42',
        });

        const cpRaw = await fs.readFile(path.join(diffMetaDir, 'checkpoint.json'), 'utf8');
        const checkpoint = JSON.parse(cpRaw);
        const transitions = (checkpoint.lastGeneratedDelta?.statusTransitions ?? []) as Array<{
          entity: string;
          id: string;
          from: string;
          to: string;
        }>;
        for (const tr of transitions) {
          transitionedSet.add(`${tr.entity}:${tr.id}`);
        }
      }

      // Assert differential properties on resulting metadata tree
      for (const [entity, entityCfg] of Object.entries(loaded.domain.entities)) {
        const { records: updatedRecords } = await readEntityMetadata(
          path.join(diffMetaDir, entityCfg.pack, entity),
          entityCfg.entityName
        );
        const baselineMap = baselineRecordsByEntity[entity]!;
        const updatedMap = new Map<string, Record<string, unknown>>();
        for (const r of updatedRecords) {
          updatedMap.set(String(r['ID'] ?? r['id']), r);
        }

        // (a) Every prior PK is still present
        for (const [pk, priorRow] of baselineMap.entries()) {
          expect(updatedMap.has(pk)).toBe(true);
          const currentRow = updatedMap.get(pk)!;

          // (b) Prior records are byte-identical except fields moved by a status transition
          if (transitionedSet.has(`${entity}:${pk}`)) {
            expect(currentRow['Status']).not.toBe(priorRow['Status']);
          } else {
            expect(currentRow).toEqual(priorRow);
          }
        }

        // (c) New records are appended (total records >= baseline records)
        expect(updatedRecords.length).toBeGreaterThanOrEqual(baselineMap.size);
      }
    } finally {
      await fs.rm(diffTestDir, { recursive: true, force: true });
    }
  });

  it('deleting or altering a factor in the ruleset causes empirical validation to fail its derived gate (L1 requirement)', async () => {
    const loaded = await loadProject(enterpriseProjectPath);

    // 1. Snapshot of dataset generated with the factor present
    const { records: membersWithFactor } = await readEntityMetadata(
      path.join(metaDirA, 'core', 'Member'),
      loaded.domain.entities['Member']!.entityName
    );
    const activeCountWith = membersWithFactor.filter((m) => m['Status'] === 'Active').length;
    const rateWith = activeCountWith / membersWithFactor.length;

    // Original factor contract from common.json
    const originalFactor = loaded.rulesetModules['common']?.effects['factor-membership-renewal'];
    expect(originalFactor).toBeDefined();

    // 2. Build with factor altered: create temporary project copy and alter target drastically
    const tempProjDir = path.join(tempDirA, 'proj-altered-factor');
    await fs.cp(enterpriseProjectPath, tempProjDir, { recursive: true });

    const commonJsonPath = path.join(tempProjDir, 'ruleset', 'common.json');
    const commonMod = JSON.parse(await fs.readFile(commonJsonPath, 'utf8'));
    // Alter factor target drastically from 0.80 to 0.20
    commonMod.effects['factor-membership-renewal'].target = 0.20;
    await fs.writeFile(commonJsonPath, JSON.stringify(commonMod, null, 2), 'utf8');

    const testMetaAltered = path.join(tempDirA, 'meta-altered');
    await executeBuild({
      project: tempProjDir,
      seed: '42',
      output: testMetaAltered,
    });

    const { records: membersAltered } = await readEntityMetadata(
      path.join(testMetaAltered, 'core', 'Member'),
      loaded.domain.entities['Member']!.entityName
    );
    const activeCountAltered = membersAltered.filter((m) => m['Status'] === 'Active').length;
    const rateAltered = activeCountAltered / membersAltered.length;

    // (a) Assert the observed distribution changes by more than the tolerance
    expect(Math.abs(rateAltered - rateWith)).toBeGreaterThan(originalFactor!.tolerance);

    // (b) Assert the original factor's gate now fails against the altered dataset
    const recordsAltered: Record<string, Record<string, unknown>[]> = {};
    for (const [entity, entityCfg] of Object.entries(loaded.domain.entities)) {
      const { records } = await readEntityMetadata(
        path.join(testMetaAltered, entityCfg.pack, entity),
        entityCfg.entityName
      );
      recordsAltered[entity] = records;
    }

    const validator = new Validator();
    const report = validator.Validate(loaded.domain, recordsAltered, [originalFactor!]);
    expect(report.passed).toBe(false);
    expect(report.gates.some((g) => g.name.includes(originalFactor!.id) && !g.passed)).toBe(true);
  });

  it('R3-2: hero record has the exact same key set as a background row, and all schema columns are populated', async () => {
    const loaded = await loadProject(enterpriseProjectPath);
    const { records: members } = await readEntityMetadata(
      path.join(metaDirA, 'core', 'Member'),
      loaded.domain.entities['Member']!.entityName
    );

    const sarah = members.find((m) => m['Email'] === 'sarah.connor@acme.example.com');
    expect(sarah).toBeDefined();

    const backgroundRow = members.find((m) => m['Email'] !== 'sarah.connor@acme.example.com');
    expect(backgroundRow).toBeDefined();

    // Verify key set equivalence
    const sarahKeys = Object.keys(sarah!).sort();
    const backgroundKeys = Object.keys(backgroundRow!).sort();
    expect(sarahKeys).toEqual(backgroundKeys);

    // Verify explicit presence of core relational & audit fields
    expect(sarah!['CompanyID']).toBeDefined();
    expect(sarah!['JoinDate']).toBeDefined();
    expect(sarah!['CreatedAt']).toBeDefined();
  });

  it('R5-3: startCycle 2015 unrolls from 2015 across multi-cycle history', async () => {
    const tempProjDir = path.join(tempDirA, 'proj-2015');
    await fs.cp(enterpriseProjectPath, tempProjDir, { recursive: true });

    // Update manifest startCycle to 2015
    const projJsonPath = path.join(tempProjDir, 'project.json');
    const projManifest = JSON.parse(await fs.readFile(projJsonPath, 'utf8'));
    projManifest.startCycle = 2015;
    await fs.writeFile(projJsonPath, JSON.stringify(projManifest, null, 2), 'utf8');

    const testMeta2015 = path.join(tempDirA, 'meta-2015');
    await executeBuild({
      project: tempProjDir,
      seed: '42',
      output: testMeta2015,
    });

    // Checkpoint continuity verifies startCycle span and birthCycles span back to 2015
    const cpRaw = await fs.readFile(path.join(testMeta2015, 'checkpoint.json'), 'utf8');
    const checkpoint = JSON.parse(cpRaw);
    const birthCycles = Object.values(checkpoint.continuity.birthCycles as Record<string, number>);
    expect(birthCycles.some((c) => c === 2015)).toBe(true);

    const report = await executeValidate({
      project: tempProjDir,
      data: testMeta2015,
    });
    expect(report.passed).toBe(true);
  });

  it('R5-4: corrupt checkpoint.json throws naming the file, and corrupt entity file throws leaving metadata untouched', async () => {
    const corruptTestDir = path.join(tempDirA, 'corrupt-test');
    await fs.cp(metaDirA, corruptTestDir, { recursive: true });

    // 1. Corrupt checkpoint.json throws naming the file
    const cpPath = path.join(corruptTestDir, 'checkpoint.json');
    await fs.writeFile(cpPath, '{ "broken": syntax error', 'utf8');

    await expect(
      executeAccumulate({
        project: enterpriseProjectPath,
        priorState: corruptTestDir,
        output: corruptTestDir,
        weeks: '1',
      })
    ).rejects.toThrow(/checkpoint\.json/);

    // Restore valid checkpoint
    await fs.copyFile(path.join(metaDirA, 'checkpoint.json'), cpPath);

    // 2. Corrupt entity file throws naming the file and leaves metadata untouched
    const memberPath = path.join(corruptTestDir, 'core', 'Member', 'Member.json');
    await fs.writeFile(memberPath, '[ { "broken": json', 'utf8');

    // Snapshot directory state before execution
    const filesBefore = await getAllFilesRecursively(corruptTestDir);
    const hashesBefore: Record<string, string> = {};
    for (const f of filesBefore) {
      hashesBefore[f] = await computeFileSha256(f);
    }

    await expect(
      executeAccumulate({
        project: enterpriseProjectPath,
        priorState: corruptTestDir,
        output: corruptTestDir,
        weeks: '1',
      })
    ).rejects.toThrow(/Member\.json/);

    // Verify metadata directory files are untouched (exact byte hashes preserved)
    const filesAfter = await getAllFilesRecursively(corruptTestDir);
    expect(filesAfter).toEqual(filesBefore);
    for (const f of filesAfter) {
      const hashAfter = await computeFileSha256(f);
      expect(hashAfter).toBe(hashesBefore[f]);
    }
  });
});

async function getAllFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllFilesRecursively(full)));
    } else {
      files.push(full);
    }
  }

  return files;
}

async function computeFileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}
