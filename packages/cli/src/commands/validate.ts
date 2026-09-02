import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import { Validator, type ValidationReport } from '@memberjunction/loom-engine';

export interface ValidateCommandOptions {
  project: string;
  data?: string;
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
      records[entityName] = JSON.parse(content);
    } catch {
      records[entityName] = [];
    }
  }

  const validator = new Validator();
  const report = validator.validate(loaded.domain, records, []);

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
