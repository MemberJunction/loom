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
  startCycle: z.number().int(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cycleUnit: z.enum(['year', 'week', 'month', 'cycle']).default('year'),
  output: z.object({
    metadataDir: z.string().default('./metadata'),
    migrationsDir: z.string().optional(),
    sqlDialect: z.enum(['sqlserver', 'postgres']).default('sqlserver'),
  }).default({
    metadataDir: './metadata',
    sqlDialect: 'sqlserver',
  }),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
