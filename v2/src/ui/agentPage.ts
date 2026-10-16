import {
  downsample, lapProgression, summarize, type ActivityLog, type ActivityRecord, type AgentRole,
} from '../records/activity';
import type { Occupancy } from '../records/occupancy';
import type { Roster } from './roster';

/**
 * An agent's history page: who they are and where they are now, career
 * totals, best lap on each track as they learned, recent races and a timeline
 * of everything they've done. Everything below the header comes from the
 * activity log.
 */
export interface AgentPageDeps {
  roster: () => Roster;
  occupancy: Occupancy;
  log: ActivityLog;
}

const ROLE_LABEL: Record<AgentRole, string> = { driver: 'Driver', spotter: 'Spotter', chief: 'Crew chief' };
/** Categorical slots, dark steps (validated on the panel surface): one per track chart. */
const SERIES = ['#3987e5', '#d95926', '#199e70'];
const MAX_TRACK_CHARTS = 3;

export class AgentPage {
  private readonly host: HTMLElement;
  private current: { id: string; role: AgentRole } | null = null;

  constructor(private readonly deps: AgentPageDeps) {
    this.host = document.getElementById('agentPage')!;
    this.host.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-close]')) this.close();
      const link = t.closest<HTMLElement>('[data-agent]');
      if (link) void this.open(link.dataset.agent!, link.dataset.role as AgentRole);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  close(): void {
    this.current = null;
    this.host.hidden = true;
  }

  /** Show an agent's page (re-renders if already open on them). */
  async open(id: string, role: AgentRole): Promise<void> {
    this.current = { id, role };
    this.host.hidden = false;
    const records = await this.deps.log.forAgent(id);
    if (this.current?.id !== id) return; // another page was opened meanwhile
    this.host.innerHTML = this.render(id, role, records);
    this.wireCharts();
  }

  /** Refresh the open page (new records arrived). */
  refresh(): void {
    if (this.current) void this.open(this.current.id, this.current.role);
  }

  private render(id: string, role: AgentRole, records: ActivityRecord[]): string {
    const roster = this.deps.roster();
    const agent = role === 'driver' ? roster.drivers.get(id) : role === 'spotter' ? roster.spotters.get(id) : roster.chiefs.get(id);
    if (!agent) return `<div class="ap-head"><button data-close>✕</button><h1>Unknown agent</h1></div>`;
    const team = roster.teamOf(role, id);
    const where = this.deps.occupancy.of(id);
    const s = summarize(records);
    const mentorName = 'mentor' in agent ? agent.mentor : null;
    const all = [...roster.drivers.values(), ...roster.chiefs.values()];
    const mentor = mentorName ? all.find((a) => a.name === mentorName) : undefined;
    const protégés = all.filter((a) => 'mentor' in a && a.mentor === agent.name);
    const link = (a: { id: string; name: string }) => {
      const r: AgentRole = roster.drivers.has(a.id) ? 'driver' : roster.chiefs.has(a.id) ? 'chief' : 'spotter';
      return `<a data-agent="${a.id}" data-role="${r}">${esc(a.name)}</a>`;
    };

    const facts: string[] = [
      team ? `<span class="dot" style="background:${team.livery.fill};border-color:${team.livery.border}"></span>#${team.livery.number}` : 'Academy (no seat)',
      where ? `<b>${esc(where.label)}</b>` : 'Available',
    ];
    if (role === 'driver') {
      const d = roster.drivers.get(id)!;
      if (d.careerOver) facts.push(`<b>Career over</b>: a crash at ${esc(d.careerOver.track)} in season ${d.careerOver.season}`);
      else if (d.injury) facts.push(`<b>Injured</b> (${d.injury.severity}): back in ${d.injury.racesLeft} race${d.injury.racesLeft === 1 ? '' : 's'}`);
      facts.push(d.licensed ? `licensed${s.licensedAfter !== null ? ` after ${s.licensedAfter} lessons` : ''}` : 'in driving school');
      const nerve = d.nerve ?? 0.5;
      facts.push(`nerve ${(nerve * 100).toFixed(0)}: ${nerve < 0.3 ? 'cautious, keeps out of trouble' : nerve < 0.7 ? 'takes a gap when there is one' : 'fearless, goes for gaps that might not be there'}`);
      facts.push(d.pitLicensed && d.pitTrafficLicensed ? 'does their own pit stops' : 'pit stops: the veteran maneuver');
      facts.push(d.cautionLicensed ? 'drives their own cautions' : 'cautions: the formation script');
      facts.push(`${d.rounds} training rounds`);
    } else if (role === 'chief') {
      const c = roster.chiefs.get(id)!;
      facts.push(c.brain.kind === 'neural' ? `learned strategy, ${c.rounds} rounds` : 'scripted veteran');
    } else {
      const sp = roster.spotters.get(id)!;
      facts.push(`calls traffic ${Math.round(sp.skill.aheadRange)} m ahead, wrecks ${Math.round(sp.skill.hazardRange)} m`);
    }
    if (mentor) facts.push(`trained by ${link(mentor)}`);
    else if (mentorName) facts.push(`trained by ${esc(mentorName)}`);

    const tile = (label: string, value: string) => `<div class="ap-tile"><div class="v">${value}</div><div class="l">${label}</div></div>`;
    const tiles = [
      tile('starts', String(s.races.starts)),
      tile('wins', String(s.races.wins)),
      tile('top 5', String(s.races.top5)),
      tile('DNFs', String(s.races.dnfs)),
      tile('avg finish', s.races.avgFinish === null ? '–' : s.races.avgFinish.toFixed(1)),
      tile('titles', String(s.titles)),
      role === 'chief' ? tile('strategy rounds', String(s.strategy.rounds)) : tile('practice rounds', String(s.practice.rounds)),
      role === 'driver' ? tile('learned racing', String(s.raceLearning)) : '',
    ].join('');

    // Best lap as the agent learned, one small chart per track (tracks differ in scale), most-driven first.
    const tracks = Object.keys(s.bestLaps)
      .map((t) => ({ t, n: lapProgression(records, t).length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, MAX_TRACK_CHARTS)
      .map((x) => x.t);
    const charts = tracks.map((t, i) => lapChart(t, downsample(lapProgression(records, t), 160), SERIES[i], s.bestLaps[t].time)).join('');

    const races = records.filter((r): r is Extract<ActivityRecord, { kind: 'race' }> => r.kind === 'race').slice(-12).reverse();
    const raceRows = races.map((r) => {
      const d = r.data;
      return `<tr><td>${ago(r.time)}</td><td>${esc(r.event?.label ?? d.track)}</td><td>${d.position}/${d.starters}</td>`
        + `<td>${d.status === 'out' ? 'DNF' : `${d.laps} laps`}</td><td>${lap(d.bestLap)}</td><td>${d.stops}</td><td>${d.points ?? ''}</td></tr>`;
    }).join('');

    const timeline = records.slice(-40).reverse().map((r) => `<div><span class="when">${ago(r.time)}</span>${describe(r)}</div>`).join('');

    return `
      <div class="ap-head">
        <button data-close title="Close (Esc)">✕</button>
        <div class="role">${ROLE_LABEL[role]}</div>
        <h1>${esc(agent.name)}</h1>
        <div class="facts">${facts.join(' · ')}</div>
      </div>
      <div class="ap-tiles">${tiles}</div>
      ${charts ? `<h2>Best lap as they learned <span class="muted">(line: personal best · dots: each round's best · x: training rounds)</span></h2><div class="ap-charts">${charts}</div>` : ''}
      ${raceRows ? `<h2>Recent races</h2><table class="ap-races"><thead><tr><th>When</th><th>Event</th><th>Pos</th><th>Result</th><th>Best</th><th>Stops</th><th>Pts</th></tr></thead><tbody>${raceRows}</tbody></table>` : ''}
      ${protégés.length ? `<h2>Protégés</h2><div class="facts">${protégés.map(link).join(' · ')}</div>` : ''}
      <h2>Activity</h2>
      <div class="ap-timeline">${timeline || '<div class="muted">No records yet. Records start from the first session after this version: earlier history wasn\'t kept.</div>'}</div>
      <div class="ap-tip" hidden></div>`;
  }

  /** Crosshair + tooltip on the lap charts. */
  private wireCharts(): void {
    const tip = this.host.querySelector<HTMLElement>('.ap-tip')!;
    this.host.querySelectorAll<SVGSVGElement>('svg.lapchart').forEach((svg) => {
      const pts = JSON.parse(svg.dataset.points!) as Array<[number, number, number, number]>; // [px, py, x, lap/best...]
      const hair = svg.querySelector<SVGLineElement>('.hair')!;
      const focus = svg.querySelector<SVGCircleElement>('.focus')!;
      svg.addEventListener('pointermove', (e) => {
        const box = svg.getBoundingClientRect();
        const vx = ((e.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
        let best = pts[0];
        for (const p of pts) if (Math.abs(p[0] - vx) < Math.abs(best[0] - vx)) best = p;
        hair.setAttribute('x1', String(best[0]));
        hair.setAttribute('x2', String(best[0]));
        hair.style.opacity = '1';
        focus.setAttribute('cx', String(best[0]));
        focus.setAttribute('cy', String(best[1]));
        focus.style.opacity = '1';
        tip.hidden = false;
        tip.innerHTML = `<b>${esc(svg.dataset.track!)}</b><br>round ${best[2]}<br>round best ${best[3].toFixed(2)} s`;
        const host = this.host.getBoundingClientRect();
        tip.style.left = `${e.clientX - host.left + this.host.scrollLeft + 14}px`;
        tip.style.top = `${e.clientY - host.top + this.host.scrollTop + 14}px`;
      });
      svg.addEventListener('pointerleave', () => {
        hair.style.opacity = '0';
        focus.style.opacity = '0';
        tip.hidden = true;
      });
    });
  }
}

/**
 * One track's learning curve: each round's best lap (faint dots) and the
 * running personal best (2 px line). Lower is better; the y-range is the
 * track's own, so every chart uses its full height.
 */
function lapChart(track: string, points: Array<{ x: number; lap: number; best: number }>, color: string, pb: number): string {
  const W = 300, H = 120, L = 34, R = 8, T = 8, B = 18;
  if (!points.length) return '';
  const xs = points.map((p) => p.x), laps = points.map((p) => p.lap);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
  // Clip the slow tail so a few awful early laps don't flatten the curve.
  const sorted = [...laps].sort((a, b) => a - b);
  const yLo = sorted[0], yHi = Math.max(sorted[Math.floor(sorted.length * 0.9)], yLo + 0.5);
  const px = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const py = (y: number) => T + ((Math.min(y, yHi) - yLo) / (yHi - yLo)) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.best).toFixed(1)}`).join('');
  const dots = points.map((p) => `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.lap).toFixed(1)}" r="1.6" fill="${color}" opacity="0.35"/>`).join('');
  const data = points.map((p) => [Number(px(p.x).toFixed(1)), Number(py(p.lap).toFixed(1)), p.x, p.lap]);
  const last = points[points.length - 1];
  return `<figure class="ap-chart">
    <figcaption><span class="chip" style="background:${color}"></span>${esc(track)} <span class="muted">best ${pb.toFixed(2)} s</span></figcaption>
    <svg class="lapchart" viewBox="0 0 ${W} ${H}" data-track="${esc(track)}" data-points='${JSON.stringify(data)}' role="img"
      aria-label="${esc(track)}: best lap improved from ${points[0].lap.toFixed(2)} s to ${pb.toFixed(2)} s over ${points.length} rounds">
      <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>
      <text x="${L - 4}" y="${py(yLo) + 3}" class="tick" text-anchor="end">${yLo.toFixed(1)}</text>
      <text x="${L - 4}" y="${py(yHi) + 3}" class="tick" text-anchor="end">${yHi.toFixed(1)}</text>
      <text x="${L}" y="${H - 4}" class="tick">${x0}</text>
      <text x="${W - R}" y="${H - 4}" class="tick" text-anchor="end">${last.x}</text>
      ${dots}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="hair" y1="${T}" y2="${H - B}" style="opacity:0"/>
      <circle class="focus" r="4" fill="${color}" stroke="#141417" stroke-width="2" style="opacity:0"/>
    </svg>
  </figure>`;
}

function describe(r: ActivityRecord): string {
  const ev = r.event ? ` <span class="muted">· ${esc(r.event.label)}</span>` : '';
  switch (r.kind) {
    case 'joined': {
      const how = { rookie: 'Joined as a raw rookie', descendant: 'Joined, trained in', protege: 'Joined as a protégé of', recruit: 'Joined' }[r.data.origin];
      return `${how}${r.data.mentor && r.data.origin !== 'rookie' ? ` ${esc(r.data.mentor)}${r.data.origin === 'descendant' ? '\'s style' : ''}` : ''}`;
    }
    case 'seat': return `${r.data.action === 'signed' ? 'Signed with' : 'Left'} #${r.data.car}${r.data.action === 'released' ? ' (to the academy)' : ''}`;
    case 'practice': {
      const laps = r.data.tracks.map((t, i) => `${t} ${lap(r.data.bestLaps[i])}`).join(', ');
      return `${r.data.rookie ? 'Rookie school' : 'Practice'} round ${r.brain ?? ''}: ${laps}${r.data.rookie ? `, walls ×${r.data.walls.toFixed(2)}` : ''}${ev}`;
    }
    case 'lesson': {
      const d = r.data;
      const name = d.lesson === 'rookie' ? 'Rookie school' : d.lesson === 'variety' ? 'Track variety' : d.lesson === 'circuits' ? 'Road courses' : d.lesson === 'racecraft' ? 'Racecraft' : d.lesson === 'pits' ? 'Pit stops' : d.lesson === 'pitTraffic' ? 'Pit road in traffic' : d.lesson === 'cautions' ? 'Cautions' : d.lesson;
      return `${name} round ${r.brain ?? ''} at ${esc(d.track)}: ${d.laps} laps, best ${lap(d.bestLap)}, `
        + `${d.beaten} of ${d.variations} variations did better${d.walls < 1 ? `, walls ×${d.walls.toFixed(2)}` : ''}`;
    }
    case 'learning': return `Learned while racing at ${esc(r.data.track)} (step ${r.data.step} this race)${ev}`;
    case 'licensed': return r.data.license === 'pit'
      ? `<b>Passed the pit stop lesson</b>: next, pit road in traffic`
      : r.data.license === 'pitTraffic'
        ? `<b>Passed pit road in traffic</b>: does their own stops in races from now on`
      : r.data.license === 'caution'
        ? `<b>Passed the caution lesson</b>: drives their own cautions and restarts from now on`
        : `<b>Earned a license</b> after ${r.data.lessons} lessons`;
    case 'strategy': return `Strategy race: ${((r.data.relativeTime - 1) * 100).toFixed(1)}% off the best${ev}`;
    case 'race': {
      const d = r.data;
      const outcome = d.disqualified ? ' (black flag)' : d.status === 'out' ? ' (DNF)' : '';
      const penalties = d.penalties?.length ? `; penalties: ${d.penalties.map(esc).join(', ')}` : '';
      return `${d.position === 1 ? '<b>Won</b>' : `P${d.position} of ${d.starters}`} at ${esc(d.track)}${outcome}, best ${lap(d.bestLap)}${d.points ? `, ${d.points} pts` : ''}${penalties}${ev}`;
    }
    case 'season': return `${r.data.champion ? '<b>Champion</b>' : `P${r.data.position}`} in season ${r.data.season} (${r.data.points} pts)`;
    case 'injury': {
      const d = r.data;
      const hit = `a ${Math.round(d.speed * 3.6)} km/h hit at ${esc(d.track)}`;
      return d.severity === 'career'
        ? `<b>Career over</b> after ${hit}`
        : `<b>Injured</b> (${d.severity}) in ${hit}: out for ${d.races} race${d.races === 1 ? '' : 's'}`;
    }
    case 'recovered': return 'Recovered from injury: fit to race again';
  }
}

const lap = (t: number | null) => (t === null || !Number.isFinite(t) ? '–' : `${t.toFixed(2)} s`);

function ago(time: number): string {
  const s = (Date.now() - time) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(time).toLocaleDateString();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
