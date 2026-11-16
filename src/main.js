// Neón Arena: menús, partidas, red y bucle principal.
import {
  STEP, SNAP_EVERY, MAX_PLAYERS, COLORS, BOT_NAMES, DIFFICULTY, HALF, BOXES, PICKUP_SPOTS,
  PICKUP_INFO, PLAYER_R, SPEED, SPEED_BOOST, DASH_SPEED, DASH_TIME, DASH_CD, FIRE_CD, BULLET_SPEED, BULLET_LIFE,
  BULLET_R, MAX_HP, CHARACTERS, EMOTES, MODES, TEAMS, BOMB, SITES,
} from './config.js';
import { Game, moveCircle, pointBlocked, F } from './sim.js';
import { KartGame, stepCar, carControls, TRACK, KART_ITEMS } from './race.js';
import { ParkourGame, stepRunner, newRunner, COURSE } from './parkour.js';
import { Renderer } from './render.js';
import { initAudio, sfx, setVolume, setMusic, startMusic, stopMusic } from './audio.js';

const PREFIX = 'neonarena-v1-';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3200); }
function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id); }
function hideScreens() { for (const s of document.querySelectorAll('.screen')) s.classList.remove('active'); }

// ================== Ajustes del jugador ==================
const prefs = {
  color: +(store('na.color') || 0),
  bots: +(store('na.bots') || 5),
  diff: store('na.diff') || 'normal',
  kills: +(store('na.kills') || 15),
  mode: MODES[store('na.mode')] ? store('na.mode') : 'ffa',
  goals: (() => { try { return { ffa: 15, tdm: 30, bomb: 5, ...JSON.parse(store('na.goals') || '{}') }; } catch (e) { return { ffa: 15, tdm: 30, bomb: 5 }; } })(),
  quality: store('na.quality') || 'alta',
  fps: store('na.fps') === '1',
  volume: store('na.volume') != null ? +store('na.volume') : 0.6,
  music: store('na.music') !== '0',
};
function savePrefs() { for (const [k, v] of Object.entries(prefs)) store('na.' + k, typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'object' ? JSON.stringify(v) : v); }
const goalFor = m => (prefs.goals[m] != null ? prefs.goals[m] : MODES[m].def);
const isRaceMode = () => !!(MODES[(view.md && view.md.m) || S.settings.mode] || {}).race;
const MODE_DESC = {
  kart: 'Carrera de coches de neón. Gana quien complete antes las vueltas. Derrapa con Espacio (al soltarlo, turbo) y usa los objetos de las cajas con clic o E.',
  parkour: 'Carrera de obstáculos sobre el vacío. Salta con Espacio e impúlsate en el aire con Shift. Si te caes, vuelves al último punto de control.',
  ffa: 'Cada uno por su cuenta. Gana quien llegue antes a las bajas.',
  tdm: 'Rojos contra Azules. Gana el primer equipo que sume las bajas.',
  bomb: 'Rondas sin reaparecer. El ataque planta la bomba en A o B (mantén E) y la defensa la desactiva. A mitad de partida se cambian los papeles.',
};
const isTeams = () => !!(MODES[S.settings.mode] || {}).teams;
const teamName = t => (TEAMS[t] || {}).name || '';
const QUALITY_NAMES = { alta: 'Alta', media: 'Media', baja: 'Baja', patata: 'Patata' };
const myName = () => ($('apodo').value.trim() || 'Jugador').slice(0, 14);

// ================== Estado de sesión ==================
const S = {
  mode: null,          // 'solo' | 'host' | 'guest'
  phase: 'menu',       // 'menu' | 'lobby' | 'playing' | 'over'
  myId: null,
  roster: [],          // [{id, name, color, pcolor, team, bot, char}]
  settings: { mode: 'ffa', goal: 15, difficulty: 'normal' },
  game: null,          // solo / anfitrión
  peer: null, conns: new Map(), hostConn: null, code: '', guestSeq: 0, botSeq: 0,
  paused: false,
};

let renderer;
// victory: conjunto de ids que celebran al final (null mientras se juega); md: estado del modo
const view = { players: new Map(), bullets: [], pickups: PICKUP_SPOTS.map(() => 1), time: 0, timeLimit: 300, state: 'playing', focus: null, victory: null, md: null };

// ================== Entrada ==================
const input = { keys: new Set(), mx: innerWidth / 2, my: innerHeight / 2, fire: false, dash: false, aim: 0 };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.offsetParent !== null) return; // escribiendo en un campo visible
  if ((e.code === 'KeyT' || e.code === 'Enter') && !e.repeat) {
    if ((S.phase === 'playing' || S.phase === 'over') && !$('pause').classList.contains('active')) { e.preventDefault(); openChat(); return; }
    if (S.phase === 'lobby') { e.preventDefault(); $('lobbyChatInput').focus(); return; }
  }
  input.keys.add(e.code);
  if (S.phase === 'playing' || S.phase === 'over') {
    // Espacio: impulso en la arena, saltar en el parkour y derrapar en el kart; Shift: siempre impulso
    if (e.code === 'Space') { e.preventDefault(); input.jump = true; if (!isRaceMode()) { input.dash = true; input.dashNet = true; } }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { input.dash = true; input.dashNet = true; e.preventDefault(); }
    if (e.code === 'Tab') { e.preventDefault(); renderScoreboard(); $('scoreboard').hidden = false; }
    const em = /^(Digit|Numpad)([1-9])$/.exec(e.code);
    if (em && +em[2] <= EMOTES.length && S.phase === 'playing' && !S.paused) { input.em = +em[2]; input.emNet = +em[2]; }
    if (e.code === 'Escape' && S.phase === 'playing') togglePause();
    if (e.code === 'KeyE') { input.act = true; input.tap = true; input.tapNet = true; } // tap: una pulsación rápida no se pierde
  }
});
addEventListener('keyup', e => { input.keys.delete(e.code); if (e.code === 'Tab') $('scoreboard').hidden = true; if (e.code === 'KeyE') input.act = false; if (e.code === 'Space') input.jump = false; });
addEventListener('mousemove', e => { input.mx = e.clientX; input.my = e.clientY; const c = $('crosshair'); c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; });
addEventListener('mousedown', e => { if (e.button === 0 && S.phase === 'playing' && !S.paused && !chatOpen && !e.target.closest('.panel')) { input.fire = true; input.tap = true; input.tapNet = true; } });
addEventListener('mouseup', e => { if (e.button === 0) input.fire = false; });
addEventListener('contextmenu', e => { if (S.phase === 'playing') e.preventDefault(); });
addEventListener('blur', () => { input.keys.clear(); input.fire = false; input.act = false; input.jump = false; });
for (const ev of ['keydown', 'keyup', 'mousedown', 'mouseup']) addEventListener(ev, e => { if (!e.repeat) setTimeout(sendGuestInput, 0); });

function moveVec() {
  const k = input.keys;
  let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
  let z = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
  if (S.paused) x = z = 0;
  const l = Math.hypot(x, z);
  return l > 0 ? [x / l, z / l] : [0, 0];
}
function updateAim(me) {
  const g = renderer.groundPoint(input.mx, input.my);
  if (g && me) {
    input.aim = Math.atan2(g.x - me.x, g.z - me.z);
    const ax = Math.max(-4, Math.min(4, (g.x - me.x) * 0.2)), az = Math.max(-3, Math.min(3, (g.z - me.z) * 0.2));
    return [ax, az];
  }
  return [0, 0];
}

// ================== Simulación local (solo y anfitrión) ==================
let acc = 0, lastTick = 0, stepCount = 0, pendingEvents = [], endSent = false;
const tickWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),1000/60)'], { type: 'text/javascript' })));
tickWorker.onmessage = () => hostTick();

function startLocalGame() {
  applyTeamColors();
  const opts = { mode: S.settings.mode, goal: S.settings.goal, difficulty: S.settings.difficulty };
  const g = opts.mode === 'kart' ? new KartGame(opts) : opts.mode === 'parkour' ? new ParkourGame(opts) : new Game(opts);
  g.onEvent = e => { pendingEvents.push(e); handleEvent(e); };
  S.game = g; acc = 0; lastTick = performance.now(); stepCount = 0; pendingEvents = []; endSent = false;
  for (const r of S.roster) g.addPlayer(r.id, r.name, r.color, r.bot, r.team);
  view.timeLimit = g.timeLimit;
}

function hostTick() {
  const g = S.game;
  if (!g || (S.mode !== 'solo' && S.mode !== 'host')) return;
  const now = performance.now();
  acc += Math.min(0.25, (now - lastTick) / 1000); lastTick = now;
  if (S.paused && S.mode === 'solo') { acc = 0; return; }
  while (acc >= STEP) {
    acc -= STEP;
    const [mx, mz] = moveVec();
    g.setInput(S.myId, { mx, mz, a: input.aim, f: input.fire && !S.paused, d: input.dash, em: input.em, u: (input.act || input.tap) && !S.paused, j: input.jump && !S.paused });
    input.dash = false; input.em = 0; input.tap = false;
    g.step(STEP);
    stepCount++;
    if (S.mode === 'host' && stepCount % SNAP_EVERY === 0) {
      const snap = g.snapshot(); snap.ev = pendingEvents; pendingEvents = [];
      broadcast(snap);
    } else if (S.mode === 'solo') pendingEvents = [];
  }
  if (g.state === 'over' && !endSent) {
    endSent = true;
    const msg = { t: 'end', winner: g.winner, winnerTeam: g.winnerTeam, mode: g.mode, score: g.score.slice(), ranking: g.ranking() };
    if (S.mode === 'host') { const snap = g.snapshot(); snap.ev = pendingEvents; pendingEvents = []; broadcast(snap); broadcast(msg); }
    onEnd(msg);
  }
}

// Jugador a partir de su fila del snapshot (lo usan el anfitrión en los minijuegos y los invitados)
function parsePlayer(a) {
  const [id, x, z, aim, hp, alive, flags, kills, deaths, seq, dashCd, triple, speed, shield, respawnT, emote, emoteN, team, y, ex] = a;
  const o = { id, x, z, aim, hp, alive: !!alive, flags, kills, deaths, seq, dashCd, triple, speed, shield, respawnT, emote, emoteN, team, y: y || 0 };
  if (ex) { Object.assign(o, ex); if ('g' in ex) o.air = !ex.g; }
  return o;
}
function withRoster(o) {
  const r = S.roster.find(r => r.id === o.id) || { name: '?', color: '#fff' };
  o.name = r.name; o.color = r.color; o.char = r.char;
  return o;
}

function viewFromGame() {
  const g = S.game;
  if (g.mode === 'kart' || g.mode === 'parkour') {
    // los minijuegos se ven a través de su propio snapshot
    const snap = g.snapshot();
    view.players.clear();
    for (const a of snap.p) view.players.set(a[0], withRoster(parsePlayer(a)));
    view.bullets = snap.b.map(([id, x, z, vx, vz, owner]) => ({ id, x, z, vx, vz, color: (S.roster.find(r => r.id === owner) || {}).color || '#fff' }));
    view.pickups = []; view.time = g.time; view.T = g.time; view.md = snap.md;
    return;
  }
  view.players.clear();
  for (const p of g.players.values()) {
    let f = 0;
    if (p.moving) f |= F.MOVING; if (p.dashT > 0) f |= F.DASH; if (p.shield > 0) f |= F.SHIELD;
    if (p.triple > 0) f |= F.TRIPLE; if (p.speed > 0) f |= F.SPEED; if (p.invul > 0) f |= F.INVUL; if (p.acting) f |= F.ACT;
    const r = S.roster.find(r => r.id === p.id) || {};
    view.players.set(p.id, {
      id: p.id, name: p.name, color: p.color, char: r.char, x: p.x, z: p.z, aim: p.aim, hp: Math.ceil(p.hp), alive: p.alive, flags: f,
      kills: p.kills, deaths: p.deaths, dashCd: Math.max(0, p.dashCd), triple: p.triple, speed: p.speed, shield: p.shield,
      respawnT: Number.isFinite(p.respawnT) ? p.respawnT : -1, emote: p.emote, emoteN: p.emoteN, team: p.team,
    });
  }
  view.bullets = g.bullets;
  view.pickups = g.pickups.map(k => k.active);
  view.time = g.time;
  view.md = g.modeState();
}

// ================== Cliente remoto (invitado) ==================
const G = { snaps: [], offset: null, pred: null, hist: [], lastSend: 0, localBullets: [], lb: 0, fireCd: 0, me: null };

function resetGuestState() {
  G.snaps = []; G.offset = null; G.pred = null; G.race = null; G.hist = []; G.localBullets = []; G.fireCd = 0; G.me = null;
}

function onSnapshot(s) {
  const now = performance.now() / 1000;
  const off = s.time - now;
  G.offset = G.offset == null ? off : (off > G.offset ? G.offset + (off - G.offset) * 0.05 : off);
  const players = new Map();
  for (const a of s.p) players.set(a[0], parsePlayer(a));
  const bullets = new Map();
  for (const [id, x, z, vx, vz, owner] of s.b) bullets.set(id, { id, x, z, vx, vz, owner });
  G.snaps.push({ time: s.time, players, bullets });
  while (G.snaps.length > 30) G.snaps.shift();
  view.pickups = s.k;
  view.time = s.time;
  if (s.md) view.md = s.md;

  // corrección de la predicción propia
  const me = players.get(S.myId);
  if (me && s.md && MODES[s.md.m] && MODES[s.md.m].race) reconcileRace(me, s.md.m);
  else if (me) {
    G.me = me;
    if (!me.alive) G.pred = null;
    else if (!G.pred) G.pred = { x: me.x, z: me.z, dashT: 0, dashX: 0, dashZ: 0, dashCd: me.dashCd };
    else {
      const h = G.hist.find(h => h.seq === me.seq);
      if (h) {
        const ex = me.x - h.x, ez = me.z - h.z;
        if (Math.hypot(ex, ez) > 3) { G.pred.x = me.x; G.pred.z = me.z; G.hist = []; }
        else {
          const cx = ex * 0.4, cz = ez * 0.4;
          G.pred.x += cx; G.pred.z += cz;
          for (const k of G.hist) if (k.seq > me.seq) { k.x += cx; k.z += cz; }
        }
      }
      G.hist = G.hist.filter(k => k.seq > me.seq);
    }
  }
  for (const e of s.ev || []) handleEvent(e);
}

// ---------- Predicción en los minijuegos ----------
// Estado completo del coche o del corredor a partir de lo que dice el anfitrión
function raceFromServer(me, m) {
  if (m === 'kart') {
    return { x: me.x, z: me.z, h: me.aim, sp: me.sp || 0, vx: me.vx || 0, vz: me.vz || 0, y: me.y, vy: me.vy || 0, boost: me.bo || 0, spin: me.sv || 0,
      drifting: !!me.dr, driftDir: me.dr || 0, driftT: me.dt || 0, seg: me.seg || 0, dist: me.dist || 0, s: (((me.dist || 0) % TRACK.L) + TRACK.L) % TRACK.L, m };
  }
  return Object.assign(newRunner(me.x, me.y, me.z), { vx: me.vx || 0, vz: me.vz || 0, vy: me.vy || 0, kx: me.kx || 0, kz: me.kz || 0,
    onG: !me.air, stand: me.st != null ? me.st : -1, dashUsed: !!me.du, aim: me.aim, m });
}
function reconcileRace(me, m) {
  if (!G.race || G.race.m !== m) { G.race = raceFromServer(me, m); G.hist = []; return; }
  const p = G.race, h = G.hist.find(h => h.seq === me.seq);
  if (h) {
    const ex = me.x - h.x, ez = me.z - h.z, ey = me.y - h.y;
    if (Math.hypot(ex, ey, ez) > 3) { G.race = raceFromServer(me, m); G.hist = []; return; }
    const cx = ex * 0.4, cz = ez * 0.4, cy = ey * 0.4;
    let ch = 0, cs = 0;
    if (m === 'kart') { let dh = me.aim - h.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); ch = dh * 0.4; cs = ((me.sp || 0) - h.sp) * 0.4; }
    p.x += cx; p.z += cz; p.y += cy; if (m === 'kart') { p.h += ch; p.sp += cs; }
    for (const k of G.hist) if (k.seq > me.seq) { k.x += cx; k.z += cz; k.y += cy; k.h += ch; k.sp += cs; }
  }
  G.hist = G.hist.filter(k => k.seq > me.seq);
  // lo que solo sabe el anfitrión: trompos y turbos de objetos
  if (m === 'kart') {
    if ((me.sv || 0) > 0.1 && p.spin <= 0) p.spin = me.sv;
    if ((me.bo || 0) > p.boost + 0.3) p.boost = me.bo;
  }
}

function sendGuestInput() {
  if (S.mode !== 'guest' || !S.hostConn || !S.hostConn.open || S.phase !== 'playing') return;
  G.lastSend = performance.now() / 1000;
  const [mx, mz] = moveVec();
  const seq = ++S.guestSeq;
  S.hostConn.send({ t: 'in', seq, mx, mz, a: +input.aim.toFixed(3), f: input.fire && !S.paused, d: !!input.dashNet, em: input.emNet || 0, u: !!(input.act || input.tapNet), j: !!input.jump });
  input.emNet = 0; input.tapNet = false;
  if (G.race) G.hist.push({ seq, x: G.race.x, z: G.race.z, y: G.race.y || 0, h: G.race.h || 0, sp: G.race.sp || 0 });
  else if (G.pred) G.hist.push({ seq, x: G.pred.x, z: G.pred.z });
  if (G.hist.length > 120) G.hist.shift();
  input.dashNet = false;
}

function guestFrame(dt) {
  const now = performance.now() / 1000;
  // durante la cuenta atrás de la ronda nadie se mueve ni dispara
  const frozen = view.md && (view.md.m === 'bomb' || MODES[view.md.m].race) && view.md.ph === 'freeze';
  const [mx, mz] = frozen ? [0, 0] : moveVec();
  const me = G.me;
  const raceM = view.md && MODES[view.md.m] && MODES[view.md.m].race ? view.md.m : null;
  if (G.offset != null) view.T = now + G.offset;
  // predicción del coche o del corredor propio con la misma física que el anfitrión
  if (raceM && G.race && S.phase === 'playing') {
    const done = me && me.fin != null;
    if (raceM === 'kart') stepCar(G.race, frozen ? { thr: 0, steer: 0, drift: false } : { ...carControls(mx, mz), drift: input.jump }, dt);
    else {
      const tiles = new Map(((view.md && view.md.tiles) || []).map(([i, st, t]) => [i, { st, t }]));
      const inp = frozen || done ? { mx: 0, mz: 0, j: false, d: false } : { mx, mz, j: input.jump, d: input.dash };
      stepRunner(G.race, inp, dt, { T: view.T, tiles });
    }
  }
  // predicción del movimiento propio
  if (!raceM && G.pred && me && me.alive && S.phase === 'playing') {
    const p = G.pred;
    p.dashCd -= dt;
    if (input.dash && p.dashCd <= 0) {
      input.dash = false;
      let dx = mx, dz = mz;
      if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(input.aim); dz = Math.cos(input.aim); }
      const l = Math.hypot(dx, dz); p.dashX = dx / l; p.dashZ = dz / l; p.dashT = DASH_TIME; p.dashCd = DASH_CD;
    }
    let vx, vz;
    if (p.dashT > 0) { p.dashT -= dt; vx = p.dashX * DASH_SPEED; vz = p.dashZ * DASH_SPEED; }
    else { const sp = SPEED * ((me.flags & F.SPEED) ? SPEED_BOOST : 1); vx = mx * sp; vz = mz * sp; }
    p.moving = Math.abs(vx) + Math.abs(vz) > 0.1;
    [p.x, p.z] = moveCircle(p.x, p.z, vx * dt, vz * dt, PLAYER_R);
    // balas propias (solo visuales; el daño lo decide el anfitrión)
    G.fireCd -= dt;
    if (input.fire && G.fireCd <= 0 && !frozen) {
      G.fireCd = FIRE_CD;
      const r = S.roster.find(r => r.id === S.myId);
      for (const da of (me.flags & F.TRIPLE) ? [-0.16, 0, 0.16] : [0]) {
        const a = input.aim + da;
        G.localBullets.push({ id: 'L' + (++G.lb), x: p.x + Math.sin(a) * 0.8, z: p.z + Math.cos(a) * 0.8, vx: Math.sin(a) * BULLET_SPEED, vz: Math.cos(a) * BULLET_SPEED, life: BULLET_LIFE, color: r ? r.color : '#fff' });
      }
      handleEvent({ e: 'shot', id: S.myId, local: true });
    }
  }
  input.dash = false;
  // enviar entrada a 30 Hz
  if (now - G.lastSend > 1 / 30) sendGuestInput();

  // interpolación de los demás (100 ms de retraso)
  if (G.offset == null || !G.snaps.length) return;
  const rt = now + G.offset - 0.1;
  let a = G.snaps[0], b = G.snaps[G.snaps.length - 1];
  for (let i = 0; i < G.snaps.length - 1; i++) {
    if (G.snaps[i].time <= rt && G.snaps[i + 1].time >= rt) { a = G.snaps[i]; b = G.snaps[i + 1]; break; }
  }
  const t = b.time > a.time ? Math.max(0, Math.min(1, (rt - a.time) / (b.time - a.time))) : 1;
  const lerp = (u, v) => u + (v - u) * t;
  const lerpA = (u, v) => { let d = v - u; d = Math.atan2(Math.sin(d), Math.cos(d)); return u + d * t; };
  view.players.clear();
  for (const pb of b.players.values()) {
    const pa = a.players.get(pb.id) || pb;
    const r = S.roster.find(r => r.id === pb.id) || { name: '?', color: '#fff' };
    const latest = G.snaps[G.snaps.length - 1].players.get(pb.id) || pb;
    const v = {
      ...latest, name: r.name, color: r.color, char: r.char,
      x: lerp(pa.x, pb.x), z: lerp(pa.z, pb.z), y: lerp(pa.y || 0, pb.y || 0), aim: lerpA(pa.aim, pb.aim), flags: pb.flags,
    };
    if (pb.id === S.myId && raceM && G.race) {
      const p = G.race;
      v.x = p.x; v.z = p.z; v.y = p.y;
      if (raceM === 'kart') { v.aim = p.h; v.sp = p.sp; v.dr = p.drifting ? p.driftDir : 0; v.dt = p.driftT; v.flags = (latest.flags & ~F.DASH) | (p.boost > 0 ? F.DASH : 0); }
      else { v.aim = p.aim; v.air = !p.onG; v.flags = (latest.flags & ~(F.MOVING | F.DASH)) | (Math.hypot(p.vx, p.vz) > 0.5 ? F.MOVING : 0) | (p.dashT > 0 ? F.DASH : 0); }
    } else if (pb.id === S.myId) {
      v.aim = input.aim;
      if (G.pred && latest.alive) { v.x = G.pred.x; v.z = G.pred.z; v.flags = (latest.flags & ~(F.MOVING | F.DASH)) | (G.pred.moving ? F.MOVING : 0) | (G.pred.dashT > 0 ? F.DASH : 0); v.alive = true; }
      else { v.x = latest.x; v.z = latest.z; v.alive = latest.alive; }
    }
    view.players.set(pb.id, v);
  }
  // balas: las ajenas interpoladas, las propias simuladas en local
  const bl = [];
  for (const bb of b.bullets.values()) {
    if (bb.owner === S.myId && !raceM) continue;
    const ba = a.bullets.get(bb.id);
    const r = S.roster.find(r => r.id === bb.owner);
    if (raceM) { bl.push({ id: bb.id, x: ba ? lerp(ba.x, bb.x) : bb.x, z: ba ? lerp(ba.z, bb.z) : bb.z, vx: bb.vx, vz: bb.vz, color: r ? r.color : '#fff' }); continue; }
    const x = ba ? lerp(ba.x, bb.x) : bb.x - bb.vx * (b.time - rt);
    const z = ba ? lerp(ba.z, bb.z) : bb.z - bb.vz * (b.time - rt);
    bl.push({ id: bb.id, x, z, vx: bb.vx, vz: bb.vz, color: r ? r.color : '#fff' });
  }
  G.localBullets = G.localBullets.filter(lb => {
    lb.x += lb.vx * dt; lb.z += lb.vz * dt; lb.life -= dt;
    if (lb.life <= 0) return false;
    if (pointBlocked(lb.x, lb.z, BULLET_R * 0.5)) { renderer.burst(lb.x, 1.1, lb.z, lb.color, 10, 4, 3); return false; }
    for (const p of view.players.values()) if (p.id !== S.myId && p.alive && Math.hypot(p.x - lb.x, p.z - lb.z) < PLAYER_R + BULLET_R) return false;
    bl.push(lb); return true;
  });
  view.bullets = bl;
}

// ================== Chat ==================
const CHAT_MAX = 120;
const BOT_TAUNTS = ['¡Toma ya!', 'Demasiado lento 😎', '¿Eso es todo?', 'Bip bop, eliminado', 'Vuelve cuando practiques', '¡Zas!', 'Mis circuitos ni se han calentado', 'GG fácil'];
const BOT_SALTY = ['Suerte...', 'Lag 😤', 'La próxima es mía', 'Error 404: puntería no encontrada', 'Eso no ha contado'];
let chatOpen = false, lastChatSent = 0;

function openChat() {
  if (chatOpen) return;
  chatOpen = true;
  input.keys.clear(); input.fire = false;
  const el = $('chatInput'); el.hidden = false; el.value = ''; el.focus();
  $('chat').classList.add('open');
  document.body.classList.remove('playing');
  const log = $('chatLog'); log.scrollTop = log.scrollHeight;
}
function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  const el = $('chatInput'); el.blur(); el.hidden = true;
  $('chat').classList.remove('open');
  if (S.phase === 'playing') document.body.classList.add('playing');
}

function sendChat(raw) {
  const text = String(raw || '').trim().slice(0, CHAT_MAX);
  if (!text) return;
  const now = performance.now();
  if (now - lastChatSent < 500) return;
  lastChatSent = now;
  if (S.mode === 'guest') { if (S.hostConn && S.hostConn.open) S.hostConn.send({ t: 'chat', text }); }
  else hostChat(S.myId, text);
}

// El anfitrión reparte los mensajes (también en solitario, para los bots)
function hostChat(id, text) {
  const r = S.roster.find(r => r.id === id);
  if (!r) return;
  const msg = { t: 'chat', id, name: r.name, color: r.color, text: String(text).slice(0, CHAT_MAX) };
  if (S.mode === 'host') broadcast(msg);
  addChat(msg);
}
function sysChat(text) {
  const msg = { t: 'chat', sys: true, text };
  if (S.mode === 'host') broadcast(msg);
  addChat(msg);
}

function addChat(m) {
  if (typeof m.text !== 'string') return;
  const html = m.sys
    ? esc(m.text)
    : `<b style="color:${COLORS.includes(m.color) ? m.color : '#fff'}">${esc(String(m.name || '?').slice(0, 14))}:</b>${esc(m.text.slice(0, CHAT_MAX))}`;
  for (const [id, keep] of [['chatLog', 30], ['lobbyChatLog', 50]]) {
    const log = $(id);
    const el = document.createElement('div');
    el.className = 'line' + (m.sys ? ' sys' : '');
    el.innerHTML = html;
    log.append(el);
    while (log.querySelectorAll('.line').length > keep) log.querySelector('.line').remove();
    log.scrollTop = log.scrollHeight;
    if (id === 'chatLog') setTimeout(() => el.classList.add('old'), 8000);
  }
  const empty = $('lobbyChatEmpty'); if (empty) empty.remove();
  if (!m.sys && m.id !== S.myId) sfx.click();
}

function clearChat() {
  $('chatLog').innerHTML = '';
  $('lobbyChatLog').innerHTML = '<p class="muted small" id="lobbyChatEmpty">Nadie ha escrito todavía. ¡Saluda!</p>';
  closeChat();
}

function botBanter(killer, victim) {
  if (S.mode === 'guest') return;
  const k = S.roster.find(r => r.id === killer), v = S.roster.find(r => r.id === victim);
  if (!k || !v) return;
  let id = null, lines = null;
  if (k.bot && !v.bot && Math.random() < 0.35) { id = k.id; lines = BOT_TAUNTS; }
  else if (v.bot && !k.bot && Math.random() < 0.15) { id = v.id; lines = BOT_SALTY; }
  if (!id) return;
  const mode = S.mode;
  setTimeout(() => { if (S.mode === mode && S.phase === 'playing') hostChat(id, lines[Math.floor(Math.random() * lines.length)]); }, 700 + Math.random() * 900);
}

// ================== Eventos (sonido, efectos y textos) ==================
const kf = [];
let lastKillAt = 0, streak = 0, firstBlood = false;
function handleEvent(e) {
  const players = view.players;
  if (e.e === 'shot' && e.id === S.myId && S.mode === 'guest' && !e.local) return; // ya se mostró en local
  renderer.fx(e, players, S.myId);
  const nameOf = id => { if (id == null) return { name: '💣 Bomba', color: '#ff3355' }; const r = S.roster.find(r => r.id === id); return r ? r : { name: '?', color: '#fff' }; };
  const myTeam = (S.roster.find(r => r.id === S.myId) || {}).team;
  switch (e.e) {
    case 'shot': if (e.id === S.myId) sfx.shot(1); else { const p = players.get(e.id), me = players.get(S.myId); const d = p && me ? Math.hypot(p.x - me.x, p.z - me.z) : 20; if (d < 25) sfx.shot(Math.max(0.15, 1 - d / 25) * 0.6); } break;
    case 'hit':
      if (e.id === S.myId) { sfx.hurt(); flashDamage(); }
      else if (e.by === S.myId) sfx.hit();
      break;
    case 'kill': {
      sfx.kill();
      const k = nameOf(e.killer), v = nameOf(e.victim);
      addKillfeed(`<span style="color:${k.color}">${esc(k.name)}</span> ⚡ <span style="color:${v.color}">${esc(v.name)}</span>`, e.killer === S.myId || e.victim === S.myId);
      botBanter(e.killer, e.victim);
      if (!firstBlood && e.killer != null) { firstBlood = true; announce(e.killer === S.myId ? '¡Primera sangre!' : k.name + ': primera sangre'); }
      if (e.killer === S.myId) {
        sfx.myKill();
        const now = performance.now();
        streak = now - lastKillAt < 4000 ? streak + 1 : 1; lastKillAt = now;
        if (streak === 2) announce('¡Doble eliminación!'); else if (streak === 3) announce('¡Triple eliminación!'); else if (streak >= 4) announce('¡Imparable!');
      }
      break;
    }
    case 'pickup': if (e.id === S.myId) { sfx.pickup(); announce(PICKUP_INFO[e.type].label, 900); } break;
    case 'dash': if (e.id === S.myId) sfx.dash(); break;
    case 'spawn': if (e.id === S.myId && !(view.md && view.md.m === 'bomb')) sfx.spawn(); break;
    // modo bomba
    case 'round': {
      const atk = e.atk === myTeam;
      announce(`Ronda ${e.round} · ${atk ? 'Atacáis' : 'Defendéis'}`, 2600);
      if (e.carrier === S.myId) setTimeout(() => announce('💣 Llevas la bomba: plántala en A o B', 2600), 2700);
      sfx.round();
      break;
    }
    case 'live': announce('¡YA!', 900); sfx.go(); break;
    case 'plant': announce(`💣 Bomba plantada en ${SITES[e.site].name}`, 2200); sfx.plant(); break;
    case 'defuse': announce('Bomba desactivada', 2000); sfx.defuse(); break;
    case 'explode': sfx.explode(); break;
    case 'bombPick': if (e.id === S.myId) announce('💣 Has cogido la bomba', 1500); break;
    case 'bombDrop': if (view.md && myTeam === view.md.atk) announce('¡La bomba está en el suelo!', 1500); break;
    // minijuegos
    case 'lap': if (e.id === S.myId) { const goal = (view.md && view.md.goal) || 3; announce(e.lap === goal ? '¡Última vuelta!' : `Vuelta ${e.lap}/${goal}`, 1800); sfx.round(); } break;
    case 'finish': {
      const n = nameOf(e.id);
      if (e.id === S.myId) { announce(e.pos === 1 ? '¡Primero! 🏆' : `¡Has llegado ${e.pos}.º!`, 3000); e.pos === 1 ? sfx.win() : sfx.myKill(); }
      else { announce(`${n.name} llega ${e.pos}.º`, 1600); }
      addKillfeed(`🏁 <span style="color:${n.color}">${esc(n.name)}</span> ${e.pos}.º · ${fmtTime(e.time)}`, e.id === S.myId);
      break;
    }
    case 'item': if (e.id === S.myId) { sfx.pickup(); announce(`${KART_ITEMS[e.item].icon} ${KART_ITEMS[e.item].label}`, 1000); } break;
    case 'useItem': if (e.id === S.myId) ({ misil: sfx.shot, mina: sfx.click, turbo: sfx.dash, escudo: sfx.pickup }[e.item] || sfx.click)(); break;
    case 'spin':
      if (e.id === S.myId) { sfx.hurt(); flashDamage(); announce('¡Trompo!', 900); }
      else if (e.by === S.myId) { sfx.hit(); announce('¡Le has dado!', 900); }
      break;
    case 'boost': if (e.id === S.myId) sfx.dash(); break;
    case 'zap': if (e.id === S.myId) { sfx.hurt(); flashDamage(); } break;
    case 'fall': if (e.id === S.myId) { sfx.lose(); announce('¡Al vacío! Vuelves al punto de control', 1600); } break;
    case 'checkpoint': if (e.id === S.myId) { sfx.pickup(); announce(`Punto de control ${e.cp}`, 1400); } break;
    case 'bounce': if (e.id === S.myId) sfx.go(); break;
    case 'roundEnd': {
      const why = { defuse: 'bomba desactivada', explode: 'la bomba ha explotado', elim: 'equipo eliminado', time: 'se acabó el tiempo' }[e.reason] || '';
      announce(`${e.w === myTeam ? '¡Ronda ganada!' : 'Ronda perdida'} · ${why}`, 3500);
      e.w === myTeam ? sfx.myKill() : sfx.lose();
      break;
    }
  }
}
function addKillfeed(html, mine) {
  const el = document.createElement('div'); el.innerHTML = html; if (mine) el.className = 'me';
  $('killfeed').prepend(el);
  while ($('killfeed').children.length > 6) $('killfeed').lastChild.remove();
  setTimeout(() => el.remove(), 6000);
}
function announce(text, ms = 1600) {
  const el = $('announce'); el.textContent = text; el.classList.add('show');
  clearTimeout(announce.t); announce.t = setTimeout(() => el.classList.remove('show'), ms);
}
function flashDamage() { const v = $('vignette'); v.style.opacity = 0.55; clearTimeout(flashDamage.t); flashDamage.t = setTimeout(() => v.style.opacity = 0, 140); }

// ================== HUD ==================
let hudT = 0;
function fmtTime(t) { return t == null ? 'No terminó' : Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0'); }
const ordinal = n => n + '.º';

// HUD de las carreras: posición, vuelta o punto de control, objeto y velocidad
function updateRaceHud(me) {
  const md = view.md; if (!md) return;
  const order = md.order || [], n = view.players.size;
  const pos = order.indexOf(S.myId) + 1;
  $('racePos').innerHTML = pos ? `${ordinal(pos)}<small>/${n}</small>` : '';
  if (me && me.fin != null) $('raceInfo').textContent = `🏁 Meta · ${fmtTime(me.fin)}`;
  else if (md.m === 'kart') $('raceInfo').textContent = `Vuelta ${Math.min(md.goal, (me && me.lap) || 1)}/${md.goal}`;
  else $('raceInfo').textContent = `Punto de control ${(me && me.cp) || 0}/${COURSE.cpCount - 1}`;
  const it = me && md.m === 'kart' && me.it;
  $('raceItem').hidden = !it;
  if (it) { $('raceItemIcon').textContent = KART_ITEMS[it].icon; $('raceItemName').textContent = KART_ITEMS[it].label.toUpperCase(); }
  $('raceSpeed').textContent = md.m === 'kart' && me ? Math.round(Math.abs(me.sp || 0) * 4.2) + ' km/h' : '';
}

function updateHud(dt) {
  hudT -= dt;
  const me = view.players.get(S.myId);
  const race = isRaceMode();
  document.body.classList.toggle('race', race);
  document.body.classList.toggle('kart', race && !!view.md && view.md.m === 'kart');
  $('raceHud').hidden = !race;
  if (race) { $('respawn').hidden = true; $('action').hidden = true; updateRaceHud(me); }
  else if (me) {
    const hp = me.alive ? me.hp : 0;
    $('hpbar').firstElementChild.style.width = (hp / MAX_HP * 100) + '%';
    $('hpbar').className = hp > 50 ? '' : hp > 25 ? 'mid' : 'low';
    $('hpnum').textContent = hp;
    const cd = S.mode === 'guest' && G.pred ? Math.max(0, G.pred.dashCd) : me.dashCd;
    $('dash').firstElementChild.style.width = ((1 - Math.min(1, cd / DASH_CD)) * 100) + '%';
    $('dash').classList.toggle('ready', cd <= 0);
    $('respawn').hidden = me.alive || S.phase !== 'playing';
    const waitRound = me.respawnT < 0; // modo bomba: hasta la siguiente ronda
    $('respawnText').textContent = waitRound ? 'Eliminado · esperando a la siguiente ronda' : 'Has sido eliminado';
    $('respawnT').hidden = waitRound;
    $('respawnT').textContent = Math.max(1, Math.ceil(me.respawnT || 0));
  }
  if (!race) { updateAction(me); bombBeeps(dt); }
  if (hudT > 0) return;
  hudT = 0.2;
  updateModeHud();
  if (race && view.md) {
    // clasificación de la carrera: posición y vuelta, o tiempo si ya llegó
    const list = (view.md.order || []).map(id => view.players.get(id)).filter(Boolean);
    $('mini-board').innerHTML = list.slice(0, 6).map((p, i) => `<div class="${p.id === S.myId ? 'me' : ''} ${p.fin != null ? 'done' : ''}" style="--c:${p.color}"><span>${i + 1}. ${esc(p.name)}</span><b>${p.fin != null ? fmtTime(p.fin) : view.md.m === 'kart' ? 'V' + (p.lap || 1) : 'PC' + (p.cp || 0)}</b></div>`).join('');
  } else {
    const list = [...view.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    $('mini-board').innerHTML = list.slice(0, 5).map(p => `<div class="${p.id === S.myId ? 'me' : ''}" style="--c:${p.color}"><span>${esc(p.name)}</span><b>${p.kills}</b></div>`).join('');
  }
  if (me) {
    const pw = [];
    if (me.triple > 0) pw.push(['Triple', me.triple, PICKUP_INFO.triple.color]);
    if (me.speed > 0) pw.push(['Velocidad', me.speed, PICKUP_INFO.speed.color]);
    if (me.shield > 0) pw.push(['Escudo', me.shield, PICKUP_INFO.shield.color]);
    $('powerups').innerHTML = pw.map(([n, t, c]) => `<div style="--c:${c}">${n} ${Math.ceil(t)}s</div>`).join('');
  }
  drawMinimap();
}

const clock = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function updateModeHud() {
  const md = view.md, mode = md ? md.m : S.settings.mode;
  const timer = $('timer');
  timer.classList.remove('bomb');
  $('teamScore').hidden = !MODES[mode].teams;
  if (md && MODES[mode].teams) {
    const t = i => `<span class="t${i}"><small>${teamName(i).toUpperCase()}</small> ${md.sc[i]}</span>`;
    $('teamScore').innerHTML = `${t(0)}<span class="vs">–</span>${t(1)}`;
  }
  if (MODES[mode].race && md) {
    if (md.ph === 'freeze') { timer.textContent = md.pt > 3 ? 'Preparados' : String(Math.ceil(md.pt)); }
    else timer.textContent = clock(md.rt);
    $('goal').textContent = md.endT >= 0 ? `¡Fin de la carrera en ${Math.ceil(md.endT)} s!`
      : mode === 'kart' ? `${MODES.kart.label} · ${md.goal} ${md.goal === 1 ? 'vuelta' : 'vueltas'}` : MODES.parkour.label;
  } else if (mode === 'bomb' && md) {
    const b = md.bomb;
    if (md.ph === 'freeze') timer.textContent = 'Preparados · ' + Math.ceil(md.pt);
    else if (b[0] === 'planted') { timer.textContent = '💣 ' + clock(b[5]); timer.classList.add('bomb'); }
    else if (md.ph === 'post') timer.textContent = 'Fin de ronda';
    else timer.textContent = clock(md.rt);
    $('goal').textContent = `Ronda ${md.rd} · Atacan los ${teamName(md.atk)} · Gana quien llegue a ${md.goal} rondas`;
  } else {
    timer.textContent = clock(Math.max(0, view.timeLimit - view.time));
    $('goal').textContent = mode === 'tdm' ? `Objetivo: ${S.settings.goal} bajas por equipo` : `Objetivo: ${S.settings.goal} bajas`;
  }
}

// Aviso de «mantén E» y barra de progreso al plantar o desactivar
function updateAction(me) {
  const md = view.md;
  let text = '', prog = -1;
  if (md && md.m === 'bomb' && me && me.alive && md.ph === 'live') {
    const [st, bx, bz, carrier, , , p, by] = md.bomb;
    const inSite = SITES.some(s => Math.hypot(s.x - me.x, s.z - me.z) < BOMB.siteR);
    if (st === 'carried' && carrier === S.myId) {
      text = inSite ? 'Mantén <kbd>E</kbd> quieto para plantar la bomba' : '💣 Llevas la bomba: ve al punto A o B';
      if (p > 0) prog = p / BOMB.plantTime;
    } else if (st === 'planted' && me.team !== md.atk && Math.hypot(bx - me.x, bz - me.z) < BOMB.useR + 0.4) {
      text = 'Mantén <kbd>E</kbd> quieto para desactivar';
      if (by === S.myId) prog = p / BOMB.defuseTime;
    }
  }
  $('action').hidden = !text;
  if (text && $('actionText').innerHTML !== text) $('actionText').innerHTML = text;
  $('actionBar').hidden = prog < 0;
  if (prog >= 0) $('actionBar').firstElementChild.style.width = Math.min(100, prog * 100) + '%';
}

// Pitidos de la bomba plantada: cada vez más rápidos
let beepT = 0;
function bombBeeps(dt) {
  const md = view.md;
  if (!md || md.m !== 'bomb' || md.bomb[0] !== 'planted' || S.phase !== 'playing') { beepT = 0; return; }
  beepT -= dt;
  if (beepT <= 0) { const left = md.bomb[5]; beepT = left > 20 ? 1 : left > 10 ? 0.6 : left > 5 ? 0.35 : 0.18; sfx.beep(); }
}

const mm = $('minimap').getContext('2d');
// Minimapa de los minijuegos: el circuito o el recorrido visto desde arriba
function drawRaceMap(md) {
  const W = 200;
  mm.clearRect(0, 0, W, W);
  let X, Z;
  if (md.m === 'kart') {
    const xs = TRACK.pts.map(p => p.x), zs = TRACK.pts.map(p => p.z);
    const minX = Math.min(...xs) - 8, maxX = Math.max(...xs) + 8, minZ = Math.min(...zs) - 8, maxZ = Math.max(...zs) + 8;
    const sc = (W - 10) / Math.max(maxX - minX, maxZ - minZ);
    X = x => 5 + (x - minX) * sc; Z = z => 5 + (z - minZ) * sc;
    mm.strokeStyle = '#2a3170'; mm.lineWidth = 7; mm.lineJoin = 'round';
    mm.beginPath(); TRACK.pts.forEach((p, i) => i ? mm.lineTo(X(p.x), Z(p.z)) : mm.moveTo(X(p.x), Z(p.z))); mm.closePath(); mm.stroke();
    const st = TRACK.pts[0]; mm.fillStyle = '#fff'; mm.fillRect(X(st.x) - 1.5, Z(st.z) - 5, 3, 10);
  } else {
    // el recorrido es largo: se gira para que vaya de abajo (salida) a arriba (meta)
    const sc = (W - 10) / 200;
    X = x => W / 2 + x * sc * 2.2; Z = z => W - 8 + (z - 8) * sc;
    for (const p of COURSE.plats) {
      mm.fillStyle = { cp: '#ffd40099', finish: '#ffd400', fall: '#ff6a1f88', move: '#ff2bd688', bounce: '#39ff6a99' }[p.type] || '#2a3170';
      mm.fillRect(X(p.x - p.w / 2), Z(p.z - p.d / 2), Math.max(2, p.w * sc * 2.2), Math.max(2, p.d * sc));
    }
  }
  for (const p of view.players.values()) {
    const me = p.id === S.myId;
    mm.beginPath(); mm.arc(X(p.x), Z(p.z), me ? 5 : 3.5, 0, Math.PI * 2);
    mm.fillStyle = p.color; mm.fill();
    if (me) { mm.strokeStyle = '#fff'; mm.lineWidth = 2; mm.stroke(); }
  }
}

function drawMinimap() {
  if (view.md && MODES[view.md.m] && MODES[view.md.m].race) return drawRaceMap(view.md);
  const W = 200, s = W / (HALF * 2), X = x => (x + HALF) * s;
  mm.clearRect(0, 0, W, W);
  mm.fillStyle = '#2a3170';
  for (const b of BOXES) mm.fillRect(X(b.x - b.w / 2), X(b.z - b.d / 2), b.w * s, b.d * s);
  PICKUP_SPOTS.forEach((k, i) => { if (!view.pickups[i]) return; mm.fillStyle = PICKUP_INFO[k.type].color; mm.fillRect(X(k.x) - 2, X(k.z) - 2, 4, 4); });
  const md = view.md;
  if (md && md.m === 'bomb') {
    // puntos A y B
    mm.font = '700 13px Orbitron, sans-serif'; mm.textAlign = 'center'; mm.textBaseline = 'middle';
    for (const st of SITES) {
      mm.strokeStyle = '#ffd40088'; mm.lineWidth = 1.5;
      mm.beginPath(); mm.arc(X(st.x), X(st.z), BOMB.siteR * s, 0, Math.PI * 2); mm.stroke();
      mm.fillStyle = '#ffd400'; mm.fillText(st.name, X(st.x), X(st.z));
    }
    // la bomba: siempre si está en el suelo o plantada; si la llevan, solo la ve el ataque
    const [stt, bx, bz, carrier] = md.bomb, me = view.players.get(S.myId);
    let pos = null;
    if (stt === 'planted' || stt === 'dropped') pos = [bx, bz];
    else if (stt === 'carried' && me && me.team === md.atk) { const c = view.players.get(carrier); if (c) pos = [c.x, c.z]; }
    if (pos && (stt !== 'planted' || Math.floor(performance.now() / 300) % 2)) {
      mm.fillStyle = '#ff3355'; mm.fillRect(X(pos[0]) - 4, X(pos[1]) - 4, 8, 8);
    }
  }
  for (const p of view.players.values()) {
    if (!p.alive) continue;
    const me = p.id === S.myId;
    mm.beginPath(); mm.arc(X(p.x), X(p.z), me ? 5 : 3.5, 0, Math.PI * 2);
    mm.fillStyle = p.color; mm.fill();
    if (me) { mm.strokeStyle = '#fff'; mm.lineWidth = 2; mm.stroke(); }
  }
}

// Tabla de jugadores; en los modos por equipos, agrupada por equipo con su marcador
function playerTable(list, score, numbered) {
  const row = (p, i) => `<tr class="${p.id === S.myId ? 'me' : ''}">${numbered ? `<td>${i + 1}</td>` : ''}<td><span class="dot" style="--c:${p.color}"></span>${esc(p.name)}</td><td class="n">${p.kills}</td><td class="n">${p.deaths}</td></tr>`;
  const head = `<tr>${numbered ? '<th>#</th>' : ''}<th>Jugador</th><th class="n">Bajas</th><th class="n">Muertes</th></tr>`;
  const sorted = list.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  if (!score) return head + sorted.map(row).join('');
  return head + [0, 1].map(t => `<tr class="team-row" style="--c:${TEAMS[t].color}"><td colspan="${numbered ? 2 : 1}">${TEAMS[t].name.toUpperCase()}</td><td class="n" colspan="2">${score[t]}</td></tr>` +
    sorted.filter(p => p.team === t).map(row).join('')).join('');
}
// Tabla de carrera: posición y tiempo (y caídas en el parkour)
function raceTable(list, mode) {
  const falls = mode === 'parkour';
  return `<tr><th>#</th><th>Jugador</th><th class="n">Tiempo</th>${falls ? '<th class="n">Caídas</th>' : ''}</tr>` +
    list.map((p, i) => `<tr class="${p.id === S.myId ? 'me' : ''}"><td>${i + 1}</td><td><span class="dot" style="--c:${p.color}"></span>${esc(p.name)}</td><td class="n">${fmtTime(p.time != null ? p.time : p.fin)}</td>${falls ? `<td class="n">${p.deaths}</td>` : ''}</tr>`).join('');
}
function renderScoreboard() {
  const md = view.md;
  if (md && MODES[md.m] && MODES[md.m].race) {
    $('scoreTable').innerHTML = raceTable((md.order || []).map(id => view.players.get(id)).filter(Boolean), md.m);
    return;
  }
  $('scoreTable').innerHTML = playerTable([...view.players.values()], md && MODES[md.m].teams ? md.sc : null, false);
}

// ================== Flujo de partida ==================
function enterGame() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  S.phase = 'playing'; S.paused = false;
  view.victory = null; view.focus = null; view.players.clear(); view.bullets = []; view.md = null;
  firstBlood = false; streak = 0; $('killfeed').innerHTML = '';
  renderer.clearAll();
  hideScreens();
  $('hud').hidden = false; $('scoreboard').hidden = true;
  document.body.classList.add('playing');
  initAudio(); startMusic();
  announce('¡A luchar!', 1200);
}

function onEnd(msg) {
  S.phase = 'over';
  input.fire = false;
  const teams = MODES[msg.mode] && MODES[msg.mode].teams;
  const myTeam = (msg.ranking.find(p => p.id === S.myId) || {}).team;
  // celebran el ganador (o todo el equipo ganador)
  view.victory = new Set(teams ? msg.ranking.filter(p => p.team === msg.winnerTeam).map(p => p.id) : [msg.winner]);
  const won = teams ? msg.winnerTeam === myTeam : msg.winner === S.myId;
  won ? sfx.win() : sfx.lose();
  stopMusic();
  const w = msg.ranking[0];
  if (MODES[msg.mode] && MODES[msg.mode].race) {
    $('endTitle').innerHTML = won ? '¡Has ganado la carrera! 🏆' : (w ? `<span style="color:${w.color}">${esc(w.name)}</span> gana la carrera` : 'Fin de la carrera');
  } else if (teams) {
    const t = TEAMS[msg.winnerTeam];
    $('endTitle').innerHTML = msg.winnerTeam < 0 ? `Empate · ${msg.score[0]} – ${msg.score[1]}`
      : `${won ? '¡Habéis ganado!' : `Ganan los <span style="color:${t.color}">${t.name}</span>`} · ${msg.score[0]} – ${msg.score[1]}`;
  } else $('endTitle').innerHTML = won ? '¡Has ganado!' : (w ? `<span style="color:${w.color}">${esc(w.name)}</span> gana` : 'Fin');
  $('endTable').innerHTML = MODES[msg.mode] && MODES[msg.mode].race ? raceTable(msg.ranking, msg.mode) : playerTable(msg.ranking, teams ? msg.score : null, !teams);
  const canRestart = S.mode !== 'guest';
  $('btnAgain').hidden = !canRestart;
  $('endHint').textContent = canRestart ? '' : 'Esperando a que el anfitrión pida revancha…';
  $('btnEndMenu').textContent = S.mode === 'solo' ? 'Menú' : 'Salir de la sala';
  setTimeout(() => {
    if (S.phase !== 'over') return;
    closeChat(); document.body.classList.remove('playing'); $('hud').hidden = true; show('end');
  }, 3500);
}

function togglePause() {
  const on = !$('pause').classList.contains('active');
  $('pause').classList.toggle('active', on);
  S.paused = on && S.mode === 'solo';
  document.body.classList.toggle('playing', !on);
  if (on) input.fire = false;
}

function leave(msg) {
  const peer = S.peer, hc = S.hostConn;
  S.peer = null; S.hostConn = null;
  for (const c of S.conns.values()) { try { c.close(); } catch (e) {} }
  S.conns.clear();
  try { hc && hc.close(); } catch (e) {}
  try { peer && peer.destroy(); } catch (e) {}
  S.mode = null; S.phase = 'menu'; S.game = null; S.roster = []; S.paused = false;
  clearChat();
  resetGuestState();
  view.players.clear(); view.bullets = []; view.victory = null; view.md = null; view.focus = { x: 0, z: 0 };
  renderer.clearAll();
  $('hud').hidden = true; document.body.classList.remove('playing');
  stopMusic();
  show('menu');
  if (msg) toast(msg);
  if (location.search) history.replaceState(null, '', location.pathname);
}

// ---------- Solo ----------
function startSolo() {
  savePrefs();
  S.mode = 'solo'; S.myId = 'h';
  S.settings = { mode: prefs.mode, goal: goalFor(prefs.mode), difficulty: prefs.diff };
  S.roster = [{ id: 'h', name: myName(), color: COLORS[prefs.color], pcolor: COLORS[prefs.color], team: 0, bot: false, char: CHARACTERS[0].id }];
  for (let i = 0; i < prefs.bots; i++) addBotToRoster();
  enterGame();
  startLocalGame();
}

function addBotToRoster() {
  const used = new Set(S.roster.map(r => r.color));
  const names = new Set(S.roster.map(r => r.name));
  const usedP = new Set(S.roster.map(r => r.pcolor));
  const color = COLORS.find(c => !usedP.has(c)) || COLORS[S.roster.length % COLORS.length];
  const name = BOT_NAMES.find(n => !names.has(n)) || 'Bot ' + (S.botSeq + 1);
  S.roster.push({ id: 'b' + (++S.botSeq), name, color, pcolor: color, team: smallerTeam(), bot: true, char: CHARACTERS[S.botSeq % CHARACTERS.length].id });
  applyTeamColors();
}

// Equipos: el que tenga menos jugadores
function smallerTeam() {
  const n = [0, 1].map(t => S.roster.filter(r => r.team === t).length);
  return n[1] < n[0] ? 1 : 0;
}
// En los modos por equipos todos llevan el color de su equipo; en el resto, el suyo
function applyTeamColors() {
  for (const r of S.roster) r.color = isTeams() ? TEAMS[r.team].color : (r.pcolor || r.color);
}
// Si un equipo se queda vacío al cambiar de modo, se reparten de nuevo
function balanceTeams() {
  const n = [0, 1].map(t => S.roster.filter(r => r.team === t).length);
  if (S.roster.length >= 2 && (n[0] === 0 || n[1] === 0)) S.roster.forEach((r, i) => { r.team = i % 2; });
}

// ---------- Anfitrión ----------
function peerOk() { if (window.Peer) return true; toast('No se pudo cargar el módulo online. Revisa tu conexión.'); return false; }
function genCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }

function createRoom() {
  if (!peerOk()) return;
  savePrefs(); initAudio();
  const code = genCode();
  $('waitText').textContent = 'Creando sala…'; show('wait');
  const p = new Peer(PREFIX + code, { debug: 0 });
  S.peer = p;
  p.on('open', () => {
    if (S.peer !== p) return;
    S.mode = 'host'; S.code = code; S.myId = 'h'; S.phase = 'lobby';
    S.settings = { mode: prefs.mode, goal: goalFor(prefs.mode), difficulty: prefs.diff };
    S.roster = [{ id: 'h', name: myName(), color: COLORS[prefs.color], pcolor: COLORS[prefs.color], team: 0, bot: false, char: CHARACTERS[0].id }];
    applyTeamColors();
    showLobby();
  });
  p.on('connection', conn => { if (S.peer === p) acceptGuest(conn); });
  p.on('disconnected', () => { if (S.peer === p && !p.destroyed) { try { p.reconnect(); } catch (e) {} } });
  p.on('error', e => {
    if (S.peer !== p) return;
    if (e.type === 'unavailable-id') { S.peer = null; p.destroy(); return createRoom(); }
    if (e.type === 'peer-unavailable') return;
    if (S.mode !== 'host') leave('No se pudo crear la sala (' + e.type + ')');
    else toast('Problema de conexión (' + e.type + ')');
  });
}

function broadcast(msg) { for (const c of S.conns.values()) if (c.open) { try { c.send(msg); } catch (e) {} } }

function sendLobby() {
  for (const [id, c] of S.conns) if (c.open) c.send({ t: 'lobby', roster: S.roster, you: id, code: S.code, settings: S.settings });
}

function acceptGuest(conn) {
  conn.on('data', m => {
    if (!m || typeof m !== 'object' || S.mode !== 'host') return;
    if (m.t === 'hello' && !conn.pid) {
      if (S.roster.length >= MAX_PLAYERS) {
        // si hay bots, se sustituye uno por el jugador
        const bi = S.roster.findIndex(r => r.bot);
        if (bi < 0) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 500); return; }
        const [bot] = S.roster.splice(bi, 1);
        if (S.game) S.game.removePlayer(bot.id);
      }
      const id = 'g' + (++S.guestSeq);
      conn.pid = id;
      const used = new Set(S.roster.map(r => r.color));
      let color = COLORS.includes(m.color) && !used.has(m.color) ? m.color : (COLORS.find(c => !used.has(c)) || COLORS[0]);
      const r = { id, name: String(m.name || 'Jugador').slice(0, 14), color, pcolor: color, team: smallerTeam(), bot: false, char: CHARACTERS[0].id };
      S.roster.push(r); S.conns.set(id, conn);
      applyTeamColors();
      sfx.spawn();
      sysChat(r.name + ' se ha unido');
      if (S.phase === 'playing' || S.phase === 'over') {
        if (S.phase === 'playing') S.game.addPlayer(id, r.name, r.color, false, r.team);
        broadcast({ t: 'roster', roster: S.roster });
        conn.send({ t: 'start', roster: S.roster, you: id, settings: S.settings });
      } else showLobby();
    } else if (m.t === 'in' && conn.pid && S.game) {
      S.game.setInput(conn.pid, m);
    } else if (m.t === 'team' && conn.pid && S.phase === 'lobby' && isTeams()) {
      // un invitado pide cambiarse de equipo
      const r = S.roster.find(r => r.id === conn.pid);
      if (r) { r.team = 1 - r.team; applyTeamColors(); showLobby(); }
    } else if (m.t === 'chat' && conn.pid && typeof m.text === 'string') {
      const now = performance.now();
      if (now - (conn.lastChat || 0) < 400) return;
      conn.lastChat = now;
      const text = m.text.trim().slice(0, CHAT_MAX);
      if (text) hostChat(conn.pid, text);
    }
  });
  const drop = () => {
    if (!conn.pid || !S.conns.has(conn.pid)) return;
    S.conns.delete(conn.pid);
    const i = S.roster.findIndex(r => r.id === conn.pid);
    if (i >= 0) { sysChat(S.roster[i].name + ' ha salido'); S.roster.splice(i, 1); }
    if (S.game) S.game.removePlayer(conn.pid);
    if (S.phase === 'lobby') showLobby(); else broadcast({ t: 'roster', roster: S.roster });
  };
  conn.on('close', drop);
  conn.on('error', drop);
}

function teamsReady() {
  if (!isTeams()) return S.roster.length >= 2;
  return [0, 1].every(t => S.roster.some(r => r.team === t));
}

function hostStart() {
  if (!teamsReady()) return;
  applyTeamColors();
  S.phase = 'playing';
  for (const [id, c] of S.conns) if (c.open) c.send({ t: 'start', roster: S.roster, you: id, settings: S.settings });
  enterGame();
  startLocalGame();
}

// ---------- Invitado ----------
function joinRoom(raw) {
  const code = raw.trim().toUpperCase();
  if (code.length !== 5) { toast('El código tiene 5 caracteres'); return; }
  if (!peerOk()) return;
  savePrefs(); initAudio();
  $('waitText').textContent = 'Conectando a la sala ' + code + '…'; show('wait');
  const p = new Peer({ debug: 0 });
  S.peer = p; S.mode = 'guest'; S.guestSeq = 0;
  const fail = setTimeout(() => { if (S.peer === p && !(S.hostConn && S.hostConn.open)) leave('No se pudo conectar. ¿Es correcto el código?'); }, 15000);
  p.on('open', () => {
    if (S.peer !== p) return;
    const c = p.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    S.hostConn = c;
    c.on('open', () => { clearTimeout(fail); S.code = code; c.send({ t: 'hello', name: myName(), color: COLORS[prefs.color] }); });
    c.on('data', m => { if (S.hostConn === c && m && typeof m === 'object') onHostData(m); });
    c.on('close', () => { if (S.hostConn === c) leave('Se perdió la conexión con el anfitrión'); });
  });
  p.on('error', e => {
    if (S.peer !== p) return;
    clearTimeout(fail);
    leave(e.type === 'peer-unavailable' ? 'Sala no encontrada' : 'Error de conexión (' + e.type + ')');
  });
}

function onHostData(m) {
  switch (m.t) {
    case 'lobby':
      S.myId = m.you; S.roster = m.roster; S.settings = m.settings; S.code = m.code;
      if (S.phase !== 'lobby') { S.phase = 'lobby'; renderer.clearAll(); $('hud').hidden = true; document.body.classList.remove('playing'); stopMusic(); }
      showLobby();
      break;
    case 'start':
      if (m.you) S.myId = m.you;
      S.roster = m.roster; S.settings = m.settings;
      resetGuestState();
      view.timeLimit = (MODES[m.settings.mode] || MODES.ffa).time;
      enterGame();
      break;
    case 'roster': S.roster = m.roster; break;
    case 'chat': addChat(m); break;
    case 's': if (S.phase === 'playing') onSnapshot(m); break;
    case 'end': onEnd(m); break;
    case 'full': leave('La sala está llena (máximo ' + MAX_PLAYERS + ')'); break;
  }
}

// ---------- Sala ----------
function showLobby() {
  S.phase = 'lobby';
  const isHost = S.mode === 'host';
  if (isHost) sendLobby();
  $('roomCode').textContent = S.code;
  $('rosterCount').textContent = `(${S.roster.length}/${MAX_PLAYERS})`;
  const teams = isTeams();
  const item = r => {
    // en equipos: el anfitrión cambia a cualquiera de equipo; cada invitado, a sí mismo
    const canSwap = teams && (isHost || r.id === S.myId);
    const badge = teams ? `<button class="team-btn" data-team="${r.id}" ${canSwap ? 'title="Cambiar de equipo"' : 'disabled'}>${teamName(r.team)}${canSwap ? ' ⇄' : ''}</button>` : '';
    return `<li style="--c:${r.color}"><i></i><span>${esc(r.name)}</span>` +
      `<em>${r.id === 'h' ? 'Anfitrión' : r.bot ? 'Bot' : ''}${r.id === S.myId ? ' · Tú' : ''}</em>${badge}` +
      (isHost && r.bot ? `<button data-rm="${r.id}" aria-label="Quitar bot">✕</button>` : '') + '</li>';
  };
  $('roster').innerHTML = teams
    ? [0, 1].map(t => `<li class="team-head" style="--c:${TEAMS[t].color}">${TEAMS[t].name.toUpperCase()}</li>` + S.roster.filter(r => r.team === t).map(item).join('')).join('')
    : S.roster.map(item).join('');
  $('btnAddBot').hidden = !isHost; $('btnStart').hidden = !isHost;
  $('btnAddBot').disabled = S.roster.length >= MAX_PLAYERS;
  $('btnStart').disabled = !teamsReady();
  const mode = S.settings.mode;
  renderSeg('lobMode', Object.entries(MODES).map(([k, v]) => [k, v.short]), mode, isHost ? v => {
    S.settings.mode = v; S.settings.goal = goalFor(v); prefs.mode = v; savePrefs();
    balanceTeams(); applyTeamColors(); showLobby();
  } : null);
  $('lobModeDesc').textContent = MODE_DESC[mode];
  $('lobGoalRow').hidden = !MODES[mode].goals;
  $('lobGoalLabel').textContent = MODES[mode].goalLabel || '';
  renderSeg('lobDiff', Object.entries(DIFFICULTY).map(([k, v]) => [k, v.label]), S.settings.difficulty, isHost ? v => { S.settings.difficulty = v; prefs.diff = v; showLobby(); } : null);
  renderSeg('lobKills', (MODES[mode].goals || []).map(k => [k, String(k)]), S.settings.goal, isHost ? v => { S.settings.goal = v; prefs.goals[mode] = v; savePrefs(); showLobby(); } : null);
  $('lobbyHint').textContent = isHost
    ? (S.roster.length < 2 ? 'Invita a tus amigos con el código o añade bots.'
      : !teamsReady() ? 'Cada equipo necesita al menos un jugador o un bot.'
      : 'Pulsa Empezar cuando estéis listos. Se puede entrar a mitad de partida.')
    : 'Esperando a que el anfitrión empiece la partida…';
  show('lobby');
}

// ================== Menús ==================
function renderSeg(id, opts, cur, onPick) {
  const el = $(id);
  el.innerHTML = opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}" ${onPick ? '' : 'disabled'}>${l}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if (!b || !onPick) return; sfx.click(); const v = b.dataset.v; onPick(isNaN(+v) ? v : +v); };
}
function renderSoloSetup() {
  renderSeg('segMode', Object.entries(MODES).map(([k, v]) => [k, v.short]), prefs.mode, v => { prefs.mode = v; savePrefs(); renderSoloSetup(); });
  $('soloModeDesc').textContent = MODE_DESC[prefs.mode] + (MODES[prefs.mode].teams ? ' Los bots se reparten entre tu equipo y el rival.' : '');
  $('soloGoalRow').hidden = !MODES[prefs.mode].goals;
  $('soloGoalLabel').textContent = MODES[prefs.mode].goalLabel || '';
  renderSeg('segBots', [1, 2, 3, 4, 5, 6, 7].map(n => [n, String(n)]), prefs.bots, v => { prefs.bots = v; renderSoloSetup(); });
  renderSeg('segDiff', Object.entries(DIFFICULTY).map(([k, v]) => [k, v.label]), prefs.diff, v => { prefs.diff = v; renderSoloSetup(); });
  renderSeg('segKills', (MODES[prefs.mode].goals || []).map(k => [k, String(k)]), goalFor(prefs.mode), v => { prefs.goals[prefs.mode] = v; savePrefs(); renderSoloSetup(); });
}
function renderSwatches() {
  $('swatches').innerHTML = COLORS.map((c, i) => `<button style="--c:${c}" class="${i === prefs.color ? 'on' : ''}" data-i="${i}" aria-label="Color ${i + 1}"></button>`).join('');
}

function wireMenus() {
  // el apodo no se guarda: en un ordenador compartido cada uno escribe el suyo
  try { localStorage.removeItem('na.name'); } catch (e) {}
  renderSwatches();
  $('swatches').onclick = e => { const b = e.target.closest('button'); if (!b) return; prefs.color = +b.dataset.i; savePrefs(); renderSwatches(); };
  for (const id of ['quality', 'quality2']) {
    $(id).value = prefs.quality;
    $(id).onchange = () => {
      prefs.quality = $(id).value; $('quality').value = $('quality2').value = prefs.quality; savePrefs();
      const reload = renderer.setQuality(prefs.quality);
      toast('Gráficos: ' + QUALITY_NAMES[prefs.quality] + (reload ? '. Recarga la página para aplicarlo del todo.' : ''));
    };
  }
  for (const id of ['volume', 'volume2']) {
    $(id).value = prefs.volume;
    $(id).oninput = () => { prefs.volume = +$(id).value; $('volume').value = $('volume2').value = prefs.volume; setVolume(prefs.volume); savePrefs(); };
  }
  for (const id of ['showFps', 'showFps2']) {
    $(id).checked = prefs.fps;
    $(id).onchange = () => { prefs.fps = $(id).checked; $('showFps').checked = $('showFps2').checked = prefs.fps; $('fps').hidden = !prefs.fps; savePrefs(); };
  }
  $('fps').hidden = !prefs.fps;
  $('emoteHint').innerHTML = EMOTES.map((e, i) => `<kbd>${i + 1}</kbd>${e.icon}`).join(' ');
  $('emoteHint').title = EMOTES.map((e, i) => `${i + 1}: ${e.label}`).join(' · ');
  $('music').checked = prefs.music;
  $('music').onchange = () => { prefs.music = $('music').checked; setMusic(prefs.music); savePrefs(); };
  setVolume(prefs.volume); setMusic(prefs.music);

  $('btnSolo').onclick = () => { initAudio(); sfx.click(); renderSoloSetup(); show('solo'); };
  $('btnSoloGo').onclick = startSolo;
  $('btnCreate').onclick = createRoom;
  $('btnJoin').onclick = () => joinRoom($('code').value);
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('code').value); });
  for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => { if (S.mode) leave(); else show('menu'); };
  $('btnAddBot').onclick = () => { if (S.mode !== 'host' || S.roster.length >= MAX_PLAYERS) return; addBotToRoster(); showLobby(); };
  $('roster').onclick = e => {
    const tb = e.target.closest('[data-team]');
    if (tb && isTeams()) {
      const id = tb.dataset.team;
      if (S.mode === 'host') { const r = S.roster.find(r => r.id === id); if (r) { r.team = 1 - r.team; applyTeamColors(); showLobby(); } }
      else if (id === S.myId && S.hostConn && S.hostConn.open) S.hostConn.send({ t: 'team' });
      return;
    }
    const b = e.target.closest('[data-rm]'); if (!b || S.mode !== 'host') return;
    S.roster = S.roster.filter(r => r.id !== b.dataset.rm); showLobby();
  };
  $('btnStart').onclick = hostStart;
  $('btnCopy').onclick = async () => {
    const url = location.origin + location.pathname + '?sala=' + S.code;
    const text = `¡Únete a mi partida de Neón Arena! Código: ${S.code}\n${url}`;
    try { await navigator.clipboard.writeText(text); toast('Invitación copiada. Pégala en WhatsApp o Discord.'); }
    catch (e) { toast('Comparte este enlace: ' + url); }
  };
  $('chatInput').addEventListener('keydown', e => {
    e.stopPropagation(); // las teclas del chat no llegan al juego
    if (e.key === 'Enter') { e.preventDefault(); sendChat($('chatInput').value); closeChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });
  $('chatInput').addEventListener('blur', () => setTimeout(closeChat, 0));
  $('lobbyChatInput').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); sendChat($('lobbyChatInput').value); $('lobbyChatInput').value = ''; }
    else if (e.key === 'Escape') $('lobbyChatInput').blur();
  });
  $('btnResume').onclick = togglePause;
  $('btnLeave').onclick = () => { $('pause').classList.remove('active'); leave(); };
  $('btnEndMenu').onclick = () => leave();
  $('btnAgain').onclick = () => {
    if (S.mode === 'solo') { enterGame(); startLocalGame(); }
    else if (S.mode === 'host') {
      S.game = null; renderer.clearAll(); $('hud').hidden = true; document.body.classList.remove('playing'); stopMusic();
      showLobby();
    }
  };
}

// ================== Bucle principal ==================
let lastFrame = performance.now();
const perf = { frames: 0, t: 0, slow: 0, warned: false };
function trackFps(rawDt) {
  perf.frames++; perf.t += rawDt;
  if (perf.t < 1) return;
  const fps = Math.round(perf.frames / perf.t);
  perf.frames = 0; perf.t = 0;
  if (prefs.fps) $('fps').textContent = fps + ' FPS';
  // si va a tirones varios segundos seguidos, sugerir bajar los gráficos
  if (S.phase === 'playing' && !document.hidden) {
    perf.slow = fps < 28 ? perf.slow + 1 : 0;
    const lower = { alta: 'Media', media: 'Baja', baja: 'Patata' }[prefs.quality];
    if (perf.slow >= 5 && lower && !perf.warned) {
      perf.warned = true;
      toast(`¿Va a tirones (${fps} FPS)? Pulsa Esc y pon los gráficos en «${lower}».`);
    }
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - lastFrame) / 1000;
  const dt = Math.min(0.05, rawDt); lastFrame = now;
  trackFps(rawDt);
  if (S.phase === 'playing' || S.phase === 'over') {
    if (S.mode === 'guest') guestFrame(dt);
    else if (S.game) viewFromGame();
    const me = view.players.get(S.myId);
    const [ax, az] = isRaceMode() ? [0, 0] : updateAim(me);
    if (view.victory) {
      const w = view.players.get([...view.victory][0]);
      if (w) view.focus = { x: w.x, z: w.z };
    } else if (me && !me.alive && me.respawnT < 0) {
      // eliminado en modo bomba: ver la ronda desde un compañero vivo
      const mate = [...view.players.values()].find(p => p.alive && p.team === me.team);
      const f = mate || me;
      view.focus = { x: f.x, z: f.z };
    } else if (me) view.focus = { x: me.x, z: me.z, y: me.y || 0, h: me.aim, ax: me.alive ? ax : 0, az: me.alive ? az : 0 };
    updateHud(dt);
  } else {
    // fondo del menú: la arena vacía girando
    view.players.clear(); view.bullets = [];
    view.focus = { x: Math.sin(now / 6000) * 6, z: Math.cos(now / 6000) * 6 };
  }
  renderer.update(view, dt, S.myId);
}

// ================== Arranque ==================
async function boot() {
  savePrefs();
  renderer = new Renderer($('scene'), prefs.quality);
  try {
    await renderer.load(f => { $('loadBar').style.width = Math.round(f * 100) + '%'; });
  } catch (e) {
    $('loadText').textContent = 'No se pudieron cargar los modelos. Si abriste el archivo directamente, usa la web de GitHub Pages o un servidor local.';
    console.error(e);
    return;
  }
  try { await document.fonts.ready; } catch (e) {}
  wireMenus();
  show('menu');
  requestAnimationFrame(frame);
  const invite = new URLSearchParams(location.search).get('sala');
  if (invite) { $('code').value = invite.toUpperCase().slice(0, 5); toast('Te han invitado a la sala ' + $('code').value + '. Escribe tu nombre y pulsa Unirse.'); }
}
window.__na = { S, view, get renderer() { return renderer; } };
boot();
