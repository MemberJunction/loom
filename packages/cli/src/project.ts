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

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}

/**
 * Loads and validates a Loom simulation project from disk.
 * Strictly throws on any JSON syntax error or Zod validation failure.
 * Only ENOENT (file not found) is permitted to fall through to defaults.
 */
export async function loadProject(projectPath: string): Promise<LoadedProject> {
  const resolvedDir = path.resolve(process.cwd(), projectPath);

  // 1. Load project manifest (project.json or loom.json)
  let manifestRaw: string;
  const projectJsonPath = path.join(resolvedDir, 'project.json');
  const loomJsonPath = path.join(resolvedDir, 'loom.json');

  try {
    manifestRaw = await fs.readFile(projectJsonPath, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) {
      throw new Error(`Failed to read project manifest at '${projectJsonPath}': ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      manifestRaw = await fs.readFile(loomJsonPath, 'utf8');
    } catch (loomErr) {
      if (isEnoent(loomErr)) {
        throw new Error(`No project manifest found in '${resolvedDir}' (checked project.json and loom.json)`);
      }
      throw new Error(`Failed to read project manifest at '${loomJsonPath}': ${loomErr instanceof Error ? loomErr.message : String(loomErr)}`);
    }
  }

  let parsedManifestJson: unknown;
  try {
    parsedManifestJson = JSON.parse(manifestRaw);
  } catch (parseErr) {
    throw new Error(`Invalid JSON syntax in project manifest: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
  }
  const manifest = ProjectManifestSchema.parse(parsedManifestJson);

  // 2. Load domain config
  const domainPath = path.join(resolvedDir, 'domain.json');
  let domainRaw: string;
  try {
    domainRaw = await fs.readFile(domainPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read domain config at '${domainPath}': ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsedDomainJson: unknown;
  try {
    parsedDomainJson = JSON.parse(domainRaw);
  } catch (parseErr) {
    throw new Error(`Invalid JSON syntax in domain.json at '${domainPath}': ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
  }
  const domain = DomainConfigSchema.parse(parsedDomainJson);

  // 3. Load ruleset modules
  const rulesetModules: Record<string, RulesetModule> = {};
  const rulesetDir = path.join(resolvedDir, manifest.rulesetPath);

  try {
    const entries = await fs.readdir(rulesetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const filePath = path.join(rulesetDir, entry.name);
        const fileContent = await fs.readFile(filePath, 'utf8');
        let moduleJson: unknown;
        try {
          moduleJson = JSON.parse(fileContent);
        } catch (jsonErr) {
          throw new Error(`Invalid JSON in ruleset module '${filePath}': ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
        }
        const parsed = RulesetModuleSchema.parse(moduleJson);
        rulesetModules[parsed.name] = parsed;
      }
    }
  } catch (err) {
    if (!isEnoent(err)) {
      throw new Error(`Error reading ruleset directory '${rulesetDir}': ${err instanceof Error ? err.message : String(err)}`);
    }
    // Fall back to single ruleset.json if ruleset/ directory does not exist
    const singleRulesetPath = path.join(resolvedDir, 'ruleset.json');
    try {
      const singleRaw = await fs.readFile(singleRulesetPath, 'utf8');
      let moduleJson: unknown;
      try {
        moduleJson = JSON.parse(singleRaw);
      } catch (jsonErr) {
        throw new Error(`Invalid JSON in ruleset file '${singleRulesetPath}': ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
      }
      const parsed = RulesetModuleSchema.parse(moduleJson);
      rulesetModules[parsed.name] = parsed;
    } catch (singleErr) {
      if (!isEnoent(singleErr)) {
        throw singleErr;
      }
      // Allowed to have empty ruleset if neither exists
    }
  }

  return {
    projectDir: resolvedDir,
    manifest,
    domain,
    rulesetModules,
  };
}
