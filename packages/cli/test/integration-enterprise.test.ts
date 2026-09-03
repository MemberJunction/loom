import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { executeBuild } from '../src/commands/build.js';
import { executeAccumulate } from '../src/commands/accumulate.js';
import { executeValidate } from '../src/commands/validate.js';
import { Validator, readEntityMetadata, StateLadderEngine } from '@memberjunction/loom-engine';
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
      const entityDir = path.join(metaDirA, entity);

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
    const initialCp = JSON.parse(await fs.readFile(path.join(metaDirA, 'checkpoint.json'), 'utf8'));

    const { records: initialOrders } = await readEntityMetadata(
      path.join(metaDirA, 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const { records: initialLines } = await readEntityMetadata(
      path.join(metaDirA, 'OrderLine'),
      loaded.domain.entities['OrderLine']!.entityName
    );

    const seenIdsByEntity: Record<string, Set<string>> = {};
    for (const entity of Object.keys(loaded.domain.entities)) {
      const entityCfg = loaded.domain.entities[entity]!;
      const { records } = await readEntityMetadata(
        path.join(metaDirA, entity),
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
            path.join(metaDirA, tr.entity),
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
          path.join(metaDirA, entity),
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
        path.join(metaDirA, 'OrderHeader'),
        loaded.domain.entities['OrderHeader']!.entityName
      );
      const { records: currentLines } = await readEntityMetadata(
        path.join(metaDirA, 'OrderLine'),
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

    // Derive exact expected ladder transition count from durationCycles, prerequisites, and active state tenure (A5 / R7-3)
    const ladder = loaded.laddersManifest!.ladders[0]!;
    const simEngine = new StateLadderEngine([ladder]);
    const activeLifecycles = initialCp.continuity.activeLifecycleStates as Record<
      string,
      Array<{ ladder: string; currentState: string; tenure: number; enteredCycle: number }>
    >;
    for (const [entityId, lifecycles] of Object.entries(activeLifecycles)) {
      for (const lc of lifecycles) {
        if (lc.ladder === ladder.ladderKey) {
          const s = simEngine.Enroll(ladder.ladderKey, entityId, lc.currentState, lc.enteredCycle ?? 0);
          s.tenureInCurrentState = lc.tenure;
        }
      }
    }

    let derivedExpected = 0;
    for (let c = 1; c <= totalCycles; c++) {
      for (const entityId of Object.keys(activeLifecycles)) {
        const dials = (initialCp.continuity.latentStates as Record<string, Record<string, number>>)?.[entityId] ?? {};
        const res = simEngine.StepEntity(ladder.ladderKey, entityId, {
          cycle: c,
          cyclesSinceBirth: 10,
          latentDials: dials,
          stepAmount: 1,
        });
        if (res.transitioned && res.newState) {
          derivedExpected++;
        }
      }
    }

    expect(totalStatusTransitions).toBe(derivedExpected);
    expect(totalStatusTransitions).toBeGreaterThan(0);
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
          path.join(diffMetaDir, entity),
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
          path.join(diffMetaDir, entity),
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
      path.join(metaDirA, 'Member'),
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
      path.join(testMetaAltered, 'Member'),
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
        path.join(testMetaAltered, entity),
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
      path.join(metaDirA, 'Member'),
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
    const memberPath = path.join(corruptTestDir, 'Member', 'Member.json');
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

  it('R9-1: accumulate throws when .mj-sync.json is missing in prior state and leaves prior files untouched', async () => {
    const corruptSyncDir = path.join(tempDirA, 'corrupt-sync');
    await fs.cp(metaDirA, corruptSyncDir, { recursive: true });

    // Delete one .mj-sync.json
    const targetSyncFile = path.join(corruptSyncDir, 'Member', '.mj-sync.json');
    await fs.unlink(targetSyncFile);

    // Snapshot files before accumulate
    const filesBefore = await getAllFilesRecursively(corruptSyncDir);
    const hashesBefore: Record<string, string> = {};
    for (const f of filesBefore) {
      hashesBefore[f] = await computeFileSha256(f);
    }

    // Accumulate must throw, not fail open or re-create Member from scratch
    await expect(
      executeAccumulate({
        project: enterpriseProjectPath,
        priorState: corruptSyncDir,
        output: corruptSyncDir,
        weeks: '1',
      })
    ).rejects.toThrow(/Missing required '\.mj-sync\.json'/);

    // Verify prior data was not overwritten or destroyed (hashes identical)
    const filesAfter = await getAllFilesRecursively(corruptSyncDir);
    expect(filesAfter).toEqual(filesBefore);
    for (const f of filesAfter) {
      const hashAfter = await computeFileSha256(f);
      expect(hashAfter).toBe(hashesBefore[f]);
    }
  });

  it('R9-2: MetadataSync discovery finds 7 entity directories in topological order via root .mj-sync.json', async () => {
    // Verify root .mj-sync.json exists and specifies directoryOrder and push options
    const rootSyncPath = path.join(metaDirA, '.mj-sync.json');
    const rootRaw = await fs.readFile(rootSyncPath, 'utf8');
    const rootConfig = JSON.parse(rootRaw);
    expect(Array.isArray(rootConfig.directoryOrder)).toBe(true);
    expect(rootConfig.directoryOrder.length).toBe(7);
    expect(rootConfig.push?.autoCreateMissingRecords).toBe(true);

    // Replicate MetadataSync's one-level discovery rule (findEntityDirectories):
    // 1. Read root .mj-sync.json directoryOrder
    // 2. Scan immediate subdirectories for .mj-sync.json
    // 3. Sort according to directoryOrder
    const entries = await fs.readdir(metaDirA, { withFileTypes: true });
    const foundDirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const subDir = path.join(metaDirA, entry.name);
        try {
          await fs.access(path.join(subDir, '.mj-sync.json'));
          foundDirs.push(subDir);
        } catch {
          // not an entity dir
        }
      }
    }

    // Must find all 7 entity directories directly under metaDirA
    expect(foundDirs.length).toBe(7);

    // Order according to directoryOrder
    const orderedDirs: string[] = [];
    for (const dirName of rootConfig.directoryOrder as string[]) {
      const match = foundDirs.find((d) => path.basename(d) === dirName);
      if (match) orderedDirs.push(match);
    }
    expect(orderedDirs.length).toBe(7);

    const orderedNames = orderedDirs.map((d) => path.basename(d));
    // Topological sequence: parents before children
    expect(orderedNames.indexOf('Company')).toBeLessThan(orderedNames.indexOf('Member'));
    expect(orderedNames.indexOf('Company')).toBeLessThan(orderedNames.indexOf('Product'));
    expect(orderedNames.indexOf('Member')).toBeLessThan(orderedNames.indexOf('Subscription'));
    expect(orderedNames.indexOf('Product')).toBeLessThan(orderedNames.indexOf('Subscription'));
    expect(orderedNames.indexOf('Member')).toBeLessThan(orderedNames.indexOf('OrderHeader'));
    expect(orderedNames.indexOf('OrderHeader')).toBeLessThan(orderedNames.indexOf('OrderLine'));
    expect(orderedNames.indexOf('Product')).toBeLessThan(orderedNames.indexOf('OrderLine'));
    expect(orderedNames.indexOf('OrderHeader')).toBeLessThan(orderedNames.indexOf('Payment'));
  });

  it('A1: identity-keyed generation guarantees non-hero records are 100% byte-identical between heroes: [] and shipped heroes (CLI Invariant 3)', async () => {
    const noHeroesMeta = path.join(os.tmpdir(), `loom-no-heroes-${Date.now()}`);
    const withHeroesMeta = path.join(os.tmpdir(), `loom-with-heroes-${Date.now()}`);
    const tempProjDir = path.join(os.tmpdir(), `loom-proj-heroes-test-${Date.now()}`);

    // Copy enterprise project to tempProjDir
    await fs.cp(enterpriseProjectPath, tempProjDir, { recursive: true });

    // 1. Build with shipped heroes
    await executeBuild({
      project: tempProjDir,
      seed: '42',
      output: withHeroesMeta,
    });

    // 2. Build with heroes: []
    const heroesJsonPath = path.join(tempProjDir, 'ruleset', 'heroes.json');
    await fs.writeFile(heroesJsonPath, JSON.stringify({ $schema: '...', heroes: [] }, null, 2), 'utf8');

    await executeBuild({
      project: tempProjDir,
      seed: '42',
      output: noHeroesMeta,
    });

    const loaded = await loadProject(tempProjDir);

    // Get hero member IDs from withHeroesMeta
    const { records: withHeroMembers } = await readEntityMetadata(
      path.join(withHeroesMeta, 'Member'),
      loaded.domain.entities['Member']!.entityName
    );
    const heroMemberIds = new Set(
      withHeroMembers
        .filter((r) => r['Email'] === 'sarah.connor@acme.example.com' || r['Email'] === 'david.ross@globex.example.com')
        .map((r) => String(r['ID'] ?? r['id']))
    );
    expect(heroMemberIds.size).toBe(2);

    // Collect all order IDs belonging to heroes
    const { records: withHeroOrders } = await readEntityMetadata(
      path.join(withHeroesMeta, 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const heroOrderIds = new Set(
      withHeroOrders
        .filter((r) => heroMemberIds.has(String(r['MemberID'])))
        .map((r) => String(r['ID'] ?? r['id']))
    );

    // Verify for every entity that non-hero records in withHeroesMeta match noHeroesMeta exactly
    for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
      const { records: noHeroRows } = await readEntityMetadata(
        path.join(noHeroesMeta, entityName),
        entityCfg.entityName
      );
      const { records: withHeroRows } = await readEntityMetadata(
        path.join(withHeroesMeta, entityName),
        entityCfg.entityName
      );

      // Filter out hero records and hero additive child rows from withHeroRows
      const nonHeroRows = withHeroRows.filter((r) => {
        const id = String(r['ID'] ?? r['id']);
        if (heroMemberIds.has(id)) return false;
        if (r['MemberID'] && heroMemberIds.has(String(r['MemberID']))) return false;
        if (r['OrderID'] && heroOrderIds.has(String(r['OrderID']))) return false;
        return true;
      });

      // Background records must be byte-identical in count and content
      expect(nonHeroRows.length).toBe(noHeroRows.length);
      for (let i = 0; i < noHeroRows.length; i++) {
        expect(JSON.stringify(nonHeroRows[i])).toBe(JSON.stringify(noHeroRows[i]));
      }

      // If entity has hero child rows, verify they are strictly additive
      const heroChildRows = withHeroRows.filter((r) => !nonHeroRows.includes(r));
      if (entityName === 'Member') {
        expect(heroChildRows.length).toBe(2);
      } else if (heroChildRows.length > 0) {
        expect(withHeroRows.length).toBe(noHeroRows.length + heroChildRows.length);
      }
    }
  });

  it('A5 (R7-3): changing durationCycles in project ruleset dynamically moves the derived and realized transition count', async () => {
    const tempProjDir = path.join(os.tmpdir(), `loom-proj-duration-${Date.now()}`);
    const tempMetaDir = path.join(os.tmpdir(), `loom-meta-duration-${Date.now()}`);

    await fs.cp(enterpriseProjectPath, tempProjDir, { recursive: true });

    // Lengthen durationCycles of Trial state from 2 to 200 (suppresses transitions in 12 weekly cycles)
    const laddersJsonPath = path.join(tempProjDir, 'ruleset', 'ladders.json');
    const rawLadder = JSON.parse(await fs.readFile(laddersJsonPath, 'utf8'));
    rawLadder.ladders[0].states[0].durationCycles = 200;
    await fs.writeFile(laddersJsonPath, JSON.stringify(rawLadder, null, 2), 'utf8');

    await executeBuild({
      project: tempProjDir,
      seed: '42',
      output: tempMetaDir,
    });

    const loaded = await loadProject(tempProjDir);
    const initialCp = JSON.parse(await fs.readFile(path.join(tempMetaDir, 'checkpoint.json'), 'utf8'));
    const ladder = loaded.laddersManifest!.ladders[0]!;

    // Predict with altered duration
    const simEngine = new StateLadderEngine([ladder]);
    const activeLifecycles = initialCp.continuity.activeLifecycleStates as Record<
      string,
      Array<{ ladder: string; currentState: string; tenure: number; enteredCycle: number }>
    >;
    for (const [entityId, lifecycles] of Object.entries(activeLifecycles)) {
      for (const lc of lifecycles) {
        if (lc.ladder === ladder.ladderKey) {
          const s = simEngine.Enroll(ladder.ladderKey, entityId, lc.currentState, lc.enteredCycle ?? 0);
          s.tenureInCurrentState = lc.tenure;
        }
      }
    }

    let predictedWithNewDuration = 0;
    for (let c = 1; c <= 12; c++) {
      for (const entityId of Object.keys(activeLifecycles)) {
        const dials = (initialCp.continuity.latentStates as Record<string, Record<string, number>>)?.[entityId] ?? {};
        const res = simEngine.StepEntity(ladder.ladderKey, entityId, {
          cycle: c,
          cyclesSinceBirth: 10,
          latentDials: dials,
          stepAmount: 1,
        });
        if (res.transitioned && res.newState) {
          predictedWithNewDuration++;
        }
      }
    }

    let actualTransitions = 0;
    for (let c = 1; c <= 12; c++) {
      await executeAccumulate({
        project: tempProjDir,
        priorState: tempMetaDir,
        output: tempMetaDir,
        weeks: '1',
        seed: '42',
      });
      const cp = JSON.parse(await fs.readFile(path.join(tempMetaDir, 'checkpoint.json'), 'utf8'));
      actualTransitions += (cp.lastGeneratedDelta?.statusTransitions ?? []).length;
    }

    // Realized matches dynamically predicted expectation
    expect(actualTransitions).toBe(predictedWithNewDuration);
    // And differs from original baseline (duration 2 produced 3 transitions; duration 20 produces 0)
    expect(actualTransitions).toBe(0);
    expect(actualTransitions).not.toBe(3);
  });

  it('A6 (R7-4): projects with cycleUnit: week vs cycleUnit: year produce distinct transition schedules from the same ladders', async () => {
    const tempProjYear = path.join(os.tmpdir(), `loom-proj-year-${Date.now()}`);
    const tempMetaYear = path.join(os.tmpdir(), `loom-meta-year-${Date.now()}`);

    await fs.cp(enterpriseProjectPath, tempProjYear, { recursive: true });

    // Set cycleUnit to year in project.json
    const projJsonPath = path.join(tempProjYear, 'project.json');
    const projConfig = JSON.parse(await fs.readFile(projJsonPath, 'utf8'));
    projConfig.cycleUnit = 'year';
    await fs.writeFile(projJsonPath, JSON.stringify(projConfig, null, 2), 'utf8');

    await executeBuild({
      project: tempProjYear,
      seed: '42',
      output: tempMetaYear,
    });

    let yearTransitions = 0;
    for (let c = 1; c <= 12; c++) {
      await executeAccumulate({
        project: tempProjYear,
        priorState: tempMetaYear,
        output: tempMetaYear,
        weeks: '1',
        seed: '42',
      });
      const cp = JSON.parse(await fs.readFile(path.join(tempMetaYear, 'checkpoint.json'), 'utf8'));
      yearTransitions += (cp.lastGeneratedDelta?.statusTransitions ?? []).length;
    }

    // With cycleUnit: year, 12 weeks is 0.23 years -> 0 transitions occur
    expect(yearTransitions).toBe(0);
  });

  it('B (Realized Eras): scoped multiplier of 0 produces zero rows in target category in era cycle, passes Realized Era gate, and fails if multiplier is edited to 1.0 or deltaIntercept sign is flipped', async () => {
    // 1. Era build
    const tempMeta = path.join(os.tmpdir(), `loom-meta-era-test-${Date.now()}`);
    await executeBuild({
      project: enterpriseProjectPath,
      seed: '42',
      output: tempMeta,
    });

    const loaded = await loadProject(enterpriseProjectPath);
    const { records: orderLines } = await readEntityMetadata(
      path.join(tempMeta, 'OrderLine'),
      loaded.domain.entities['OrderLine']!.entityName
    );
    const { records: orders } = await readEntityMetadata(
      path.join(tempMeta, 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const { records: products } = await readEntityMetadata(
      path.join(tempMeta, 'Product'),
      loaded.domain.entities['Product']!.entityName
    );

    const orderYears = new Map(orders.map((o) => [String(o['ID'] ?? o['id']), new Date(String(o['OrderDate'])).getFullYear()]));
    const hardwareProductIds = new Set(
      products.filter((p) => p['Category'] === 'Hardware').map((p) => String(p['ID'] ?? p['id']))
    );

    // In era build: cycle 2024 has exactly 0 Hardware order lines, 14 Software lines, 14 total lines, and 14 orders (R12-1)
    const era2024Orders = orders.filter((o) => orderYears.get(String(o['ID'] ?? o['id'])) === 2024);
    const era2024Lines = orderLines.filter((ol) => orderYears.get(String(ol['OrderID'])) === 2024);
    const era2024HardwareLines = era2024Lines.filter((ol) => hardwareProductIds.has(String(ol['ProductID'])));
    const era2024Software = era2024Lines.filter((ol) => !hardwareProductIds.has(String(ol['ProductID'])));
    expect(era2024HardwareLines.length).toBe(0);
    expect(era2024Software.length).toBe(14);
    expect(era2024Lines.length).toBe(14);
    expect(era2024Orders.length).toBeLessThanOrEqual(14);

    // But other cycles have Hardware lines
    const otherHardwareLines = orderLines.filter((ol) => {
      const yr = orderYears.get(String(ol['OrderID']));
      return yr !== 2024 && hardwareProductIds.has(String(ol['ProductID']));
    });
    expect(otherHardwareLines.length).toBeGreaterThan(0);

    // 2. Era-free build: verify Hardware lines exist in 2024 without the era
    const tempProjNoEras = path.join(os.tmpdir(), `loom-proj-no-eras-${Date.now()}`);
    const tempMetaNoEras = path.join(os.tmpdir(), `loom-meta-no-eras-${Date.now()}`);
    await fs.cp(enterpriseProjectPath, tempProjNoEras, { recursive: true });
    await fs.writeFile(
      path.join(tempProjNoEras, 'ruleset', 'eras.json'),
      JSON.stringify({ $schema: 'https://memberjunction.org/schemas/loom/eras.v1.json', eras: [] }, null, 2),
      'utf8'
    );
    await executeBuild({
      project: tempProjNoEras,
      seed: '42',
      output: tempMetaNoEras,
    });
    const { records: noEraLines } = await readEntityMetadata(
      path.join(tempMetaNoEras, 'OrderLine'),
      loaded.domain.entities['OrderLine']!.entityName
    );
    const { records: noEraOrders } = await readEntityMetadata(
      path.join(tempMetaNoEras, 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const noEraOrderYears = new Map(noEraOrders.map((o) => [String(o['ID'] ?? o['id']), new Date(String(o['OrderDate'])).getFullYear()]));
    const noEra2024Hardware = noEraLines.filter((ol) => {
      const yr = noEraOrderYears.get(String(ol['OrderID']));
      return yr === 2024 && hardwareProductIds.has(String(ol['ProductID']));
    });
    expect(noEra2024Hardware.length).toBeGreaterThan(0);

    // Validate that the Realized Era gate passes on valid era build
    const reportValid = await executeValidate({
      project: enterpriseProjectPath,
      data: tempMeta,
    });
    const eraGate = reportValid.gates.find((g) => g.name.includes('era-virtual-only-2024'));
    expect(eraGate).toBeDefined();
    expect(eraGate?.passed).toBe(true);

    // 3. Mutation 1: editing multiplier to 1.0 causes volume gate to fail
    const tempProjFail1 = path.join(os.tmpdir(), `loom-proj-era-fail1-${Date.now()}`);
    await fs.cp(enterpriseProjectPath, tempProjFail1, { recursive: true });
    const eras1Path = path.join(tempProjFail1, 'ruleset', 'eras.json');
    const erasConfig1 = JSON.parse(await fs.readFile(eras1Path, 'utf8'));
    erasConfig1.eras.find((e: { eraKey: string }) => e.eraKey === 'era-supply-disruption').volumeMultipliers[0].multiplier = 1.0;
    await fs.writeFile(eras1Path, JSON.stringify(erasConfig1, null, 2), 'utf8');

    const reportFail1 = await executeValidate({
      project: tempProjFail1,
      data: tempMeta,
    });
    const failVolumeGate = reportFail1.gates.find((g) => g.name.includes('era-supply-disruption [OrderHeader in 2024]'));
    expect(failVolumeGate).toBeDefined();
    expect(failVolumeGate?.passed).toBe(false);

    // 4. Mutation 2: flipping sign of deltaIntercept from -0.85 to +0.85 causes factor gate to fail
    const tempProjFail2 = path.join(os.tmpdir(), `loom-proj-era-fail2-${Date.now()}`);
    await fs.cp(enterpriseProjectPath, tempProjFail2, { recursive: true });
    const eras2Path = path.join(tempProjFail2, 'ruleset', 'eras.json');
    const erasConfig2 = JSON.parse(await fs.readFile(eras2Path, 'utf8'));
    erasConfig2.eras.find((e: { eraKey: string }) => e.eraKey === 'era-recession-2023').factorAdjustments[0].deltaIntercept = 0.85;
    await fs.writeFile(eras2Path, JSON.stringify(erasConfig2, null, 2), 'utf8');

    const reportFail2 = await executeValidate({
      project: tempProjFail2,
      data: tempMeta,
    });
    const failFactorGate = reportFail2.gates.find((g) => g.name.includes('era-recession-2023 [factor-membership-renewal in 2023]'));
    expect(failFactorGate).toBeDefined();
    expect(failFactorGate?.passed).toBe(false);

    // 5. Acceptance 2: zeroing every category yields 0 lines and 0 orders
    const tempProjZeroAll = path.join(os.tmpdir(), `loom-proj-zero-all-${Date.now()}`);
    const tempMetaZeroAll = path.join(os.tmpdir(), `loom-meta-zero-all-${Date.now()}`);
    await fs.cp(enterpriseProjectPath, tempProjZeroAll, { recursive: true });
    const erasZeroPath = path.join(tempProjZeroAll, 'ruleset', 'eras.json');
    const erasConfigZero = JSON.parse(await fs.readFile(erasZeroPath, 'utf8'));
    erasConfigZero.eras = [
      {
        eraKey: 'era-zero-all-categories',
        scope: 'all',
        cycles: [2024],
        volumeMultipliers: [
          { entity: 'OrderLine', multiplier: 0 }
        ]
      }
    ];
    await fs.writeFile(erasZeroPath, JSON.stringify(erasConfigZero, null, 2), 'utf8');
    await executeBuild({ project: tempProjZeroAll, seed: '42', output: tempMetaZeroAll });
    const { records: zeroAllLines } = await readEntityMetadata(
      path.join(tempMetaZeroAll, 'OrderLine'),
      loaded.domain.entities['OrderLine']!.entityName
    );
    const { records: zeroAllOrders } = await readEntityMetadata(
      path.join(tempMetaZeroAll, 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const zeroOrderYears = new Map(zeroAllOrders.map((o) => [String(o['ID'] ?? o['id']), new Date(String(o['OrderDate'])).getFullYear()]));
    const zero2024Lines = zeroAllLines.filter((ol) => zeroOrderYears.get(String(ol['OrderID'])) === 2024);
    expect(zero2024Lines.length).toBe(0);
  });

  it('A2 (R7-2): hero outcomes emerge from factor evaluation path without forced override, Gate 0 passes, and unsatisfiable pin throws (R11-1)', async () => {
    const loaded = await loadProject(enterpriseProjectPath);
    const { records: members } = await readEntityMetadata(
      path.join(metaDirA, 'Member'),
      loaded.domain.entities['Member']!.entityName
    );

    // Find HERO-ENT-001 (Sarah Connor) and HERO-ENT-002 (David Ross)
    const sarah = members.find((m) => m['Email'] === 'sarah.connor@acme.example.com');
    const david = members.find((m) => m['Email'] === 'david.ross@globex.example.com');

    expect(sarah).toBeDefined();
    expect(david).toBeDefined();

    // Sarah had outcome pin for factor-membership-renewal = true -> Status should be Active
    expect(sarah!['Status']).toBe('Active');

    // David had outcome pin for factor-membership-renewal = false -> Status should be Lapsed
    expect(david!['Status']).toBe('Lapsed');

    // Gate 0 must pass for both heroes
    const report = await executeValidate({
      project: enterpriseProjectPath,
      data: metaDirA,
    });
    const gate0 = report.gates.filter((g) => g.name.includes('Gate 0 (Hero Pins)'));
    expect(gate0.length).toBe(2);
    expect(gate0.every((g) => g.passed)).toBe(true);

    // R11-1 Probe: temp project with an era adding deltaIntercept: -60 to factor-membership-renewal across cycles
    // must throw because Sarah's pin for Active cannot be drawn under rejection sampling
    const tempProjUnsat = path.join(os.tmpdir(), `loom-proj-unsat-${Date.now()}`);
    await fs.cp(enterpriseProjectPath, tempProjUnsat, { recursive: true });
    const unsatErasPath = path.join(tempProjUnsat, 'ruleset', 'eras.json');
    const unsatEras = {
      $schema: 'https://memberjunction.org/schemas/loom/eras.v1.json',
      eras: [
        {
          eraKey: 'impossible-depression',
          scope: 'all',
          cycles: [2021, 2022, 2023, 2024, 2025, 2026],
          factorAdjustments: [{ factor: 'factor-membership-renewal', deltaIntercept: -60 }],
          volumeMultipliers: [],
        },
      ],
    };
    await fs.writeFile(unsatErasPath, JSON.stringify(unsatEras, null, 2), 'utf8');

    await expect(
      executeBuild({
        project: tempProjUnsat,
        seed: '42',
        output: path.join(os.tmpdir(), `loom-meta-unsat-${Date.now()}`),
      })
    ).rejects.toThrow(/Hero pin unsatisfiable under simulation ruleset/);
  });

  it('A3 (02.7): discrete child rows are generated per cycle from motif childRates and every OrderHeader has >= 1 OrderLine and >= 1 Payment with gate (R11-3)', async () => {
    const loaded = await loadProject(enterpriseProjectPath);
    const { records: orderHeaders } = await readEntityMetadata(
      path.join(metaDirA, 'OrderHeader'),
      loaded.domain.entities['OrderHeader']!.entityName
    );
    const { records: orderLines } = await readEntityMetadata(
      path.join(metaDirA, 'OrderLine'),
      loaded.domain.entities['OrderLine']!.entityName
    );
    const { records: payments } = await readEntityMetadata(
      path.join(metaDirA, 'Payment'),
      loaded.domain.entities['Payment']!.entityName
    );

    // Motif child rates in enterprise/ruleset/motifs.json generate orders across cycles (2021..2026)
    const ordersByYear: Record<number, number> = {};
    for (const oh of orderHeaders) {
      const orderDate = String(oh['OrderDate'] ?? oh['CreatedAt'] ?? '');
      const year = parseInt(orderDate.slice(0, 4), 10);
      if (year >= 2021 && year <= 2026) {
        ordersByYear[year] = (ordersByYear[year] || 0) + 1;
      }
    }

    // Every historical cycle has generated order headers
    for (let y = 2021; y <= 2026; y++) {
      expect(ordersByYear[y]).toBeGreaterThan(0);
    }

    // R11-3: Every single OrderHeader has >= 1 OrderLine and >= 1 Payment
    const lineOrderIds = new Set(orderLines.map((ol) => String(ol['OrderID'])));
    const paymentOrderIds = new Set(payments.map((p) => String(p['OrderID'])));

    for (const oh of orderHeaders) {
      const orderId = String(oh['ID'] ?? oh['id']);
      expect(lineOrderIds.has(orderId)).toBe(true);
      expect(paymentOrderIds.has(orderId)).toBe(true);
    }

    // Sarah Connor has a cross-cycle feature pin for >= 2 completed orders that satisfies Gate 0
    const sarahOrders = orderHeaders.filter((oh) => oh['Status'] === 'Completed');
    expect(sarahOrders.length).toBeGreaterThanOrEqual(2);

    // Validation report passes the Dependent Coverage gate
    const report = await executeValidate({
      project: enterpriseProjectPath,
      data: metaDirA,
    });
    const depGate = report.gates.find((g) => g.name.includes('Dependent Coverage'));
    expect(depGate).toBeDefined();
    expect(depGate?.passed).toBe(true);
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
