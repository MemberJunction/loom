import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { executeBuild } from '../src/commands/build.js';
import { executeAccumulate } from '../src/commands/accumulate.js';
import { executeValidate } from '../src/commands/validate.js';
import { emitSkywayMigration, Validator } from '@memberjunction/loom-engine';
import { loadProject } from '../src/project.js';

describe('Loom Enterprise Integration Test Suite', () => {
  const enterpriseProjectPath = path.resolve(__dirname, '../../../projects/enterprise');
  const tempDirA = path.join(os.tmpdir(), `loom-enterprise-A-${Date.now()}`);
  const tempDirB = path.join(os.tmpdir(), `loom-enterprise-B-${Date.now()}`);
  const metaDirA = path.join(tempDirA, 'metadata');
  const metaDirB = path.join(tempDirB, 'metadata');
  const migrDirA = path.join(tempDirA, 'migrations');
  const migrDirB = path.join(tempDirB, 'migrations');

  beforeAll(async () => {
    await fs.mkdir(metaDirA, { recursive: true });
    await fs.mkdir(migrDirA, { recursive: true });
    await fs.mkdir(metaDirB, { recursive: true });
    await fs.mkdir(migrDirB, { recursive: true });
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
      migrationsOutput: migrDirA,
    });

    // 2. Validate all 7 entities generated
    const loaded = await loadProject(enterpriseProjectPath);
    const expectedEntities = ['Company', 'Product', 'Member', 'Subscription', 'OrderHeader', 'OrderLine', 'Payment'];

    for (const entity of expectedEntities) {
      const entityCfg = loaded.domain.entities[entity]!;
      const filePath = path.join(metaDirA, entityCfg.pack, `${entity}.json`);
      const raw = await fs.readFile(filePath, 'utf8');
      const records = JSON.parse(raw);
      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeGreaterThanOrEqual(10);

      // Verify no undeclared fields exist
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
    // 7 PK gates + 7 FK gates + 3 factor gates = 17 gates total
    expect(report1.totalGates).toBeGreaterThanOrEqual(17);

    // Verify continuity is populated and non-empty (L1 requirement)
    const cpRaw = await fs.readFile(path.join(metaDirA, 'checkpoint.json'), 'utf8');
    const checkpoint = JSON.parse(cpRaw);
    expect(Object.keys(checkpoint.continuity.activeEntityIds).length).toBeGreaterThan(0);
    expect(Object.keys(checkpoint.continuity.latentStates).length).toBeGreaterThan(0);
    expect(Object.keys(checkpoint.continuity.activeLifecycleStates).length).toBeGreaterThan(0);
  });

  it('accumulates 12 consecutive weekly cycles and enforces ID persistence, non-deletion, and deep immutability', async () => {
    const loaded = await loadProject(enterpriseProjectPath);

    // Snapshot of baseline immutable order records from Cycle 0
    const orderHeaderPath = path.join(metaDirA, 'commerce', 'OrderHeader.json');
    const orderLinePath = path.join(metaDirA, 'commerce', 'OrderLine.json');
    const initialOrders = JSON.parse(await fs.readFile(orderHeaderPath, 'utf8'));
    const initialLines = JSON.parse(await fs.readFile(orderLinePath, 'utf8'));

    const seenIdsByEntity: Record<string, Set<string>> = {};
    for (const entity of Object.keys(loaded.domain.entities)) {
      seenIdsByEntity[entity] = new Set();
    }

    // Run 12 weekly accumulation cycles
    const totalCycles = 12;
    let cycle1Lifecycles: unknown = null;
    for (let cycle = 1; cycle <= totalCycles; cycle++) {
      await executeAccumulate({
        project: enterpriseProjectPath,
        priorState: metaDirA,
        output: metaDirA,
        migrationsOutput: migrDirA,
        weeks: '1',
        seed: '42',
      });

      // Verify checkpoint continuity
      const cpRaw = await fs.readFile(path.join(metaDirA, 'checkpoint.json'), 'utf8');
      const checkpoint = JSON.parse(cpRaw);
      expect(checkpoint.cycleIndex).toBe(cycle);

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
        const filePath = path.join(metaDirA, entityCfg.pack, `${entity}.json`);
        const rows: Record<string, unknown>[] = JSON.parse(await fs.readFile(filePath, 'utf8'));

        // All previously seen IDs must still exist (no deletions)
        const currentIds = new Set(rows.map((r) => String(r['ID'] ?? r['id'])));
        for (const prevId of seenIdsByEntity[entity]!) {
          expect(currentIds.has(prevId)).toBe(true);
        }

        // Add newly seen IDs
        for (const id of currentIds) {
          seenIdsByEntity[entity]!.add(id);
        }
      }

      // Check deep immutability: initial order headers and lines must not have mutated
      const currentOrders: Record<string, unknown>[] = JSON.parse(await fs.readFile(orderHeaderPath, 'utf8'));
      const currentLines: Record<string, unknown>[] = JSON.parse(await fs.readFile(orderLinePath, 'utf8'));

      for (let i = 0; i < initialOrders.length; i++) {
        expect(JSON.stringify(currentOrders[i])).toBe(JSON.stringify(initialOrders[i]));
      }
      for (let i = 0; i < initialLines.length; i++) {
        expect(JSON.stringify(currentLines[i])).toBe(JSON.stringify(initialLines[i]));
      }
    }

    const finalCpRaw = await fs.readFile(path.join(metaDirA, 'checkpoint.json'), 'utf8');
    const finalCheckpoint = JSON.parse(finalCpRaw);

    // R3-4: Assert activeLifecycleStates differs between cycle 1 and cycle 12
    expect(JSON.stringify(cycle1Lifecycles)).not.toBe(
      JSON.stringify(finalCheckpoint.continuity.activeLifecycleStates)
    );

    // R3-4: Assert that at least one delta migration across the 12 cycles contains an UPDATE statement
    const migrationFiles = await fs.readdir(migrDirA);
    let foundUpdate = false;
    for (const f of migrationFiles) {
      if (f.endsWith('.sql')) {
        const content = await fs.readFile(path.join(migrDirA, f), 'utf8');
        if (content.includes('UPDATE ')) {
          foundUpdate = true;
          break;
        }
      }
    }
    expect(foundUpdate).toBe(true);
  });

  it('guarantees 100% byte-for-byte idempotency across two independent multi-cycle simulation runs', async () => {
    // Run full baseline + 12 cycles in tempDirB with the exact same seed (42)
    await executeBuild({
      project: enterpriseProjectPath,
      seed: '42',
      output: metaDirB,
      migrationsOutput: migrDirB,
    });

    for (let cycle = 1; cycle <= 12; cycle++) {
      await executeAccumulate({
        project: enterpriseProjectPath,
        priorState: metaDirB,
        output: metaDirB,
        migrationsOutput: migrDirB,
        weeks: '1',
        seed: '42',
      });
    }

    // Compare all files between tempDirA and tempDirB (includes both JSON metadata and Skyway SQL migrations)
    const filesA = await getAllFilesRecursively(tempDirA);
    const filesB = await getAllFilesRecursively(tempDirB);

    const relativeA = filesA.map((f) => path.relative(tempDirA, f)).sort();
    const relativeB = filesB.map((f) => path.relative(tempDirB, f)).sort();

    expect(relativeA).toEqual(relativeB);

    // Verify 13 SQL migrations exist (1 baseline + 12 deltas) in both directories
    const sqlFilesA = relativeA.filter((f) => f.endsWith('.sql'));
    const sqlFilesB = relativeB.filter((f) => f.endsWith('.sql'));
    expect(sqlFilesA.length).toBe(13);
    expect(sqlFilesB.length).toBe(13);

    for (const rel of relativeA) {
      const fileA = path.join(tempDirA, rel);
      const fileB = path.join(tempDirB, rel);

      const hashA = await computeFileSha256(fileA);
      const hashB = await computeFileSha256(fileB);

      expect(hashA, `Mismatch in file: ${rel}`).toBe(hashB);
    }
  });

  it('verifies topological ordering (parents precede children) and dual-dialect migration emission', async () => {
    const loaded = await loadProject(enterpriseProjectPath);
    const sampleData: Record<string, Record<string, unknown>[]> = {
      OrderLine: [{ ID: 'ol-1', OrderID: 'ord-1', ProductID: 'prod-1', Quantity: 2, UnitPrice: 100, ExtendedPrice: 200 }],
      Payment: [{ ID: 'pay-1', OrderID: 'ord-1', PaymentMethod: 'CreditCard', Amount: 200, PaymentDate: '2026-09-02', Status: 'Settled' }],
      Subscription: [{ ID: 'sub-1', MemberID: 'mem-1', ProductID: 'prod-1', Status: 'Active', MonthlyFee: 100, AutoRenew: true, StartDate: '2026-09-02', EndDate: '2027-09-02' }],
      OrderHeader: [{ ID: 'ord-1', MemberID: 'mem-1', OrderNumber: 'ORD-001', OrderDate: '2026-09-02', TotalAmount: 200, Status: 'Completed', CreatedAt: '2026-09-02' }],
      Member: [{ ID: 'mem-1', CompanyID: 'comp-1', FirstName: 'John', LastName: 'Doe', Email: 'john@example.com', Title: 'VP', Status: 'Active', JoinDate: '2026-09-02', CreatedAt: '2026-09-02' }],
      Company: [{ ID: 'comp-1', Name: 'Acme Corp', Industry: 'Tech', Tier: 'Enterprise', Employees: 500, AnnualRevenue: 10000000, CreatedAt: '2026-09-02' }],
      Product: [{ ID: 'prod-1', SKU: 'SKU-001', Name: 'SaaS Pro', Category: 'Subscription', Price: 100, IsActive: true }],
    };

    // 1. Emit SQL Server migration
    const sqlServerFile = await emitSkywayMigration({
      outputDir: path.join(tempDirA, 'test-migrations'),
      version: '202609029998',
      description: 'Topological_Test_SQLServer',
      domain: loaded.domain,
      data: sampleData,
      dialect: 'sqlserver',
    });

    const sqlServerContent = await fs.readFile(sqlServerFile, 'utf8');
    expect(sqlServerContent).toContain('BEGIN TRANSACTION;');
    expect(sqlServerContent).toContain('COMMIT TRANSACTION;');

    // Verify parent tables are emitted BEFORE child tables in SQL Server
    const companyPos = sqlServerContent.indexOf('-- Entity: Company');
    const productPos = sqlServerContent.indexOf('-- Entity: Product');
    const memberPos = sqlServerContent.indexOf('-- Entity: Member');
    const subPos = sqlServerContent.indexOf('-- Entity: Subscription');
    const orderHeaderPos = sqlServerContent.indexOf('-- Entity: OrderHeader');
    const orderLinePos = sqlServerContent.indexOf('-- Entity: OrderLine');
    const paymentPos = sqlServerContent.indexOf('-- Entity: Payment');

    // Single parent relationships
    expect(companyPos).toBeLessThan(memberPos);
    expect(memberPos).toBeLessThan(orderHeaderPos);
    expect(orderHeaderPos).toBeLessThan(paymentPos);

    // Two-parent relationships:
    // OrderLine has parents (OrderHeader, Product)
    expect(orderHeaderPos).toBeLessThan(orderLinePos);
    expect(productPos).toBeLessThan(orderLinePos);

    // Subscription has parents (Member, Product)
    expect(memberPos).toBeLessThan(subPos);
    expect(productPos).toBeLessThan(subPos);

    // 2. Emit PostgreSQL migration
    const pgFile = await emitSkywayMigration({
      outputDir: path.join(tempDirA, 'test-migrations'),
      version: '202609029999',
      description: 'Topological_Test_Postgres',
      domain: loaded.domain,
      data: sampleData,
      dialect: 'postgres',
    });

    const pgContent = await fs.readFile(pgFile, 'utf8');
    expect(pgContent).toContain('BEGIN;');
    expect(pgContent).toContain('COMMIT;');
    expect(pgContent).toContain('"enterprise"."Company"');
    expect(pgContent).toContain('"enterprise"."OrderLine"');
    expect(pgContent).toContain('"enterprise"."Subscription"');
    expect(pgContent).toContain('"enterprise"."Payment"');
  });

  it('emits status transitions as transactional UPDATE statements in delta migrations (L1 requirement)', async () => {
    const loaded = await loadProject(enterpriseProjectPath);
    const migrDir = path.join(tempDirA, 'status-test-migrations');

    const migrFile = await emitSkywayMigration({
      outputDir: migrDir,
      version: '202609029998',
      description: 'Status_Transition_Emission_Test',
      domain: loaded.domain,
      data: {},
      statusTransitions: [
        {
          entity: 'Member',
          id: '11111111-2222-3333-4444-555555555555',
          fromStatus: 'Active',
          toStatus: 'Cancelled',
          effectiveDate: '2026-09-09',
        },
      ],
    });

    const content = await fs.readFile(migrFile, 'utf8');
    expect(content).toContain('-- Status Transitions');
    expect(content).toContain(
      "UPDATE [enterprise].[Member] SET [Status] = 'Cancelled' WHERE [ID] = '11111111-2222-3333-4444-555555555555';"
    );
  });

  it('deleting or altering a factor in the ruleset causes empirical validation to fail its derived gate (L1 requirement)', async () => {
    const loaded = await loadProject(enterpriseProjectPath);

    // 1. Snapshot of dataset generated with the factor present
    const membersWithFactor: Record<string, unknown>[] = JSON.parse(
      await fs.readFile(path.join(metaDirA, 'core', 'Member.json'), 'utf8')
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
    const testMigrAltered = path.join(tempDirA, 'migr-altered');
    await executeBuild({
      project: tempProjDir,
      seed: '42',
      output: testMetaAltered,
      migrationsOutput: testMigrAltered,
    });

    const membersAltered: Record<string, unknown>[] = JSON.parse(
      await fs.readFile(path.join(testMetaAltered, 'core', 'Member.json'), 'utf8')
    );
    const activeCountAltered = membersAltered.filter((m) => m['Status'] === 'Active').length;
    const rateAltered = activeCountAltered / membersAltered.length;

    // (a) Assert the observed distribution changes by more than the tolerance
    expect(Math.abs(rateAltered - rateWith)).toBeGreaterThan(originalFactor!.tolerance);

    // (b) Assert the original factor's gate now fails against the altered dataset
    const recordsAltered: Record<string, Record<string, unknown>[]> = {};
    for (const [entity, entityCfg] of Object.entries(loaded.domain.entities)) {
      const filePath = path.join(testMetaAltered, entityCfg.pack, `${entity}.json`);
      recordsAltered[entity] = JSON.parse(await fs.readFile(filePath, 'utf8'));
    }

    const validator = new Validator();
    const report = validator.Validate(loaded.domain, recordsAltered, [originalFactor!]);
    expect(report.passed).toBe(false);
    expect(report.gates.some((g) => g.name.includes(originalFactor!.id) && !g.passed)).toBe(true);
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
