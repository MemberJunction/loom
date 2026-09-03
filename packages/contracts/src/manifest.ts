import { z } from 'zod';

export const ProjectManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  domain: z.string().min(1),
  uuidNamespace: z.string().uuid(),
  description: z.string().optional(),
  entrypoint: z.string().default('./index.ts'),
  rulesetPath: z.string().default('./ruleset'),
  banksPath: z.string().optional(),
  narrativePath: z.string().optional(),
  output: z.object({
    metadataDir: z.string().default('./metadata'),
    migrationsDir: z.string().default('./migrations'),
    sqlDialect: z.enum(['sqlserver', 'postgres']).default('sqlserver'),
  }).default({
    metadataDir: './metadata',
    migrationsDir: './migrations',
    sqlDialect: 'sqlserver',
  }),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
