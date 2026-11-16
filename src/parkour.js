// Carrera de Neón: recorrido de parkour, física de saltos y plataformas, y bots corredores.
// La física (stepRunner) es compartida: la usa el anfitrión y la predicción de cada invitado.
import { DIFFICULTY, EMOTES } from './config.js';
import { F } from './sim.js';

// ---------- Recorrido ----------
// El recorrido avanza hacia z negativa (W = adelante). y es la altura de la cara de arriba.
// type: static | move | fall | bounce | cp (punto de control) | finish
const PLATS = [], LASERS = [], PATH = [];
function plat(x, y, z, w, d, type = 'static', extra = {}) {
  PLATS.push({ x, y, z, w, d, th: extra.th || 0.8, type, ...extra });
  return PLATS.length - 1;
}
// waypoint de los bots: plataforma (y opcionalmente un punto concreto encima)
const way = (i, x, z) => PATH.push({ i, x, z });

way(plat(0, 0, 0, 18, 12, 'cp', { cp: 0 }), 0, -4);
// 1. saltos sencillos
way(plat(0, 0.5, -10, 4, 4));
way(plat(-3, 1, -16, 4, 4));
way(plat(2, 1.5, -22.5, 4, 4));
way(plat(0, 1.5, -30, 5, 5));
way(plat(0, 1.5, -38, 10, 6, 'cp', { cp: 1 }));
// 2. plataformas que se mueven de lado
way(plat(0, 1.5, -46, 4, 4, 'move', { ax: 'x', amp: 5, per: 3, ph: 0 }));
way(plat(0, 1.5, -53, 4, 4, 'move', { ax: 'x', amp: 5, per: 3, ph: Math.PI }));
way(plat(0, 1.5, -60, 4, 4, 'move', { ax: 'x', amp: 4, per: 2.5, ph: Math.PI / 2 }));
way(plat(0, 1.5, -68, 8, 6));
// 3. suelo que se cae al pisarlo (4 filas de 4 baldosas)
const tileRows = [];
for (let r = 0; r < 4; r++) {
  const row = [];
  for (let c = 0; c < 4; c++) row.push(plat(-4.5 + c * 3, 1.5, -74 - r * 3, 2.6, 2.6, 'fall'));
  tileRows.push(row);
}
tileRows.forEach((row, r) => way(row[r % 2 ? 2 : 1]));
way(plat(0, 1.5, -90.5, 12, 7, 'cp', { cp: 2 }));
// 4. barras láser giratorias sobre una plataforma ancha
const wide = plat(0, 1.5, -104, 12, 16);
way(wide, 0, -98); way(wide, 0, -104); way(wide, 0, -110);
LASERS.push({ x: 0, y: 1.5, z: -100, len: 6.5, w: 1.6, ph: 0, h0: 0.25, h1: 1.1 });
LASERS.push({ x: 0, y: 1.5, z: -108, len: 6.5, w: -2.0, ph: 1, h0: 0.25, h1: 1.1 });
// 5. trampolines hacia arriba
way(plat(0, 1.5, -118, 4, 4, 'bounce'));
way(plat(0, 5.5, -125, 6, 5));
way(plat(0, 5.5, -131, 4, 4, 'bounce'));
way(plat(3, 9.5, -138, 5, 5));
way(plat(0, 9.5, -147, 10, 6, 'cp', { cp: 3 }));
// 6. vigas estrechas y ascensor hasta la meta
way(plat(0, 9.5, -155, 1.2, 6));
const beam = plat(-3, 9.5, -160, 6, 1.2);
way(beam, -0.5, -160); way(beam, -4.6, -160);
way(plat(-4.4, 9.5, -166, 1.2, 6));
const lift = plat(-4.4, 9.5, -174, 4, 4, 'move', { ax: 'y', amp: 3, per: 4, ph: 0 });
way(lift);
way(plat(0, 12, -183, 12, 10, 'finish'));

export const COURSE = { plats: PLATS, lasers: LASERS, path: PATH, cpCount: 4, finish: PLATS.length - 1 };
export const CHECKPOINTS = PLATS.map((p, i) => [i, p]).filter(([, p]) => p.type === 'cp').sort((a, b) => a[1].cp - b[1].cp).map(([i]) => i);

// Posición de una plataforma en el instante T (las móviles oscilan)
export function platPos(p, T) {
  if (p.type !== 'move') return { x: p.x, y: p.y, z: p.z };
  const o = Math.sin((T / p.per) * Math.PI * 2 + p.ph) * p.amp;
  return { x: p.x + (p.ax === 'x' ? o : 0), y: p.y + (p.ax === 'y' ? o : 0), z: p.z + (p.ax === 'z' ? o : 0) };
}
// Altura extra de una baldosa que se cae (tiles: Map índice -> {st, t})
export function tileDrop(i, tiles) {
  const t = tiles && tiles.get(i);
  if (!t) return 0;
  if (t.st === 1) return Math.sin(t.t * 60) * 0.05; // tiembla
  if (t.st === 2) return -t.t * t.t * 9;
  return 0;
}
export function laserAngle(l, T) { return l.w * T + l.ph; }

const SPEED = 8.5, JUMP = 11, GRAV = 28, BOUNCE = 17, R = 0.45, HGT = 1.7;

export function newRunner(x, y, z) {
  return { x, y, z, vx: 0, vz: 0, vy: 0, kx: 0, kz: 0, onG: true, stand: 0, coyote: 0, dashT: 0, dashX: 0, dashZ: 0, dashUsed: false, dashCd: 0, jumpHeld: false, aim: Math.PI };
}

// Un paso de física. inp = { mx, mz, j (Espacio pulsado), d (impulso) }; env = { T, tiles }
export function stepRunner(p, inp, dt, env) {
  const ev = {}, plats = COURSE.plats, T = env.T;
  // las plataformas móviles arrastran a quien está encima
  if (p.onG && p.stand >= 0 && plats[p.stand].type === 'move') {
    const a = platPos(plats[p.stand], T - dt), b = platPos(plats[p.stand], T);
    p.x += b.x - a.x; p.y += b.y - a.y; p.z += b.z - a.z;
  }
  const mx = inp.mx || 0, mz = inp.mz || 0;
  const wantJump = inp.j && !p.jumpHeld; p.jumpHeld = !!inp.j;
  p.dashCd -= dt;
  if (inp.d) {
    inp.d = false;
    if (!p.dashUsed && p.dashCd <= 0) {
      let dx = mx, dz = mz;
      if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(p.aim); dz = Math.cos(p.aim); }
      const l = Math.hypot(dx, dz); p.dashX = dx / l; p.dashZ = dz / l;
      p.dashT = 0.16; p.dashCd = 0.7; if (!p.onG) { p.dashUsed = true; p.vy = Math.max(p.vy, 1.5); }
      ev.dash = true;
    }
  }
  if (p.dashT > 0) { p.dashT -= dt; p.vx = p.dashX * 21; p.vz = p.dashZ * 21; }
  else if (p.onG) { p.vx = mx * SPEED; p.vz = mz * SPEED; }
  else { const k = Math.min(1, 5 * dt); p.vx += (mx * SPEED - p.vx) * k; p.vz += (mz * SPEED - p.vz) * k; }
  p.coyote = p.onG ? 0.1 : p.coyote - dt;
  if (wantJump && (p.onG || p.coyote > 0)) { p.vy = JUMP; p.onG = false; p.coyote = 0; ev.jump = true; }
  p.kx *= Math.exp(-3.5 * dt); p.kz *= Math.exp(-3.5 * dt);
  p.vy = Math.max(-32, p.vy - GRAV * dt);

  // cajas de las plataformas en este instante
  const boxes = plats.map((pl, i) => {
    const c = platPos(pl, T), top = c.y + tileDrop(i, env.tiles);
    return { i, pl, x: c.x, z: c.z, top, bot: top - pl.th, hw: pl.w / 2, hd: pl.d / 2, off: pl.type === 'fall' && top < pl.y - 0.4 };
  });
  // horizontal y choques laterales
  p.x += (p.vx + p.kx) * dt; p.z += (p.vz + p.kz) * dt;
  for (const b of boxes) {
    if (b.off || !(p.y < b.top - 0.15 && p.y + HGT > b.bot)) continue;
    const cx = Math.max(b.x - b.hw, Math.min(p.x, b.x + b.hw)), cz = Math.max(b.z - b.hd, Math.min(p.z, b.z + b.hd));
    const ox = p.x - cx, oz = p.z - cz, d2 = ox * ox + oz * oz;
    if (d2 < R * R && d2 > 1e-9) { const d = Math.sqrt(d2); p.x += ox / d * (R - d); p.z += oz / d * (R - d); }
  }
  // vertical: aterrizar, rebotar o darse con la cabeza
  const prevY = p.y; p.y += p.vy * dt;
  let land = null;
  if (p.vy <= 0) {
    for (const b of boxes) {
      if (b.off || Math.abs(p.x - b.x) > b.hw + 0.25 || Math.abs(p.z - b.z) > b.hd + 0.25) continue;
      if (prevY >= b.top - 0.3 && p.y <= b.top && (!land || b.top > land.top)) land = b;
    }
  }
  if (land) {
    p.y = land.top;
    if (land.pl.type === 'bounce') { p.vy = BOUNCE; p.onG = false; p.stand = -1; ev.bounce = true; }
    else { if (!p.onG) ev.land = true; p.vy = 0; p.onG = true; p.stand = land.i; p.dashUsed = false; }
  } else {
    p.onG = false; p.stand = -1;
    if (p.vy > 0) for (const b of boxes) {
      if (b.off || Math.abs(p.x - b.x) > b.hw || Math.abs(p.z - b.z) > b.hd) continue;
      if (prevY + HGT <= b.bot && p.y + HGT > b.bot) { p.y = b.bot - HGT; p.vy = 0; }
    }
  }
  // barras láser: empujan en el sentido en que giran
  for (const l of COURSE.lasers) {
    if (!(p.y < l.y + l.h1 && p.y + HGT > l.y + l.h0)) continue;
    const a = laserAngle(l, T), dx = Math.cos(a), dz = Math.sin(a);
    const rx = p.x - l.x, rz = p.z - l.z;
    const along = rx * dx + rz * dz;
    if (Math.abs(along) > l.len) continue;
    const perp = -rx * dz + rz * dx; // distancia con signo a la barra
    if (Math.abs(perp) < R + 0.25) {
      // empuje perpendicular a la barra, hacia donde avanza la barra
      const dirSign = Math.sign(l.w) * Math.sign(along || 1);
      p.kx = -dz * dirSign * 13; p.kz = dx * dirSign * 13;
      p.vy = Math.max(p.vy, 5.5); p.onG = false; p.stand = -1;
      ev.hit = true;
    }
  }
  if (Math.hypot(p.vx, p.vz) > 0.5 && p.dashT <= 0) p.aim = Math.atan2(p.vx, p.vz);
  return ev;
}

// ---------- Carrera ----------
export class ParkourGame {
  constructor({ difficulty = 'normal' } = {}) {
    this.mode = 'parkour'; this.teams = false; this.goal = 1; this.difficulty = difficulty;
    this.timeLimit = 300;
    this.players = new Map(); this.bullets = []; this.pickups = [];
    this.time = 0; this.state = 'playing';
    this.winner = null; this.winnerTeam = -1; this.score = [0, 0];
    this.onEvent = () => {};
    this.phase = 'freeze'; this.phaseT = 4;
    this.finishOrder = []; this.endT = null; this.raceT = 0; this.order = [];
    this.tiles = new Map();
  }

  spawnAt(p, cp) {
    const pl = COURSE.plats[CHECKPOINTS[cp]];
    const slot = [...this.players.keys()].indexOf(p.id) % 10;
    const x = pl.x + ((slot % 5) - 2) * Math.min(3, pl.w / 6), z = pl.z + (slot < 5 ? 1.5 : -1) * Math.min(1, pl.d / 6);
    Object.assign(p, newRunner(x, pl.y, z));
    p.stand = CHECKPOINTS[cp];
  }

  addPlayer(id, name, color, bot = false) {
    const p = {
      id, name, color, bot, team: 0, hp: 100, alive: true, kills: 0, deaths: 0,
      emote: 0, emoteT: 0, emoteN: 0, emoteCd: 0, cp: 0, fin: null, prog: 0, falls: 0,
      input: { mx: 0, mz: 0, j: false, d: false, em: 0, seq: 0 },
      ai: bot ? { w: 1, wait: 0, err: 0, stuck: 0 } : null,
    };
    this.players.set(id, p);
    this.spawnAt(p, 0);
    return p;
  }

  removePlayer(id) { this.players.delete(id); }

  setInput(id, inp) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    const m = Math.hypot(inp.mx || 0, inp.mz || 0);
    p.input.mx = m > 1 ? inp.mx / m : (+inp.mx || 0);
    p.input.mz = m > 1 ? inp.mz / m : (+inp.mz || 0);
    p.input.j = !!inp.j;
    if (inp.d) p.input.d = true;
    if (Number.isInteger(inp.em) && inp.em >= 1 && inp.em <= EMOTES.length) p.input.em = inp.em;
    if (Number.isInteger(inp.seq)) p.input.seq = inp.seq;
  }

  byPosition() {
    return [...this.players.values()].sort((a, b) =>
      (a.fin != null) !== (b.fin != null) ? (a.fin != null ? -1 : 1)
        : a.fin != null ? a.fin - b.fin : b.prog - a.prog);
  }

  step(dt) {
    if (this.state !== 'playing') return;
    this.time += dt;
    if (this.phase === 'freeze') {
      if ((this.phaseT -= dt) <= 0) { this.phase = 'live'; this.onEvent({ e: 'live' }); }
    } else this.raceT += dt;
    const live = this.phase === 'live';
    const env = { T: this.time, tiles: this.tiles };

    // baldosas que se caen
    for (const [i, t] of this.tiles) {
      if (t.st === 1 && (t.t -= dt) <= 0) { t.st = 2; t.t = 0; }
      else if (t.st === 2 && (t.t += dt) > 3) this.tiles.delete(i);
    }

    for (const p of this.players.values()) {
      if (p.bot && live) this.botRun(p, dt, env);
      const inp = live && p.fin == null ? p.input : { mx: 0, mz: 0, j: false, d: false };
      if (!live) { p.input.d = false; continue; }
      const ev = stepRunner(p, inp, dt, env);
      if (ev.hit) this.onEvent({ e: 'zap', id: p.id, x: p.x, z: p.z });
      if (ev.bounce) this.onEvent({ e: 'bounce', id: p.id });
      // emotes en el suelo y quieto
      p.emoteCd -= dt;
      const moving = Math.hypot(p.vx, p.vz) > 0.5 || !p.onG;
      if (p.emote && (moving || (p.emoteT -= dt) <= 0)) p.emote = 0;
      if (p.input.em) { if (!moving && p.emoteCd <= 0) { p.emote = p.input.em; p.emoteT = EMOTES[p.emote - 1].time || Infinity; p.emoteN++; p.emoteCd = 0.4; } p.input.em = 0; }
      // pisar una baldosa la hace caer
      if (p.onG && p.stand >= 0 && COURSE.plats[p.stand].type === 'fall' && !this.tiles.has(p.stand)) this.tiles.set(p.stand, { st: 1, t: 0.45 });
      // caída al vacío: al último punto de control
      if (p.y < -18) { p.falls++; this.spawnAt(p, p.cp); this.onEvent({ e: 'fall', id: p.id }); if (p.ai) p.ai.w = PATH.findIndex(w => w.i === CHECKPOINTS[p.cp]) + 1; continue; }
      if (p.onG) {
        p.prog = Math.max(p.prog, -p.z);
        const pl = COURSE.plats[p.stand];
        if (pl && pl.type === 'cp' && pl.cp > p.cp) { p.cp = pl.cp; this.onEvent({ e: 'checkpoint', id: p.id, cp: p.cp }); }
        if (p.stand === COURSE.finish && p.fin == null) {
          p.fin = +this.raceT.toFixed(2);
          this.finishOrder.push(p.id);
          this.onEvent({ e: 'finish', id: p.id, pos: this.finishOrder.length, time: p.fin });
          if (this.endT == null) this.endT = 30;
        }
      }
    }
    // empujones entre robots
    const ps = [...this.players.values()];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d > 0 && d < 0.9 && Math.abs(a.y - b.y) < 1.5) {
        const push = (0.9 - d) / 2; a.x -= dx / d * push; a.z -= dz / d * push; b.x += dx / d * push; b.z += dz / d * push;
      }
    }
    this.order = this.byPosition().map(p => p.id);
    if (this.endT != null) {
      this.endT -= dt;
      if (this.endT <= 0 || ps.every(p => p.fin != null)) this.finish();
    }
    if (this.time >= this.timeLimit) this.finish();
  }

  // ---------- Bots ----------
  botRun(p, dt, env) {
    const ai = p.ai, inp = p.input, sk = DIFFICULTY[this.difficulty] || DIFFICULTY.normal;
    if (ai.w >= PATH.length) { inp.mx = inp.mz = 0; return; }
    const wp = PATH[ai.w], pl = COURSE.plats[wp.i];
    const c = platPos(pl, env.T);
    const tx = wp.x != null ? wp.x + (c.x - pl.x) : c.x, tz = wp.z != null ? wp.z : c.z;
    // ¿ya está encima del destino? (en un trampolín basta con pasar por encima: nunca te deja quieto)
    const over = Math.abs(p.x - c.x) < pl.w / 2 && Math.abs(p.z - c.z) < pl.d / 2 && p.y >= c.y - 0.2;
    const reached = pl.type === 'bounce' ? over
      : p.onG && p.stand === wp.i && Math.hypot(p.x - tx, p.z - tz) < Math.max(1.2, Math.min(pl.w, pl.d) / 2 - 0.3);
    if (reached) {
      ai.w++; ai.err = (Math.random() - 0.5) * sk.aimError * 3; ai.stuck = 0; return;
    }
    ai.stuck += dt;
    let dx = tx - p.x + ai.err, dz = tz - p.z;
    const dist = Math.hypot(dx, dz) || 1;
    dx /= dist; dz /= dist;
    inp.j = false;
    if (p.onG) {
      const here = COURSE.plats[p.stand];
      const samePlat = p.stand === wp.i;
      if (!samePlat && here) {
        const hc = platPos(here, env.T);
        // esperar a que la plataforma móvil o el ascensor estén a tiro
        if (pl.type === 'move') {
          const dy = c.y - p.y;
          const near = pl.ax === 'y' ? (dy < 1.4 && dy > -2) : Math.abs((c.x - p.x)) < 2.5;
          if (!near && ai.stuck < 8) { inp.mx = inp.mz = 0; return; }
        }
        if (here.type === 'move' && here.ax === 'y' && c.y - p.y > 1.4) { inp.mx = inp.mz = 0; return; }
        // saltar al llegar al borde de la plataforma actual (o si el destino está más alto)
        const ax = p.x + dx * 0.9, az = p.z + dz * 0.9;
        const atEdge = Math.abs(ax - hc.x) > here.w / 2 || Math.abs(az - hc.z) > here.d / 2;
        if (atEdge || (c.y - p.y > 0.6 && dist < 4.5)) inp.j = Math.random() > (1 - sk.fireChance) * 0.05;
      }
      // saltar barras láser que se acercan
      for (const l of COURSE.lasers) {
        const a = laserAngle(l, env.T), rx = p.x - l.x, rz = p.z - l.z;
        if (Math.abs(rx * Math.cos(a) + rz * Math.sin(a)) < l.len && Math.abs(-rx * Math.sin(a) + rz * Math.cos(a)) < 1.6) inp.j = true;
      }
    } else if (p.vy < -2 && !p.dashUsed && Math.random() < sk.dash * 0.5) {
      // en el aire: impulso si se queda corto
      const short = Math.abs(p.x - c.x) > pl.w / 2 + 0.5 || Math.abs(p.z - c.z) > pl.d / 2 + 0.5;
      if (short && p.y > c.y - 0.5) inp.d = true;
    }
    inp.mx = dx; inp.mz = dz;
  }

  finish() {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.order = this.byPosition().map(p => p.id);
    this.winner = this.order[0] || null;
    this.onEvent({ e: 'end', winner: this.winner, winnerTeam: -1 });
  }

  ranking() {
    return this.byPosition().map(p => ({ id: p.id, name: p.name, color: p.color, kills: 0, deaths: p.falls, bot: p.bot, team: 0, time: p.fin, cp: p.cp }));
  }

  snapshot() {
    const r = n => Math.round(n * 100) / 100;
    const p = [];
    for (const q of this.players.values()) {
      let f = 0;
      if (Math.hypot(q.vx, q.vz) > 0.5) f |= F.MOVING;
      if (q.dashT > 0) f |= F.DASH;
      p.push([q.id, r(q.x), r(q.z), r(q.aim), 100, 1, f, 0, q.falls, q.input.seq, 0, 0, 0, 0, 0, q.emote, q.emoteN, 0, r(q.y),
        { g: q.onG ? 1 : 0, st: q.stand, vx: r(q.vx), vz: r(q.vz), vy: r(q.vy), kx: r(q.kx), kz: r(q.kz), cp: q.cp, fin: q.fin, du: q.dashUsed ? 1 : 0 }]);
    }
    return { t: 's', time: r(this.time), st: this.state, p, b: [], k: [], md: this.modeState() };
  }

  modeState() {
    const r = n => Math.round(n * 100) / 100;
    return {
      m: 'parkour', goal: 1, ph: this.phase, pt: r(Math.max(0, this.phaseT)), tl: this.timeLimit,
      rt: r(this.raceT), order: this.order, endT: this.endT == null ? -1 : r(Math.max(0, this.endT)),
      T: r(this.time), tiles: [...this.tiles].map(([i, t]) => [i, t.st, r(t.t)]),
    };
  }
}
