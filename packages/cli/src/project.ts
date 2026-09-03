import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  DomainConfigSchema,
  ProjectManifestSchema,
  RulesetModuleSchema,
  HeroesManifestSchema,
  MotifsManifestSchema,
  LaddersManifestSchema,
  ErasManifestSchema,
  validateHeroesAgainstDomain,
  validateMotifsAgainstDomain,
  validateLaddersAgainstDomain,
  validateErasAgainstDomain,
  type DomainConfig,
  type ProjectManifest,
  type RulesetModule,
  type HeroesManifest,
  type MotifsManifest,
  type LaddersManifest,
  type ErasManifest,
} from '@memberjunction/loom-contracts';

export interface LoadedProject {
  projectDir: string;
  manifest: ProjectManifest;
  domain: DomainConfig;
  rulesetModules: Record<string, RulesetModule>;
  heroesManifest?: HeroesManifest;
  motifsManifest?: MotifsManifest;
  laddersManifest?: LaddersManifest;
  erasManifest?: ErasManifest;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}

/**
 * Loads and validates a Loom simulation project from disk.
 * Strictly throws on any JSON syntax error or Zod validation failure.
 * Runs domain schema closure checks on heroes, motifs, ladders, and eras.
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

  // 3. Load ruleset modules and Plan 02 manifests
  const rulesetModules: Record<string, RulesetModule> = {};
  let heroesManifest: HeroesManifest | undefined;
  let motifsManifest: MotifsManifest | undefined;
  let laddersManifest: LaddersManifest | undefined;
  let erasManifest: ErasManifest | undefined;

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
          throw new Error(`Invalid JSON in ruleset file '${filePath}': ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
        }

        if (entry.name === 'heroes.json') {
          const parsed = HeroesManifestSchema.parse(moduleJson);
          const valRes = validateHeroesAgainstDomain(parsed, domain);
          if (!valRes.valid) {
            throw new Error(`Heroes manifest failed domain validation:\n  ${valRes.errors.join('\n  ')}`);
          }
          heroesManifest = parsed;
        } else if (entry.name === 'motifs.json') {
          const parsed = MotifsManifestSchema.parse(moduleJson);
          const valRes = validateMotifsAgainstDomain(parsed, domain);
          if (!valRes.valid) {
            throw new Error(`Motifs manifest failed domain validation:\n  ${valRes.errors.join('\n  ')}`);
          }
          motifsManifest = parsed;
        } else if (entry.name === 'ladders.json') {
          const parsed = LaddersManifestSchema.parse(moduleJson);
          const valRes = validateLaddersAgainstDomain(parsed, domain);
          if (!valRes.valid) {
            throw new Error(`Ladders manifest failed domain validation:\n  ${valRes.errors.join('\n  ')}`);
          }
          laddersManifest = parsed;
        } else if (entry.name === 'eras.json') {
          const parsed = ErasManifestSchema.parse(moduleJson);
          const valRes = validateErasAgainstDomain(parsed, domain);
          if (!valRes.valid) {
            throw new Error(`Eras manifest failed domain validation:\n  ${valRes.errors.join('\n  ')}`);
          }
          erasManifest = parsed;
        } else {
          const parsed = RulesetModuleSchema.parse(moduleJson);
          rulesetModules[parsed.name] = parsed;
        }
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
    }
  }

  return {
    projectDir: resolvedDir,
    manifest,
    domain,
    rulesetModules,
    heroesManifest,
    motifsManifest,
    laddersManifest,
    erasManifest,
  };
}
