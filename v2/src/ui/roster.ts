import { adaptWeights } from '../ai/drivers';
import { initialWeights } from '../ai/es';
import { initialChiefWeights } from '../ai/neuralChief';
import { randomTraits, type CrewChiefTraits } from '../ai/pitting';
import type { Rng } from '../ai/rng';
import { PERFECT_SPOTTER, randomSpotterSkill, type SpotterSkill } from '../ai/spotter';
import { randomLivery, type Livery } from '../render/livery';

/**
 * The people behind the cars. Drivers, spotters and crew chiefs are separate
 * agents with their own identities; a team is a car (number + livery) with
 * one of each assigned, and any role can be reassigned or swapped.
 */
export type Role = 'driver' | 'spotter' | 'chief';

export interface DriverAgent {
  id: string;
  name: string;
  weights: Float32Array; // shared with the car's NeuralDriver, so practice updates apply live
  rounds: number;
  /** Name of the driver this one descended from. */
  mentor: string | null;
  /** Has passed rookie school (can complete clean laps). */
  licensed: boolean;
  /** Has passed the pit stop lesson: drives its own pit stops instead of the scripted maneuver. */
  pitLicensed?: boolean;
  /** Has passed the caution lesson: drives its own cautions and restarts instead of the formation script. */
  cautionLicensed?: boolean;
}

export interface SpotterAgent {
  id: string;
  name: string;
  skill: SpotterSkill;
}

export type ChiefBrain = { kind: 'neural'; weights: Float32Array } | { kind: 'scripted'; traits: CrewChiefTraits };

export interface ChiefAgent {
  id: string;
  name: string;
  rounds: number;
  mentor: string | null;
  brain: ChiefBrain;
}

export interface TeamEntry {
  id: number;
  livery: Livery;
  driver: string;
  spotter: string;
  chief: string;
}

/** Something that happened to the roster, for the activity log. */
export type RosterChange =
  | { type: 'joined'; role: Role; agent: string; name: string; origin: 'rookie' | 'descendant' | 'protege' | 'recruit'; mentor: string | null }
  | { type: 'seat'; role: Role; agent: string; action: 'signed' | 'released'; team: number; car: number };

/** How far a descendant's weights stray from its mentor's. */
const DESCENT_NOISE = { driver: 0.02, chief: 0.05 };

const FIRST = ['Ari', 'Bex', 'Cal', 'Dara', 'Eli', 'Fen', 'Gia', 'Hal', 'Ida', 'Jun', 'Kai', 'Lux', 'Mae', 'Nico', 'Oti',
  'Pax', 'Quin', 'Rae', 'Sol', 'Tam', 'Uma', 'Vic', 'Wren', 'Xan', 'Yara', 'Zed', 'Ines', 'Omar', 'Rin', 'Teo', 'Noor', 'Lev'];
const LAST = ['Achebe', 'Brandt', 'Castro', 'Dahl', 'Eze', 'Fujita', 'Garza', 'Holm', 'Ivanova', 'Jansen', 'Kaur', 'Lindqvist',
  'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quiroga', 'Rossi', 'Sato', 'Tan', 'Ueda', 'Varga', 'Walsh', 'Xu', 'Yilmaz',
  'Zhou', 'Mbeki', 'Novak', 'Ortiz', 'Park', 'Silva', 'Haddad'];

export class Roster {
  teams: TeamEntry[] = [];
  readonly drivers = new Map<string, DriverAgent>();
  readonly spotters = new Map<string, SpotterAgent>();
  readonly chiefs = new Map<string, ChiefAgent>();
  /** Trained crew chiefs that new teams' chiefs can descend from. */
  chiefTemplates: Float32Array[] = [];
  /** Told about every arrival and seat change (the activity log listens). */
  onChange: ((change: RosterChange) => void) | null = null;
  private counter = 0;

  constructor(private readonly rng: Rng) {}

  private random = () => this.rng.next();

  private uid(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private uniqueName(): string {
    const used = new Set([...this.drivers.values(), ...this.spotters.values(), ...this.chiefs.values()].map((a) => a.name));
    for (let tries = 0; tries < 200; tries++) {
      const name = `${FIRST[this.rng.int(FIRST.length)]} ${LAST[this.rng.int(LAST.length)]}`;
      if (!used.has(name)) return name;
    }
    return `Rookie ${this.counter + 1}`;
  }

  // ---------- creating agents ----------

  private joined(role: Role, agent: { id: string; name: string }, origin: 'rookie' | 'descendant' | 'protege' | 'recruit', mentor: string | null): void {
    this.onChange?.({ type: 'joined', role, agent: agent.id, name: agent.name, origin, mentor });
  }

  freshDriver(): DriverAgent {
    const d = { id: this.uid('D'), name: this.uniqueName(), weights: initialWeights(this.rng), rounds: 0, mentor: null, licensed: false };
    this.drivers.set(d.id, d);
    this.joined('driver', d, 'rookie', null);
    return d;
  }

  /** A rookie who inherits an experienced driver's driving, with slight variation. */
  descendantDriver(mentor: DriverAgent): DriverAgent {
    const weights = mentor.weights.slice();
    for (let i = 0; i < weights.length; i++) weights[i] += this.rng.gaussian() * DESCENT_NOISE.driver;
    // Inherits a working driving style, so no rookie school needed.
    const d = { id: this.uid('D'), name: this.uniqueName(), weights, rounds: 0, mentor: mentor.name, licensed: true };
    this.drivers.set(d.id, d);
    this.joined('driver', d, 'descendant', mentor.name);
    return d;
  }

  /**
   * A new driver for the academy (no seat): descended from a licensed driver
   * if there is one, otherwise a raw rookie for driving school.
   */
  recruitDriver(): DriverAgent {
    const experienced = [...this.drivers.values()].filter((d) => d.licensed);
    return experienced.length ? this.descendantDriver(experienced[this.rng.int(experienced.length)]) : this.freshDriver();
  }

  newSpotter(): SpotterAgent {
    const s = { id: this.uid('S'), name: this.uniqueName(), skill: randomSpotterSkill(this.random) };
    this.spotters.set(s.id, s);
    this.joined('spotter', s, 'recruit', null);
    return s;
  }

  /** New crew chiefs learn from a trained one if any exist; otherwise they work from instinct (scripted). */
  newChief(): ChiefAgent {
    const trained = [...this.chiefs.values()].filter((c) => c.brain.kind === 'neural' && c.rounds > 0);
    let brain: ChiefBrain;
    let mentor: string | null = null;
    if (trained.length || this.chiefTemplates.length) {
      const source = trained.length ? trained[this.rng.int(trained.length)] : null;
      const base = source && source.brain.kind === 'neural' ? source.brain.weights : this.chiefTemplates[this.rng.int(this.chiefTemplates.length)];
      const weights = base.slice();
      for (let i = 0; i < weights.length; i++) weights[i] += this.rng.gaussian() * DESCENT_NOISE.chief;
      brain = { kind: 'neural', weights };
      mentor = source?.name ?? null;
    } else {
      brain = { kind: 'scripted', traits: randomTraits(this.random) };
    }
    const c = { id: this.uid('C'), name: this.uniqueName(), rounds: 0, mentor, brain };
    this.chiefs.set(c.id, c);
    this.joined('chief', c, 'recruit', mentor);
    return c;
  }

  freshNeuralChiefWeights(): Float32Array {
    return initialChiefWeights(this.rng);
  }

  /** A new crew chief trained under a mentor: same approach, slightly different instincts. */
  protegeChief(mentor: ChiefAgent): ChiefAgent {
    let brain: ChiefBrain;
    if (mentor.brain.kind === 'neural') {
      const weights = mentor.brain.weights.slice();
      for (let i = 0; i < weights.length; i++) weights[i] += this.rng.gaussian() * DESCENT_NOISE.chief;
      brain = { kind: 'neural', weights };
    } else {
      const t = mentor.brain.traits;
      const j = (x: number, spread: number) => x * (1 + (this.rng.next() - 0.5) * spread);
      brain = { kind: 'scripted', traits: {
        fuelMarginLaps: j(t.fuelMarginLaps, 0.3), tireLimit: j(t.tireLimit, 0.2),
        repairBelow: j(t.repairBelow, 0.1), minLapsForTires: Math.round(j(t.minLapsForTires, 0.3)),
      } };
    }
    const c = { id: this.uid('C'), name: this.uniqueName(), rounds: 0, mentor: mentor.name, brain };
    this.chiefs.set(c.id, c);
    this.joined('chief', c, 'protege', mentor.name);
    return c;
  }

  /**
   * Give every scripted crew chief a learned brain descended from the trained
   * templates. Same person (name, team, career); only the strategy changes.
   * Returns how many were upgraded.
   */
  upgradeScriptedChiefs(): number {
    if (!this.chiefTemplates.length) return 0;
    let n = 0;
    for (const c of this.chiefs.values()) {
      if (c.brain.kind !== 'scripted') continue;
      const weights = this.chiefTemplates[this.rng.int(this.chiefTemplates.length)].slice();
      for (let i = 0; i < weights.length; i++) weights[i] += this.rng.gaussian() * DESCENT_NOISE.chief;
      c.brain = { kind: 'neural', weights };
      c.rounds = 0;
      n++;
    }
    return n;
  }

  /** A season of experience: the spotter calls things a little earlier. */
  seasonedSpotter(s: SpotterAgent, growth: number): void {
    const k = s.skill;
    k.aheadRange += (PERFECT_SPOTTER.aheadRange - k.aheadRange) * growth;
    k.behindRange += (PERFECT_SPOTTER.behindRange - k.behindRange) * growth;
    k.hazardRange += (PERFECT_SPOTTER.hazardRange - k.hazardRange) * growth;
  }

  pick<T>(items: T[]): T {
    return items[this.rng.int(items.length)];
  }

  // ---------- teams ----------

  /** Grow to n teams. New drivers descend from drivers who can already drive. */
  ensureTeams(n: number): void {
    while (this.teams.length < n) {
      const driver = this.recruitDriver();
      const team: TeamEntry = {
        id: this.teams.reduce((m, t) => Math.max(m, t.id), -1) + 1,
        livery: randomLivery(this.teams.map((t) => t.livery.number), this.random),
        driver: driver.id,
        spotter: this.newSpotter().id,
        chief: this.newChief().id,
      };
      this.teams.push(team);
      for (const role of ['driver', 'spotter', 'chief'] as const) this.seatChange(team, role, team[role], 'signed');
    }
  }

  /** The team an agent has a seat with, or null: in the academy (or between seats). */
  teamOf(role: Role, agentId: string): TeamEntry | null {
    return this.teams.find((t) => t[role] === agentId) ?? null;
  }

  private seatChange(team: TeamEntry, role: Role, agent: string, action: 'signed' | 'released'): void {
    this.onChange?.({ type: 'seat', role, agent, action, team: team.id, car: team.livery.number });
  }

  /** Give a team's seat to an agent; whoever had it goes to the academy. */
  seat(team: TeamEntry, role: Role, agentId: string): void {
    if (team[role] === agentId) return;
    this.seatChange(team, role, team[role], 'released');
    team[role] = agentId;
    this.seatChange(team, role, agentId, 'signed');
  }

  driverOf(t: TeamEntry): DriverAgent { return this.drivers.get(t.driver)!; }
  spotterOf(t: TeamEntry): SpotterAgent { return this.spotters.get(t.spotter)!; }
  chiefOf(t: TeamEntry): ChiefAgent { return this.chiefs.get(t.chief)!; }

  /** Put an agent in a team's seat; if another team had them, the two teams swap. */
  assign(team: TeamEntry, role: Role, agentId: string): void {
    const other = this.teams.find((t) => t !== team && t[role] === agentId);
    const previous = team[role];
    this.seat(team, role, agentId);
    if (other) {
      this.seatChange(other, role, agentId, 'released');
      other[role] = previous;
      this.seatChange(other, role, previous, 'signed');
    }
  }

  /** Replace every team's driver with a brand-new rookie who has never driven. */
  freshDriversForAll(): void {
    for (const t of this.teams) {
      const old = t.driver;
      this.seat(t, 'driver', this.freshDriver().id);
      this.drivers.delete(old);
    }
  }

  // ---------- persistence ----------

  toJSON(): unknown {
    return {
      version: 3,
      counter: this.counter,
      teams: this.teams,
      drivers: [...this.drivers.values()].map((d) => ({ ...d, weights: Array.from(d.weights) })),
      spotters: [...this.spotters.values()],
      chiefs: [...this.chiefs.values()].map((c) => ({
        ...c,
        brain: c.brain.kind === 'neural' ? { kind: 'neural', weights: Array.from(c.brain.weights) } : c.brain,
      })),
    };
  }

  /**
   * Load a saved roster. Also accepts the older formats (a list of drivers
   * with liveries, or bare training output), turning each into a team.
   */
  static load(data: unknown, rng: Rng, chiefTemplates: Float32Array[] = []): Roster | null {
    const r = new Roster(rng);
    r.chiefTemplates = chiefTemplates;
    const d = data as Record<string, unknown>;
    if (d && d.version === 3) {
      r.counter = Number(d.counter) || 0;
      for (const x of d.drivers as Array<DriverAgent & { weights: number[] }>) {
        r.drivers.set(x.id, {
          ...x, weights: adaptWeights(Float32Array.from(x.weights)), licensed: x.licensed ?? (x.rounds > 0 || x.mentor !== null),
        });
      }
      for (const x of d.spotters as SpotterAgent[]) r.spotters.set(x.id, x);
      for (const x of d.chiefs as Array<ChiefAgent & { brain: { kind: string; weights?: number[]; traits?: CrewChiefTraits } }>) {
        const brain: ChiefBrain = x.brain.kind === 'neural'
          ? { kind: 'neural', weights: Float32Array.from(x.brain.weights!) }
          : { kind: 'scripted', traits: x.brain.traits! };
        r.chiefs.set(x.id, { ...x, brain });
      }
      r.teams = d.teams as TeamEntry[];
      return r.teams.length ? r : null;
    }
    // Older formats: one team per listed driver.
    const list = (d?.drivers ?? d?.champions) as Array<{
      number?: number; fill?: string; border?: string; weights: number[]; rounds?: number; chief?: CrewChiefTraits;
    }> | undefined;
    if (!Array.isArray(list) || !list.length) return null;
    for (const x of list) {
      const driver: DriverAgent = {
        id: r.uid('D'), name: r.uniqueName(), weights: adaptWeights(Float32Array.from(x.weights)), rounds: x.rounds ?? 0, mentor: null,
        licensed: (x.rounds ?? 0) > 0,
      };
      r.drivers.set(driver.id, driver);
      const chief = x.chief
        ? { id: r.uid('C'), name: r.uniqueName(), rounds: 0, mentor: null, brain: { kind: 'scripted' as const, traits: x.chief } }
        : r.newChief();
      r.chiefs.set(chief.id, chief);
      r.teams.push({
        id: r.teams.length,
        livery: x.number && x.fill && x.border
          ? { number: x.number, fill: x.fill, border: x.border }
          : randomLivery(r.teams.map((t) => t.livery.number), r.random),
        driver: driver.id,
        spotter: r.newSpotter().id,
        chief: chief.id,
      });
    }
    return r;
  }
}
