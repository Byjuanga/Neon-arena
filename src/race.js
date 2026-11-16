// Neón Kart: circuito, física de los coches, objetos y bots conductores.
// La física (stepCar) es compartida: la usa el anfitrión y la predicción de cada invitado.
import { DIFFICULTY } from './config.js';
import { F } from './sim.js';

// ---------- Circuito ----------
// Puntos de control de la línea central (se suavizan con una curva Catmull-Rom)
const CTRL = [
  [-50, 70], [20, 70], [60, 65], [80, 40], [70, 10], [40, 0], [40, -25], [65, -45], [60, -75],
  [25, -85], [-10, -70], [-15, -40], [-45, -30], [-75, -50], [-90, -20], [-80, 20], [-75, 55],
];
export const TRACK_HW = 7;      // medio ancho de la pista
export const CAR_R = 1.3;       // radio de choque de un coche

function buildTrack() {
  const raw = [], n = CTRL.length;
  for (let i = 0; i < n; i++) {
    const p0 = CTRL[(i - 1 + n) % n], p1 = CTRL[i], p2 = CTRL[(i + 1) % n], p3 = CTRL[(i + 2) % n];
    const steps = Math.max(4, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      raw.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const N = raw.length, pts = [];
  let s = 0;
  for (let i = 0; i < N; i++) {
    const [x, z] = raw[i], [x2, z2] = raw[(i + 1) % N];
    const len = Math.hypot(x2 - x, z2 - z) || 1e-6;
    const tx = (x2 - x) / len, tz = (z2 - z) / len;
    pts.push({ x, z, tx, tz, nx: -tz, nz: tx, s, len });
    s += len;
  }
  const L = s;
  const at = f => f * L;
  return {
    pts, N, L,
    // placas de turbo (s, desplazamiento lateral), rampas y filas de cajas de objetos
    pads: [[at(0.13), 0], [at(0.37), -3], [at(0.6), 3], [at(0.86), 0]].map(([s0, lat]) => ({ s: s0, lat, len: 6, hw: 2.4 })),
    ramps: [at(0.24), at(0.71)].map(s0 => ({ s: s0, len: 4 })),
    boxes: [at(0.06), at(0.32), at(0.53), at(0.79)].flatMap(s0 => [-4.5, -1.5, 1.5, 4.5].map(lat => ({ s: s0, lat }))),
  };
}
export const TRACK = buildTrack();

// Punto de la pista a una distancia s del inicio (con desplazamiento lateral lat)
export function trackPoint(s, lat = 0) {
  const T = TRACK;
  s = ((s % T.L) + T.L) % T.L;
  let lo = 0, hi = T.N - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T.pts[m].s <= s) lo = m; else hi = m - 1; }
  const p = T.pts[lo], k = (s - p.s);
  return { x: p.x + p.tx * k + p.nx * lat, z: p.z + p.tz * k + p.nz * lat, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, i: lo };
}

// Segmento de la pista más cercano, buscando cerca del último conocido (hint)
export function nearestOnTrack(x, z, hint = -1) {
  const T = TRACK;
  let best = null, bd = Infinity;
  const check = i => {
    const p = T.pts[i];
    let k = (x - p.x) * p.tx + (z - p.z) * p.tz;
    k = Math.max(0, Math.min(p.len, k));
    const px = p.x + p.tx * k, pz = p.z + p.tz * k;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < bd) { bd = d; best = { i, s: p.s + k, lat: (x - px) * p.nx + (z - pz) * p.nz, nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz }; }
  };
  if (hint < 0) for (let i = 0; i < T.N; i++) check(i);
  else for (let o = -25; o <= 25; o++) check((hint + o + T.N) % T.N);
  return best;
}

const inRange = (s, s0, len) => { const d = ((s - s0) % TRACK.L + TRACK.L) % TRACK.L; return d <= len; };

// Controles a partir del movimiento: W/S acelerar o frenar, A/D girar
export function carControls(mx, mz) {
  return { thr: mz < -0.2 ? 1 : mz > 0.2 ? -1 : 0, steer: mx > 0.2 ? 1 : mx < -0.2 ? -1 : 0 };
}

export function newCar(s, lat) {
  const p = trackPoint(s, lat);
  return {
    x: p.x, z: p.z, h: Math.atan2(p.tx, p.tz), sp: 0, vx: 0, vz: 0, y: 0, vy: 0,
    boost: 0, spin: 0, drifting: false, driftDir: 0, driftT: 0,
    seg: p.i, s: ((s % TRACK.L) + TRACK.L) % TRACK.L, dist: s < 0 ? s : 0,
  };
}

// Un paso de física de un coche. ctl = { thr, steer, drift }. Devuelve avisos para efectos.
export function stepCar(c, ctl, dt) {
  const ev = {};
  let { thr, steer, drift } = ctl;
  if (c.spin > 0) { c.spin -= dt; thr = 0; steer = 0; drift = false; c.sp *= Math.exp(-3 * dt); }
  const air = c.y > 0.01;
  const boosting = c.boost > 0;
  if (boosting) c.boost -= dt;
  const vmax = boosting ? 40 : 27;
  if (!air) {
    if (boosting) c.sp = Math.min(40, Math.max(c.sp, 30) + 30 * dt);
    else if (thr > 0) c.sp = c.sp > vmax ? c.sp - (c.sp - vmax) * 2 * dt : Math.min(vmax, c.sp + 15 * dt);
    else if (thr < 0) c.sp = c.sp > 0 ? Math.max(0, c.sp - 38 * dt) : Math.max(-9, c.sp - 12 * dt);
    else c.sp *= Math.exp(-0.9 * dt);
  }
  // derrape: Espacio + girar a buena velocidad; al soltarlo da un mini-turbo
  if (!c.drifting && drift && Math.abs(steer) > 0.2 && c.sp > 12 && !air) { c.drifting = true; c.driftDir = Math.sign(steer); c.driftT = 0; }
  if (c.drifting && (!drift || c.sp < 8)) {
    if (c.driftT > 1.1) { c.boost = Math.max(c.boost, 1.3); ev.mini = 2; }
    else if (c.driftT > 0.55) { c.boost = Math.max(c.boost, 0.7); ev.mini = 1; }
    c.drifting = false; c.driftT = 0;
  }
  if (c.drifting) c.driftT += dt;
  // giro
  const sf = Math.min(1, Math.abs(c.sp) / 8) * (c.sp < 0 ? -1 : 1);
  let turn = c.drifting ? (c.driftDir * 1.4 + steer * 0.8) : steer * 1.9;
  if (air) turn *= 0.25;
  c.h -= turn * sf * dt; // h crece hacia la izquierda: girar a la derecha lo reduce
  // velocidad: con derrape el coche desliza (menos agarre)
  const fx = Math.sin(c.h) * c.sp, fz = Math.cos(c.h) * c.sp;
  const grip = c.drifting ? 2.3 : 9;
  c.vx += (fx - c.vx) * Math.min(1, grip * dt);
  c.vz += (fz - c.vz) * Math.min(1, grip * dt);
  c.x += c.vx * dt; c.z += c.vz * dt;
  // salto de las rampas (solo vertical)
  if (air || c.vy > 0) {
    c.y += c.vy * dt; c.vy -= 25 * dt;
    if (c.y <= 0) { c.y = 0; c.vy = 0; ev.land = true; }
  }
  // muros: la pista tiene un ancho fijo alrededor de la línea central
  const nr = nearestOnTrack(c.x, c.z, c.seg);
  const lim = TRACK_HW - CAR_R;
  if (Math.abs(nr.lat) > lim) {
    const out = nr.lat - Math.sign(nr.lat) * lim;
    c.x -= nr.nx * out; c.z -= nr.nz * out;
    const vn = c.vx * nr.nx + c.vz * nr.nz;
    if (vn * Math.sign(nr.lat) > 0) { c.vx -= nr.nx * vn * 1.4; c.vz -= nr.nz * vn * 1.4; ev.wall = true; }
    c.sp *= Math.exp(-1.5 * dt);
  }
  // distancia recorrida (sin cortar: siempre por segmentos cercanos)
  let ds = nr.s - c.s;
  if (ds > TRACK.L / 2) ds -= TRACK.L; else if (ds < -TRACK.L / 2) ds += TRACK.L;
  c.dist += ds; c.s = nr.s; c.seg = nr.i;
  // placas de turbo y rampas
  if (!air) {
    for (const p of TRACK.pads) if (inRange(c.s, p.s, p.len) && Math.abs(nr.lat - p.lat) < p.hw) { if (c.boost < 0.9) ev.pad = true; c.boost = Math.max(c.boost, 1.0); }
    for (const r of TRACK.ramps) if (inRange(c.s, r.s, r.len) && c.sp > 12 && c.vy <= 0) { c.vy = 7 + c.sp * 0.08; c.y = 0.02; ev.ramp = true; }
  }
  return ev;
}

// ---------- Objetos ----------
export const KART_ITEMS = {
  turbo:  { icon: '⚡', label: 'Turbo' },
  misil:  { icon: '🚀', label: 'Misil' },
  mina:   { icon: '💣', label: 'Mina' },
  escudo: { icon: '🛡️', label: 'Escudo' },
};

// ---------- Carrera ----------
export class KartGame {
  constructor({ goal = 3, difficulty = 'normal' } = {}) {
    this.mode = 'kart'; this.teams = false;
    this.goal = goal; this.difficulty = difficulty;
    this.timeLimit = 420;
    this.players = new Map();
    this.bullets = [];           // misiles
    this.pickups = [];
    this.mines = [];
    this.boxes = TRACK.boxes.map(b => ({ ...trackPoint(b.s, b.lat), active: true, t: 0 }));
    this.time = 0; this.state = 'playing';
    this.winner = null; this.winnerTeam = -1; this.score = [0, 0];
    this.nextBullet = 1; this.onEvent = () => {};
    this.phase = 'freeze'; this.phaseT = 4;
    this.finishOrder = []; this.endT = null; this.raceT = 0;
    this.order = [];
  }

  addPlayer(id, name, color, bot = false) {
    const slot = this.players.size;
    const row = Math.floor(slot / 2), col = slot % 2;
    const c = newCar(-6 - row * 6, col ? -3 : 3);
    Object.assign(c, {
      id, name, color, bot, team: 0, aim: c.h, hp: 100, alive: true, kills: 0, deaths: 0,
      emote: 0, emoteN: 0, item: null, shield: 0, fin: null, lap: 1, prevF: false,
      input: { mx: 0, mz: 0, f: false, j: false, u: false, seq: 0 },
      ai: bot ? { lane: (Math.random() - 0.5) * 6, laneT: 0, itemT: 1 + Math.random() * 2 } : null,
    });
    this.players.set(id, c);
    return c;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.bullets = this.bullets.filter(b => b.owner !== id);
  }

  setInput(id, inp) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    p.input.mx = +inp.mx || 0; p.input.mz = +inp.mz || 0;
    p.input.f = !!inp.f; p.input.j = !!inp.j; p.input.u = !!inp.u;
    if (inp.f || inp.u) p.input.tap = true; // se recuerda hasta el siguiente paso aunque llegue otro mensaje
    if (Number.isInteger(inp.seq)) p.input.seq = inp.seq;
  }

  carsByPosition() {
    return [...this.players.values()].sort((a, b) =>
      (a.fin != null) !== (b.fin != null) ? (a.fin != null ? -1 : 1)
        : a.fin != null ? a.fin - b.fin : b.dist - a.dist);
  }

  step(dt) {
    if (this.state !== 'playing') return;
    this.time += dt;
    if (this.phase === 'freeze') {
      if ((this.phaseT -= dt) <= 0) { this.phase = 'live'; this.onEvent({ e: 'live' }); }
    } else this.raceT += dt;
    const live = this.phase === 'live';
    this.order = this.carsByPosition().map(c => c.id);

    for (const c of this.players.values()) {
      if (c.bot) this.botDrive(c, dt);
      const inp = c.input;
      const ctl = c.bot ? { thr: inp.thr, steer: inp.steer, drift: inp.j } : { ...carControls(inp.mx, inp.mz), drift: inp.j };
      if (!live) { ctl.thr = 0; ctl.steer = 0; ctl.drift = false; }
      const ev = stepCar(c, ctl, dt);
      c.aim = c.h;
      if (ev.mini || ev.pad) this.onEvent({ e: 'boost', id: c.id });
      if (ev.ramp) this.onEvent({ e: 'ramp', id: c.id });
      if (c.shield > 0) c.shield -= dt;
      // usar objeto: clic o E (al pulsar)
      const use = inp.f || inp.u || inp.tap;
      inp.tap = false;
      if (use && !c.prevF && c.item && live) this.useItem(c);
      c.prevF = use;
      // vueltas
      const lap = Math.max(1, Math.min(this.goal, Math.floor(c.dist / TRACK.L) + 1));
      if (lap > c.lap && c.fin == null) { c.lap = lap; this.onEvent({ e: 'lap', id: c.id, lap }); }
      if (c.fin == null && c.dist >= this.goal * TRACK.L) {
        c.fin = +this.raceT.toFixed(2);
        this.finishOrder.push(c.id);
        this.onEvent({ e: 'finish', id: c.id, pos: this.finishOrder.length, time: c.fin });
        if (this.endT == null) this.endT = 25;
      }
    }

    // choques entre coches
    const cars = [...this.players.values()];
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d > 0 && d < CAR_R * 2 && Math.abs(a.y - b.y) < 1.5) {
        const push = (CAR_R * 2 - d) / 2, nx = dx / d, nz = dz / d;
        a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
        const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rel < 0) { a.vx += nx * rel * 0.5; a.vz += nz * rel * 0.5; b.vx -= nx * rel * 0.5; b.vz -= nz * rel * 0.5; }
      }
    }

    // cajas de objetos
    for (const bx of this.boxes) {
      if (!bx.active) { if ((bx.t -= dt) <= 0) bx.active = true; continue; }
      for (const c of cars) {
        if (Math.hypot(c.x - bx.x, c.z - bx.z) < 2 && c.y < 1.5) {
          bx.active = false; bx.t = 3;
          if (!c.item) { c.item = this.rollItem(c); this.onEvent({ e: 'item', id: c.id, item: c.item }); }
          break;
        }
      }
    }

    // misiles: persiguen al coche de delante
    this.bullets = this.bullets.filter(m => {
      m.life -= dt;
      const t = this.players.get(m.target);
      if (t) {
        const want = Math.atan2(t.x - m.x, t.z - m.z);
        let cur = Math.atan2(m.vx, m.vz), d = want - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        cur += Math.max(-4 * dt, Math.min(4 * dt, d));
        m.vx = Math.sin(cur) * 46; m.vz = Math.cos(cur) * 46;
      }
      m.x += m.vx * dt; m.z += m.vz * dt;
      for (const c of cars) {
        if (c.id === m.owner || Math.hypot(c.x - m.x, c.z - m.z) > 1.8) continue;
        this.hitCar(c, m.owner, m.x, m.z);
        return false;
      }
      return m.life > 0;
    });

    // minas
    this.mines = this.mines.filter(mn => {
      mn.arm -= dt; mn.life -= dt;
      for (const c of cars) {
        if ((c.id === mn.owner && mn.arm > 0) || Math.hypot(c.x - mn.x, c.z - mn.z) > 1.6 || c.y > 1) continue;
        this.hitCar(c, mn.owner, mn.x, mn.z);
        return false;
      }
      return mn.life > 0;
    });

    // fin: 25 s después del primero en llegar, o cuando lleguen todos
    if (this.endT != null) {
      this.endT -= dt;
      if (this.endT <= 0 || cars.every(c => c.fin != null)) this.finish();
    }
    if (this.time >= this.timeLimit) this.finish();
  }

  // Los que van detrás tienen más opciones de sacar objetos buenos
  rollItem(c) {
    const pos = this.order.indexOf(c.id), n = Math.max(1, this.order.length - 1), back = pos / n;
    const r = Math.random();
    if (pos === 0) return r < 0.45 ? 'mina' : r < 0.8 ? 'escudo' : 'turbo';
    if (back > 0.6) return r < 0.45 ? 'misil' : r < 0.85 ? 'turbo' : 'escudo';
    return r < 0.3 ? 'turbo' : r < 0.6 ? 'misil' : r < 0.82 ? 'mina' : 'escudo';
  }

  useItem(c) {
    const it = c.item; c.item = null;
    if (it === 'turbo') { c.boost = Math.max(c.boost, 1.8); this.onEvent({ e: 'boost', id: c.id }); }
    else if (it === 'escudo') c.shield = 8;
    else if (it === 'mina') {
      this.mines.push({ id: this.nextBullet++, owner: c.id, x: c.x - Math.sin(c.h) * 2.5, z: c.z - Math.cos(c.h) * 2.5, arm: 1, life: 45 });
    } else if (it === 'misil') {
      const i = this.order.indexOf(c.id);
      const target = i > 0 ? this.order[i - 1] : null;
      this.bullets.push({ id: this.nextBullet++, owner: c.id, target, x: c.x + Math.sin(c.h) * 2.5, z: c.z + Math.cos(c.h) * 2.5,
        vx: Math.sin(c.h) * 46, vz: Math.cos(c.h) * 46, life: target ? 5 : 1.8 });
    }
    this.onEvent({ e: 'useItem', id: c.id, item: it });
  }

  hitCar(c, by, x, z) {
    if (c.shield > 0) { c.shield = 0; this.onEvent({ e: 'block', id: c.id, x, z }); return; }
    c.spin = 1.2; c.boost = 0; c.drifting = false;
    this.onEvent({ e: 'spin', id: c.id, by, x, z });
  }

  // ---------- Bots ----------
  botDrive(c, dt) {
    const sk = DIFFICULTY[this.difficulty] || DIFFICULTY.normal, ai = c.ai, inp = c.input;
    const pace = { facil: 0.84, normal: 0.93, dificil: 1 }[this.difficulty] || 0.93;
    ai.laneT -= dt;
    if (ai.laneT <= 0) { ai.laneT = 2 + Math.random() * 3; ai.lane = (Math.random() - 0.5) * 7; }
    const look = trackPoint(c.s + 9 + Math.max(0, c.sp) * 0.35, ai.lane);
    let d = Math.atan2(look.x - c.x, look.z - c.z) - c.h;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    inp.steer = Math.max(-1, Math.min(1, -d * 2.6)); // h crece hacia la izquierda
    inp.thr = Math.abs(d) > 0.9 && c.sp > 14 ? -1 : (c.sp > 27 * pace && c.boost <= 0 ? 0 : 1);
    // derrapar en curvas cerradas (más en difícil)
    inp.j = sk.dash > 0.4 && Math.abs(d) > 0.3 && c.sp > 15 ? true : (c.drifting && Math.abs(d) > 0.12);
    // objetos
    ai.itemT -= dt;
    if (c.item && ai.itemT <= 0) {
      const i = this.order.indexOf(c.id);
      const behind = this.players.get(this.order[i + 1]);
      const use = c.item === 'turbo' ? Math.abs(d) < 0.2
        : c.item === 'misil' ? i > 0
        : c.item === 'mina' ? !!behind && behind.dist > c.dist - 20
        : true;
      if (use) { this.useItem(c); ai.itemT = 1 + Math.random() * 2; }
    }
  }

  finish() {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.order = this.carsByPosition().map(c => c.id);
    this.winner = this.order[0] || null;
    this.onEvent({ e: 'end', winner: this.winner, winnerTeam: -1 });
  }

  ranking() {
    return this.carsByPosition().map(c => ({ id: c.id, name: c.name, color: c.color, kills: 0, deaths: 0, bot: c.bot, team: 0, time: c.fin, lap: c.lap }));
  }

  snapshot() {
    const r = n => Math.round(n * 100) / 100;
    const p = [];
    for (const c of this.players.values()) {
      let f = 0;
      if (Math.abs(c.sp) > 1) f |= F.MOVING;
      if (c.boost > 0) f |= F.DASH;
      if (c.shield > 0) f |= F.SHIELD;
      p.push([c.id, r(c.x), r(c.z), r(c.h), 100, 1, f, 0, 0, c.input.seq, 0, 0, 0, r(Math.max(0, c.shield)), 0, 0, 0, 0, r(c.y),
        { sp: r(c.sp), vx: r(c.vx), vz: r(c.vz), vy: r(c.vy), bo: r(Math.max(0, c.boost)), sv: r(Math.max(0, c.spin)), dr: c.drifting ? c.driftDir : 0, dt: r(c.driftT),
          it: c.item, lap: c.lap, fin: c.fin, dist: r(c.dist), seg: c.seg }]);
    }
    return {
      t: 's', time: r(this.time), st: this.state, p,
      b: this.bullets.map(m => [m.id, r(m.x), r(m.z), r(m.vx), r(m.vz), m.owner]),
      k: [], md: this.modeState(),
    };
  }

  modeState() {
    const r = n => Math.round(n * 10) / 10;
    return {
      m: 'kart', goal: this.goal, ph: this.phase, pt: r(Math.max(0, this.phaseT)), tl: this.timeLimit,
      rt: r(this.raceT), order: this.order, endT: this.endT == null ? -1 : r(Math.max(0, this.endT)),
      boxes: this.boxes.map(b => b.active ? 1 : 0), mines: this.mines.map(m => [m.id, r(m.x), r(m.z)]),
    };
  }
}
