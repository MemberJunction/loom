#!/usr/bin/env node
import { Command } from 'commander';
import { executeBuild } from '../commands/build.js';
import { executeAccumulate } from '../commands/accumulate.js';
import { executeValidate } from '../commands/validate.js';

const program = new Command();

program
  .name('loom')
  .description('Deterministic, causal business world and data simulation engine for MemberJunction')
  .version('0.1.0');

program
  .command('build')
  .alias('gen')
  .description('Build full simulation baseline from declarative metadata')
  .option('-p, --project <path>', 'Path to project directory containing domain.json')
  .option('-c, --config <path>', 'Path to project config file or directory')
  .option('-s, --seed <number>', 'Deterministic seed', '42')
  .option('-r, --release <date>', 'Release baseline date (YYYY-MM-DD)', '2026-09-02')
  .option('-o, --output <dir>', 'Custom output directory for metadata')
  .action(async (opts) => {
    try {
      await executeBuild(opts);
    } catch (err) {
      console.error('Build Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('generate')
  .description('Generate full simulation world metadata from declarative inputs')
  .option('-p, --project <path>', 'Path to project directory containing domain.json')
  .option('-c, --config <path>', 'Path to project config file or directory')
  .option('-s, --seed <number>', 'Deterministic seed', '42')
  .option('-r, --release <date>', 'Release baseline date (YYYY-MM-DD)', '2026-09-02')
  .option('-o, --output <dir>', 'Custom output directory for metadata')
  .action(async (opts) => {
    try {
      await executeBuild(opts);
    } catch (err) {
      console.error('Generate Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Export simulated metadata to target directory')
  .option('-p, --project <path>', 'Path to project directory containing domain.json')
  .option('-c, --config <path>', 'Path to project config file or directory')
  .option('-s, --seed <number>', 'Deterministic seed', '42')
  .option('-r, --release <date>', 'Release baseline date (YYYY-MM-DD)', '2026-09-02')
  .option('-o, --output <dir>', 'Target output directory for exported metadata')
  .action(async (opts) => {
    try {
      await executeBuild(opts);
    } catch (err) {
      console.error('Export Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('accumulate')
  .description('Advance simulation by N cycles and emit pure delta metadata')
  .option('-p, --project <path>', 'Path to project directory')
  .option('-c, --config <path>', 'Path to project config file or directory')
  .requiredOption('--prior-state <dir>', 'Path to committed metadata/ directory')
  .option('-w, --weeks <number>', 'Number of weeks to advance', '1')
  .option('-s, --seed <number>', 'Simulation seed', '42')
  .option('-a, --as-of <date>', 'Explicit as-of simulation date (YYYY-MM-DD)')
  .option('-o, --output <dir>', 'Custom output directory for metadata')
  .action(async (opts) => {
    try {
      await executeAccumulate(opts);
    } catch (err) {
      console.error('Accumulate Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Execute statistical and referential validation gates')
  .option('-p, --project <path>', 'Path to project directory')
  .option('-c, --config <path>', 'Path to project config file or directory')
  .option('-d, --data <dir>', 'Path to metadata directory to validate')
  .action(async (opts) => {
    try {
      await executeValidate(opts);
    } catch (err) {
      console.error('Validate Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
