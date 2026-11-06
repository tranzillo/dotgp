import type { EventRef } from './activity';

/**
 * Who is busy where. An agent takes part in at most one running event at a
 * time: it can't be in a driving-school class and a race at once. Agents may
 * learn during any event; what this prevents is the same agent being in two.
 *
 * An event claims all its participants at once or none of them.
 */
export class Occupancy {
  private readonly busy = new Map<string, EventRef>();

  /** The event an agent is in, if any. */
  of(agent: string): EventRef | undefined {
    return this.busy.get(agent);
  }

  isFree(agent: string): boolean {
    return !this.busy.has(agent);
  }

  /** Agents (of these) already in some other event. */
  conflicts(event: EventRef, agents: string[]): Array<{ agent: string; event: EventRef }> {
    return agents.flatMap((agent) => {
      const e = this.busy.get(agent);
      return e && e.id !== event.id ? [{ agent, event: e }] : [];
    });
  }

  /** Enrol agents in an event, all or nothing. Returns the conflicts if any agent is busy elsewhere. */
  claim(event: EventRef, agents: string[]): Array<{ agent: string; event: EventRef }> {
    const conflicts = this.conflicts(event, agents);
    if (conflicts.length) return conflicts;
    for (const a of agents) this.busy.set(a, event);
    return [];
  }

  /** The event is over (or an agent left it): free its participants. */
  release(eventId: string, agents?: string[]): void {
    for (const [agent, e] of this.busy) {
      if (e.id === eventId && (!agents || agents.includes(agent))) this.busy.delete(agent);
    }
  }

  /** Agents in an event. */
  participants(eventId: string): string[] {
    return [...this.busy].filter(([, e]) => e.id === eventId).map(([a]) => a);
  }
}
