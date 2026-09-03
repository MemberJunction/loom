import { z } from 'zod';

export const ContinuityStateSchema = z.object({
  asOfDate: z.string().min(10), // YYYY-MM-DD
  cycleIndex: z.number().int().nonnegative(),
  activeEntityIds: z.record(z.string(), z.array(z.string().uuid())).default({}),
  latentStates: z.record(z.string(), z.record(z.string(), z.number())).default({}), // entityId -> { dialName: value }
  activeLifecycleStates: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
  birthCycles: z.record(z.string(), z.number().int()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ContinuityState = z.infer<typeof ContinuityStateSchema>;

export const DeltaRecordsSchema = z.object({
  cycleIndex: z.number().int().nonnegative(),
  asOfDate: z.string().min(10),
  generatedRecords: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  statusTransitions: z.array(z.object({
    entity: z.string(),
    id: z.string().uuid(),
    fromStatus: z.string(),
    toStatus: z.string(),
    effectiveDate: z.string(),
  })).default([]),
});
export type DeltaRecords = z.infer<typeof DeltaRecordsSchema>;

export const SimulationCheckpointSchema = z.object({
  domain: z.string().min(1),
  seed: z.number().int(),
  releaseDate: z.string().min(10),
  cycleIndex: z.number().int().nonnegative().default(0),
  continuity: ContinuityStateSchema,
  committedRecordCounts: z.record(z.string(), z.number().int().nonnegative()),
  lastGeneratedDelta: DeltaRecordsSchema.optional(),
});
export type SimulationCheckpoint = z.infer<typeof SimulationCheckpointSchema>;
