import { z } from 'zod';

export const EvidenceConfidenceSchema = z.enum(['high', 'medium', 'low', 'estimate']);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;

export const FactorEvidenceSchema = z.object({
  source: z.string().min(1),
  confidence: EvidenceConfidenceSchema,
  notes: z.string().optional(),
});
export type FactorEvidence = z.infer<typeof FactorEvidenceSchema>;

export const FeatureQuerySchema = z.object({
  from: z.string().min(1).default('self'),
  field: z.string().optional(),
  path: z.array(z.string()).optional(),
  where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'exists']).optional(),
});
export type FeatureQuery = z.infer<typeof FeatureQuerySchema>;

export const FactorArrowSchema = z.object({
  name: z.string().min(1),
  beta: z.number(),
  feature: FeatureQuerySchema,
  description: z.string().optional(),
});
export type FactorArrow = z.infer<typeof FactorArrowSchema>;

export const FactorContractSchema = z.object({
  id: z.string().min(1),
  effect: z.string().min(1),
  target: z.number(),
  tolerance: z.number().positive(),
  evidence: FactorEvidenceSchema,
  outcome: FeatureQuerySchema, // Declared feature measuring the realized outcome (required for bidirectional empirical validation)
  arrows: z.record(z.string(), FactorArrowSchema).default({}),
  description: z.string().optional(),
});
export type FactorContract = z.infer<typeof FactorContractSchema>;

export const LatentDialConfigSchema = z.object({
  name: z.string().min(1),
  mean: z.number().default(0),
  stdDev: z.number().positive().default(1),
  annualWanderStdDev: z.number().default(0.15),
  correlations: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  description: z.string().optional(),
});
export type LatentDialConfig = z.infer<typeof LatentDialConfigSchema>;
