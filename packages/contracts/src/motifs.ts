import { z } from 'zod';

export const MotifQuotaModeSchema = z.enum(['count', 'percentage']);
export type MotifQuotaMode = z.infer<typeof MotifQuotaModeSchema>;

export const MotifRoundingSchema = z.enum(['round', 'floor', 'ceil']);
export type MotifRounding = z.infer<typeof MotifRoundingSchema>;

export const MotifQuotaSchema = z.object({
  mode: MotifQuotaModeSchema,
  value: z.number().nonnegative(),
  rounding: MotifRoundingSchema.default('round'),
});
export type MotifQuota = z.infer<typeof MotifQuotaSchema>;

export const LatentTrajectorySchema = z.object({
  dial: z.string().min(1),
  deltaPerCycle: z.number(),
});
export type LatentTrajectory = z.infer<typeof LatentTrajectorySchema>;

export const ChildRateSchema = z.object({
  entity: z.string().min(1),
  perCycle: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
});
export type ChildRate = z.infer<typeof ChildRateSchema>;

export const FactorOverrideSchema = z.object({
  factor: z.string().min(1),
  beta: z.number().optional(),
  probability: z.number().min(0).max(1).optional(),
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
    })
  ).optional(),
  latentTrajectory: LatentTrajectorySchema.optional(),
  childRates: z.array(ChildRateSchema).default([]),
  ladderProgression: z.object({
    ladderKey: z.string().min(1),
    initialState: z.string().min(1),
  }).optional(),
  eras: z.array(z.string()).default([]),
  factorOverrides: z.array(FactorOverrideSchema).default([]),
  fixedFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  description: z.string().optional(),
});
export type MotifConfig = z.infer<typeof MotifConfigSchema>;

export const MotifsManifestSchema = z.object({
  $schema: z.string().optional(),
  motifs: z.array(MotifConfigSchema),
});
export type MotifsManifest = z.infer<typeof MotifsManifestSchema>;
