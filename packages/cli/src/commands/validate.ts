import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import { Validator, readEntityMetadata, extractComposedRecords, type ValidationReport, type GateResult } from '@memberjunction/loom-engine';

export interface ValidateCommandOptions {
  project?: string;
  config?: string;
  data?: string;
}

export async function executeValidate(options: ValidateCommandOptions): Promise<ValidationReport> {
  const projectPath = options.config ?? options.project;
  if (!projectPath) {
    throw new Error('Validate: either --project or --config must be provided');
  }
  const loaded = await loadProject(projectPath);
  const dataDir = options.data
    ? path.resolve(process.cwd(), options.data)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);

  console.log(`🧵 Loom Validate: Verifying dataset for '${loaded.domain.name}'`);
  console.log(`   Source: ${dataDir}`);

  // Load all metadata records via MetadataSync format reader and enforce format gates
  const records: Record<string, Record<string, unknown>[]> = {};
  const syncGates: GateResult[] = [];

  // Root .mj-sync.json validation gate
  const rootSyncPath = path.join(dataDir, '.mj-sync.json');
  try {
    const raw = fs.readFileSync(rootSyncPath, 'utf8');
    const rootConfig = JSON.parse(raw);
    if (!Array.isArray(rootConfig.directoryOrder) || rootConfig.directoryOrder.length === 0) {
      throw new Error("Root '.mj-sync.json' missing required 'directoryOrder' array");
    }
    syncGates.push({
      name: `MetadataSync: Root Manifest (.mj-sync.json)`,
      category: 'schema',
      passed: true,
      message: `Root directoryOrder declares topological sequence (${rootConfig.directoryOrder.length} entities)`,
      populationCount: rootConfig.directoryOrder.length,
    });
  } catch (rootErr) {
    syncGates.push({
      name: `MetadataSync: Root Manifest (.mj-sync.json)`,
      category: 'schema',
      passed: false,
      message: rootErr instanceof Error ? rootErr.message : String(rootErr),
      populationCount: 0,
    });
  }

  // Identify composed children that do not have their own standalone output directories
  const composedChildren = new Set<string>();
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    if (entityCfg.composition?.isA) {
      composedChildren.add(entityName);
    }
    if (entityCfg.composition?.collections) {
      for (const col of Object.values(entityCfg.composition.collections)) {
        composedChildren.add(col.entity);
      }
    }
    if (entityCfg.composition?.embeds) {
      for (const emb of Object.values(entityCfg.composition.embeds)) {
        composedChildren.add(emb.entity);
      }
    }
  }

  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    if (composedChildren.has(entityName)) {
      records[entityName] = [];
      continue;
    }

    const dirName = entityCfg.outputDirectory ?? entityName;
    const entityDir = path.join(dataDir, dirName);
    try {
      const { records: unwrapped } = await readEntityMetadata(entityDir, entityCfg.entityName);
      records[entityName] = unwrapped;
      syncGates.push({
        name: `MetadataSync: ${entityName} (.mj-sync.json & record wrapper)`,
        category: 'schema',
        passed: true,
        message: `Entity directory '${dirName}' conforms to MetadataSync specifications`,
        populationCount: unwrapped.length,
      });
    } catch (syncErr) {
      records[entityName] = [];
      syncGates.push({
        name: `MetadataSync: ${entityName} (.mj-sync.json & record wrapper)`,
        category: 'schema',
        passed: false,
        message: syncErr instanceof Error ? syncErr.message : String(syncErr),
        populationCount: 0,
      });
    }
  }

  // Extract composed records into child entity lists for validation and factor checks
  const decomposed = extractComposedRecords(loaded.domain, records);
  for (const [e, rows] of Object.entries(decomposed)) {
    records[e] = rows;
  }

  for (const childName of composedChildren) {
    const count = records[childName]?.length ?? 0;
    syncGates.push({
      name: `MetadataSync: ${childName} (Composed)`,
      category: 'schema',
      passed: true,
      message: `Composed entity '${childName}' loaded from parent records (${count} records)`,
      populationCount: count,
    });
  }

  const totalLoaded = Object.values(records).reduce((sum, r) => sum + r.length, 0);
  if (totalLoaded === 0 && syncGates.every((g) => !g.passed)) {
    console.error(`❌ MetadataSync Ingestibility Failed: Directory structure missing or malformed in '${dataDir}'.`);
  }

  // Compile factor contracts from ruleset modules
  const allFactors = Object.values(loaded.rulesetModules).flatMap((mod) =>
    Object.values(mod.effects)
  );

  const validator = new Validator();
  const heroes = loaded.heroesManifest?.heroes ?? [];
  const eras = loaded.erasManifest?.eras ?? [];
  const report = validator.Validate(loaded.domain, records, allFactors, heroes, eras, loaded.catalogs);

  // Prepend MetadataSync gates
  report.gates.unshift(...syncGates);
  report.totalGates += syncGates.length;
  report.passedCount += syncGates.filter((g) => g.passed).length;
  report.failedCount += syncGates.filter((g) => !g.passed).length;
  if (syncGates.some((g) => !g.passed)) {
    report.passed = false;
  }

  console.log(`\nValidation Report:`);
  console.log(`------------------------------------------------------------`);
  for (const gate of report.gates) {
    const status = gate.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  [${status}] ${gate.name} (n=${gate.populationCount})`);
    if (!gate.passed) {
      console.log(`         Error: ${gate.message}`);
    }
  }
  console.log(`------------------------------------------------------------`);
  console.log(`Total Gates: ${report.totalGates} | Passed: ${report.passedCount} | Failed: ${report.failedCount} | Total Rows Examined: ${report.totalPopulationExamined}\n`);

  if (!report.passed) {
    process.exitCode = 1;
    console.error(`❌ Validation failed with ${report.failedCount} broken gate(s).`);
  } else {
    console.log(`✅ All validation gates passed.`);
  }

  return report;
}
