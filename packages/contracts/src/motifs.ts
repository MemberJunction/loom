import { z } from 'zod';

export const MotifQuotaSchema = z.object({
  mode: z.enum(['count', 'percentage']),
  value: z.number().min(0),
  rounding: z.enum(['floor', 'ceil', 'round']).default('round'),
}).strict().refine((q) => {
  if (q.mode === 'percentage') {
    return q.value <= 1; // fraction in [0, 1]
  }
  return q.value >= 1;
}, {
  message: "Percentage quota value must be a fraction in [0, 1]; count quota must be >= 1",
});
export type MotifQuota = z.infer<typeof MotifQuotaSchema>;

export const LatentTrajectorySchema = z.object({
  dial: z.string().min(1),
  deltaPerCycle: z.number(),
  acceleration: z.number().optional(),
}).strict();
export type LatentTrajectory = z.infer<typeof LatentTrajectorySchema>;

export const ChildRateSchema = z.object({
  entity: z.string().min(1),
  perCycle: z.union([
    z.number().min(0),
    z.object({
      min: z.number().min(0),
      max: z.number().min(0),
    }).strict(),
  ]),
  condition: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();
export type ChildRate = z.infer<typeof ChildRateSchema>;

export const FactorOverrideSchema = z.object({
  factor: z.string().min(1),
  beta: z.number().optional(),
  probability: z.number().min(0).max(1).optional(),
}).strict().refine((o) => o.beta !== undefined || o.probability !== undefined, {
  message: "FactorOverride must specify at least one of 'beta' or 'probability'",
});
export type FactorOverride = z.infer<typeof FactorOverrideSchema>;

export const MotifConfigSchema = z.object({
  motifKey: z.string().min(1),
  targetEntity: z.string().min(1),
  quota: MotifQuotaSchema,
  birthCycles: z.array(z.number().int()).optional(),
  latentConstraints: z.record(
    z.string(),
    z.object({
      min: z.number().optional(),
      max: z.number().optional(),
    }).strict()
  ).optional(),
  latentTrajectory: LatentTrajectorySchema.optional(),
  childRates: z.array(ChildRateSchema).default([]),
  ladderProgression: z.object({
    ladderKey: z.string().min(1),
    initialState: z.string().min(1),
  }).strict().optional(),
  eras: z.array(z.string()).default([]),
  factorOverrides: z.array(FactorOverrideSchema).default([]),
  fixedFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  description: z.string().optional(),
}).strict();
export type MotifConfig = z.infer<typeof MotifConfigSchema>;

export const MotifsManifestSchema = z.object({
  $schema: z.string().optional(),
  motifs: z.array(MotifConfigSchema),
}).strict();
export type MotifsManifest = z.infer<typeof MotifsManifestSchema>;
