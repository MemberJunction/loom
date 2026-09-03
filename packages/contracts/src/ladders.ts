import { z } from 'zod';

export const StateLadderBindingModeSchema = z.enum(['field', 'childEntity']);
export type StateLadderBindingMode = z.infer<typeof StateLadderBindingModeSchema>;

export const StateLadderBindingSchema = z.object({
  mode: StateLadderBindingModeSchema,
  field: z.string().optional(),
  childEntity: z.string().optional(),
  foreignKey: z.string().optional(),
  stateField: z.string().optional(),
  termField: z.string().optional(),
});
export type StateLadderBinding = z.infer<typeof StateLadderBindingSchema>;

export const LadderPrerequisiteSchema = z.object({
  priorState: z.string().optional(),
  minCyclesSinceBirth: z.number().int().optional(),
  dials: z.record(
    z.string(),
    z.object({
      min: z.number().optional(),
      max: z.number().optional(),
    })
  ).optional(),
});
export type LadderPrerequisite = z.infer<typeof LadderPrerequisiteSchema>;

export const LadderEffectSchema = z.object({
  factor: z.string().min(1),
  beta: z.number(),
});
export type LadderEffect = z.infer<typeof LadderEffectSchema>;

export const LadderExitEffectSchema = z.object({
  dial: z.string().min(1),
  delta: z.number(),
});
export type LadderExitEffect = z.infer<typeof LadderExitEffectSchema>;

export const StateLadderStateSchema = z.object({
  name: z.string().min(1),
  capacity: z.number().int().positive().optional(),
  durationCycles: z.number().int().positive(),
  prerequisites: LadderPrerequisiteSchema.optional(),
  effects: z.array(LadderEffectSchema).default([]),
  exitEffects: z.array(LadderExitEffectSchema).default([]),
});
export type StateLadderState = z.infer<typeof StateLadderStateSchema>;

export const StateLadderConfigSchema = z.object({
  ladderKey: z.string().min(1),
  entity: z.string().min(1),
  binding: StateLadderBindingSchema,
  cohortShare: z.number().min(0).max(1).default(1),
  states: z.array(StateLadderStateSchema),
  description: z.string().optional(),
});
export type StateLadderConfig = z.infer<typeof StateLadderConfigSchema>;

export const LaddersManifestSchema = z.object({
  $schema: z.string().optional(),
  ladders: z.array(StateLadderConfigSchema),
});
export type LaddersManifest = z.infer<typeof LaddersManifestSchema>;
