export interface ActiveRoleAssignment<TActor, TRoleAssignment> {
  actor: TActor;
  roleAssignment: TRoleAssignment;
}

export interface TemporalRoleOptions<TActor, TRoleAssignment> {
  actors: readonly TActor[];
  roleAssignments: readonly TRoleAssignment[];
  actorIdOf: (actor: TActor) => string;
  assignmentActorIdOf: (assignment: TRoleAssignment) => string;
  assignmentWindowOf: (assignment: TRoleAssignment) => { start: string; end?: string | null };
  scopeOf?: (assignment: TRoleAssignment) => string | undefined;
}

/**
 * Pattern B: temporalRole
 * Manages actor pools where eligibility at timestamp T requires an active role assignment:
 * Role.StartDate <= T <= Role.EndDate.
 */
export class TemporalRolePool<TActor, TRoleAssignment> {
  constructor(private opts: TemporalRoleOptions<TActor, TRoleAssignment>) {}

  public getActiveActors(dateStr: string, scope?: string): ActiveRoleAssignment<TActor, TRoleAssignment>[] {
    const date = dateStr.slice(0, 10);
    const actorMap = new Map<string, TActor>();
    for (const a of this.opts.actors) {
      actorMap.set(this.opts.actorIdOf(a).toLowerCase(), a);
    }

    const active: ActiveRoleAssignment<TActor, TRoleAssignment>[] = [];
    for (const assignment of this.opts.roleAssignments) {
      if (scope !== undefined && this.opts.scopeOf) {
        const assignmentScope = this.opts.scopeOf(assignment);
        if (assignmentScope !== undefined && assignmentScope.toLowerCase() !== scope.toLowerCase()) {
          continue;
        }
      }
      const win = this.opts.assignmentWindowOf(assignment);
      const start = win.start.slice(0, 10);
      const end = win.end ? win.end.slice(0, 10) : '\uffff';
      if (date >= start && date <= end) {
        const actorId = this.opts.assignmentActorIdOf(assignment).toLowerCase();
        const actor = actorMap.get(actorId);
        if (actor) {
          active.push({ actor, roleAssignment: assignment });
        }
      }
    }
    return active;
  }
}

export function temporalRole<TActor, TRoleAssignment>(
  opts: TemporalRoleOptions<TActor, TRoleAssignment>
): TemporalRolePool<TActor, TRoleAssignment> {
  return new TemporalRolePool(opts);
}

