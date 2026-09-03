import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import { Validator, type ValidationReport } from '@memberjunction/loom-engine';

export interface ValidateCommandOptions {
  project: string;
  data?: string;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}

export async function executeValidate(options: ValidateCommandOptions): Promise<ValidationReport> {
  const loaded = await loadProject(options.project);
  const dataDir = options.data
    ? path.resolve(process.cwd(), options.data)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);

  console.log(`🧵 Loom Validate: Verifying dataset for '${loaded.domain.name}'`);
  console.log(`   Source: ${dataDir}`);

  // Load all metadata records
  const records: Record<string, Record<string, unknown>[]> = {};

  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const filePath = path.join(dataDir, entityCfg.pack, `${entityName}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (jsonErr) {
        throw new Error(`Invalid JSON syntax in metadata file '${filePath}': ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`Metadata file '${filePath}' must contain a JSON array of records`);
      }
      records[entityName] = parsed as Record<string, unknown>[];
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
      records[entityName] = [];
    }
  }

  // Compile factor contracts from ruleset modules
  const allFactors = Object.values(loaded.rulesetModules).flatMap((mod) =>
    Object.values(mod.effects)
  );

  const validator = new Validator();
  const report = validator.Validate(loaded.domain, records, allFactors);

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
