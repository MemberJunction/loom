import { createRng, type RngStream } from '../math/rng.js';

export interface NestedEventOptions<TParent, TChild> {
  seed: number;
  parents: readonly TParent[];
  streamKey: (parent: TParent) => string;
  countOf: (rng: RngStream, parent: TParent) => number;
  parentWindow: (parent: TParent) => { start: string; end: string };
  spawnChild: (
    rng: RngStream,
    parent: TParent,
    childIndex: number,
    childDate: string
  ) => TChild;
}

/**
 * Pattern A: nestedEvent
 * Generates discrete child events whose temporal occurrences are strictly bounded
 * within a parent event's duration: T_parent.start <= T_child.date <= T_parent.end.
 */
export function nestedEvent<TParent, TChild>(
  opts: NestedEventOptions<TParent, TChild>
): TChild[] {
  const children: TChild[] = [];

  for (const parent of opts.parents) {
    const rng = createRng(opts.seed, opts.streamKey(parent));
    const count = opts.countOf(rng, parent);
    if (count <= 0) continue;

    const window = opts.parentWindow(parent);
    const startDate = new Date(window.start);
    const endDate = new Date(window.end);
    const startTime = startDate.getTime();
    const endTime = endDate.getTime();
    const duration = Math.max(0, endTime - startTime);

    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : i / (count - 1);
      const childTime = startTime + Math.floor(duration * frac);
      const childDate = new Date(childTime).toISOString().slice(0, 10);
      children.push(opts.spawnChild(rng, parent, i, childDate));
    }
  }

  return children;
}
