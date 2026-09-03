/**
 * Sigmoid and logistic calibration utilities.
 */

/** Standard logistic sigmoid function */
export function sigmoid(x: number): number {
  if (x >= 40) return 1;
  if (x <= -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

/** Standard logit (inverse sigmoid) function */
export function logit(p: number): number {
  if (p <= 0) return -40;
  if (p >= 1) return 40;
  return Math.log(p / (1 - p));
}

/**
 * Numerically solves for the intercept beta0 such that:
 *   mean(sigmoid(beta0 + scores[i])) === target
 *
 * Uses Newton-Raphson with bisection fallback.
 * Strictly verifies convergence before returning.
 */
export function calibrateIntercept(
  scores: readonly number[],
  target: number,
  tolerance = 1e-6,
  maxIterations = 50
): number {
  if (scores.length === 0) return logit(target);
  if (target <= 0) return -40;
  if (target >= 1) return 40;

  const n = scores.length;
  // Initial estimate: logit(target) minus average score
  const avgScore = scores.reduce((a, b) => a + b, 0) / n;
  let b0 = logit(target) - avgScore;

  let low = -40;
  let high = 40;

  for (let iter = 0; iter < maxIterations; iter++) {
    let sumVal = 0;
    let sumDeriv = 0;

    for (let i = 0; i < n; i++) {
      const s = scores[i] ?? 0;
      const sig = sigmoid(b0 + s);
      sumVal += sig;
      sumDeriv += sig * (1 - sig);
    }

    const currentMean = sumVal / n;
    const diff = currentMean - target;

    if (Math.abs(diff) < tolerance) {
      return b0;
    }

    // Bracket adjustment for bisection fallback
    if (diff < 0) {
      low = Math.max(low, b0);
    } else {
      high = Math.min(high, b0);
    }

    const derivMean = sumDeriv / n;
    let nextB0: number;

    if (derivMean > 1e-12) {
      nextB0 = b0 - diff / derivMean;
    } else {
      nextB0 = (low + high) / 2;
    }

    // If Newton step went out of bounds, use bisection
    if (nextB0 <= low || nextB0 >= high) {
      nextB0 = (low + high) / 2;
    }

    b0 = nextB0;
  }

  // Verify final convergence
  let finalSum = 0;
  for (let i = 0; i < n; i++) {
    finalSum += sigmoid(b0 + (scores[i] ?? 0));
  }
  const finalDiff = Math.abs(finalSum / n - target);
  if (finalDiff > tolerance * 50) {
    throw new Error(
      `calibrateIntercept: failed to achieve target convergence within ${maxIterations} iterations (target: ${target}, achieved: ${(finalSum / n).toFixed(6)}, diff: ${finalDiff.toFixed(6)})`
    );
  }

  return b0;
}
