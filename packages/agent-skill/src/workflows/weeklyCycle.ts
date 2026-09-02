import type { DomainConfig, FactorContract } from '@memberjunction/loom-contracts';
import { Accumulator, Validator, type ValidationReport } from '@memberjunction/loom-engine';
import { runVisualInspection, type VisualInspectionResult } from '../playwright/explorer.js';

export interface WeeklyCycleOptions {
  domain: DomainConfig;
  cycleIndex: number;
  asOfDate: string;
  priorState: Record<string, readonly Record<string, unknown>[]>;
  currentState: Record<string, readonly Record<string, unknown>[]>;
  factors?: readonly FactorContract[];
  enableVisualInspection?: boolean;
  explorerUrl?: string;
  routesToInspect?: string[];
}

export interface WeeklyCycleResult {
  passed: boolean;
  cycleIndex: number;
  newRecordCounts: Record<string, number>;
  validation: ValidationReport;
  visualInspection?: VisualInspectionResult;
}

/**
 * Orchestrates the complete weekly simulation lifecycle:
 * 1. Stateful accumulation & delta separation
 * 2. Deterministic validation gates (Invariant 7)
 * 3. Playwright visual verification
 */
export async function runWeeklySimulationCycle(
  options: WeeklyCycleOptions
): Promise<WeeklyCycleResult> {
  // Step 1: Accumulate deltas
  const accumulator = new Accumulator();
  const diff = accumulator.computeDelta(
    options.domain,
    options.cycleIndex,
    options.asOfDate,
    options.priorState,
    options.currentState
  );

  // Step 2: Validate deterministic gates
  const validator = new Validator();
  const validation = validator.validate(
    options.domain,
    options.currentState,
    options.factors ?? []
  );

  // Step 3: Run Playwright visual inspection if enabled
  let visualInspection: VisualInspectionResult | undefined;
  if (options.enableVisualInspection) {
    visualInspection = await runVisualInspection({
      explorerUrl: options.explorerUrl,
      routesToInspect: options.routesToInspect,
    });
  }

  const passed = validation.passed && (!visualInspection || visualInspection.passed);

  return {
    passed,
    cycleIndex: options.cycleIndex,
    newRecordCounts: diff.newRecordCounts,
    validation,
    visualInspection,
  };
}
