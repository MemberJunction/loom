import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  DomainConfigSchema,
  ProjectManifestSchema,
  type DomainConfig,
  type ProjectManifest,
  type RulesetModule,
  RulesetModuleSchema,
} from '@memberjunction/loom-contracts';

export interface LoadedProject {
  projectDir: string;
  manifest: ProjectManifest;
  domain: DomainConfig;
  rulesetModules: Record<string, RulesetModule>;
}

/**
 * Loads and validates a Loom simulation project from disk.
 */
export async function loadProject(projectPath: string): Promise<LoadedProject> {
  const resolvedDir = path.resolve(process.cwd(), projectPath);

  // 1. Load project manifest (project.json or loom.json)
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(resolvedDir, 'project.json'), 'utf8');
  } catch {
    manifestRaw = await fs.readFile(path.join(resolvedDir, 'loom.json'), 'utf8');
  }

  const manifest = ProjectManifestSchema.parse(JSON.parse(manifestRaw));

  // 2. Load domain config
  const domainRaw = await fs.readFile(path.join(resolvedDir, 'domain.json'), 'utf8');
  const domain = DomainConfigSchema.parse(JSON.parse(domainRaw));

  // 3. Load ruleset modules
  const rulesetModules: Record<string, RulesetModule> = {};
  const rulesetDir = path.join(resolvedDir, manifest.rulesetPath);

  try {
    const entries = await fs.readdir(rulesetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const fileContent = await fs.readFile(path.join(rulesetDir, entry.name), 'utf8');
        const parsed = RulesetModuleSchema.parse(JSON.parse(fileContent));
        rulesetModules[parsed.name] = parsed;
      }
    }
  } catch {
    // If no ruleset dir exists, check for a single ruleset.json
    try {
      const singleRaw = await fs.readFile(path.join(resolvedDir, 'ruleset.json'), 'utf8');
      const parsed = RulesetModuleSchema.parse(JSON.parse(singleRaw));
      rulesetModules[parsed.name] = parsed;
    } catch {
      // Empty ruleset allowed for minimal fixture
    }
  }

  return {
    projectDir: resolvedDir,
    manifest,
    domain,
    rulesetModules,
  };
}
