import type { DomainConfig, FactorContract } from '@memberjunction/loom-contracts';
import { Accumulator, Validator, type ValidationReport } from '@memberjunction/loom-engine';
import { executeAccumulate, executeValidate } from '@memberjunction/loom-cli';
import { runVisualInspection, type VisualInspectionResult } from '../playwright/explorer.js';

export interface WeeklyCycleWorkflowOptions {
  projectDir: string;
  priorStateDir: string;
  generatedDir: string;
  cycles?: number | string;
  seed?: number | string;
  pushCommand?: string;
  executePush?: (command: string) => Promise<void> | void;
  enableVisualInspection?: boolean;
  explorerUrl?: string;
  routesToInspect?: string[];
  recordStep?: (stepName: 'accumulate' | 'validate' | 'push' | 'playwright', commandLine?: string) => void;
}

export interface WeeklyCycleWorkflowResult {
  passed: boolean;
  executionOrder: Array<'accumulate' | 'validate' | 'push' | 'playwright'>;
  validation: ValidationReport;
  pushCommandLine?: string;
  visualInspection?: VisualInspectionResult;
}

/**
 * L10-5 Agent skill workflow:
 * 1. loom accumulate against project directory
 * 2. Validator over accumulated dataset
 * 3. Configurable push command (mj sync push --dir <generated>)
 * 4. Playwright visual verification
 */
export async function weeklyCycle(
  options: WeeklyCycleWorkflowOptions
): Promise<WeeklyCycleWorkflowResult> {
  const executionOrder: Array<'accumulate' | 'validate' | 'push' | 'playwright'> = [];

  // Step 1: Run loom accumulate code path against project directory
  executionOrder.push('accumulate');
  options.recordStep?.('accumulate');
  await executeAccumulate({
    project: options.projectDir,
    priorState: options.priorStateDir,
    output: options.generatedDir,
    cycles: String(options.cycles ?? 1),
    seed: String(options.seed ?? 42),
  });

  // Step 2: Run Validator
  executionOrder.push('validate');
  options.recordStep?.('validate');
  const validation = await executeValidate({
    project: options.projectDir,
    data: options.generatedDir,
  });

  if (!validation.passed) {
    return {
      passed: false,
      executionOrder,
      validation,
    };
  }

  // Step 3: Run configurable push command
  const pushCmd = options.pushCommand ?? `mj sync push --dir ${options.generatedDir}`;
  executionOrder.push('push');
  options.recordStep?.('push', pushCmd);
  if (options.executePush) {
    await options.executePush(pushCmd);
  }

  // Step 4: Run Playwright visual verification
  let visualInspection: VisualInspectionResult | undefined;
  if (options.enableVisualInspection) {
    executionOrder.push('playwright');
    options.recordStep?.('playwright');
    visualInspection = await runVisualInspection({
      explorerUrl: options.explorerUrl,
      routesToInspect: options.routesToInspect,
    });
  }

  const passed = validation.passed && (!visualInspection || visualInspection.passed);

  return {
    passed,
    executionOrder,
    validation,
    pushCommandLine: pushCmd,
    visualInspection,
  };
}

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
 * Legacy in-memory simulation cycle
 */
export async function runWeeklySimulationCycle(
  options: WeeklyCycleOptions
): Promise<WeeklyCycleResult> {
  const accumulator = new Accumulator();
  const diff = accumulator.ComputeDelta(
    options.domain,
    options.cycleIndex,
    options.asOfDate,
    options.priorState,
    options.currentState
  );

  const validator = new Validator();
  const validation = validator.Validate(
    options.domain,
    options.currentState,
    options.factors ?? []
  );

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

