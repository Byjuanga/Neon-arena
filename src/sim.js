// Simulación del juego (la ejecuta el anfitrión). Sin dependencias de dibujo.
import {
  HALF, PLAYER_R, MAX_HP, SPEED, SPEED_BOOST, DASH_SPEED, DASH_TIME, DASH_CD, FIRE_CD,
  BULLET_SPEED, BULLET_DMG, BULLET_LIFE, BULLET_R, RESPAWN_TIME, SPAWN_SHIELD, POWER_TIME,
  PICKUP_RESPAWN, BOXES, SPAWNS, PICKUP_SPOTS, DIFFICULTY, EMOTES, MODES, BOMB, SITES, TEAM_SPAWNS,
} from './config.js';

// ---------- Geometría compartida (también la usa la predicción del cliente) ----------
export function moveCircle(x, z, dx, dz, r) {
  x += dx; z += dz;
  for (let it = 0; it < 2; it++) {
    for (const b of BOXES) {
      const hx = b.w / 2, hz = b.d / 2;
      const cx = Math.max(b.x - hx, Math.min(x, b.x + hx));
      const cz = Math.max(b.z - hz, Math.min(z, b.z + hz));
      let ox = x - cx, oz = z - cz;
      const d2 = ox * ox + oz * oz;
      if (d2 < r * r) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), push = r - d;
          x += ox / d * push; z += oz / d * push;
        } else {
          // centro dentro de la caja: salir por el lado más cercano
          const px = hx - Math.abs(x - b.x) + r, pz = hz - Math.abs(z - b.z) + r;
          if (px < pz) x += Math.sign(x - b.x || 1) * px; else z += Math.sign(z - b.z || 1) * pz;
        }
      }
    }
  }
  const lim = HALF - r;
  x = Math.max(-lim, Math.min(lim, x));
  z = Math.max(-lim, Math.min(lim, z));
  return [x, z];
}

export function pointBlocked(x, z, pad = 0) {
  if (Math.abs(x) > HALF - pad || Math.abs(z) > HALF - pad) return true;
  for (const b of BOXES) {
    if (Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad) return true;
  }
  return false;
}

// ¿Hay línea de visión entre dos puntos? (método de las losas sobre cada caja)
export function lineOfSight(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  for (const b of BOXES) {
    let tmin = 0, tmax = 1;
    const mins = [b.x - b.w / 2, b.z - b.d / 2], maxs = [b.x + b.w / 2, b.z + b.d / 2];
    const o = [x1, z1], d = [dx, dz];
    let hit = true;
    for (let i = 0; i < 2; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < mins[i] || o[i] > maxs[i]) { hit = false; break; } }
      else {
        let t1 = (mins[i] - o[i]) / d[i], t2 = (maxs[i] - o[i]) / d[i];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { hit = false; break; }
      }
    }
    if (hit) return false;
  }
  return true;
}

// Bit flags que viajan en los snapshots
export const F = { MOVING: 1, DASH: 2, SHIELD: 4, TRIPLE: 8, SPEED: 16, INVUL: 32, ACT: 64 };

// ---------- Juego ----------
// mode: 'ffa' (todos contra todos), 'tdm' (equipos a bajas) o 'bomb' (plantar y desactivar)
// goal: bajas para ganar (ffa/tdm) o rondas para ganar (bomb)
export class Game {
  constructor({ mode = 'ffa', goal, difficulty = 'normal' } = {}) {
    this.mode = MODES[mode] ? mode : 'ffa';
    this.teams = MODES[this.mode].teams;
    this.goal = goal || MODES[this.mode].def;
    this.timeLimit = MODES[this.mode].time;
    this.difficulty = difficulty;
    this.players = new Map();
    this.bullets = [];
    this.pickups = PICKUP_SPOTS.map((s, i) => ({ id: i, ...s, active: true, t: 0 }));
    this.time = 0;
    this.state = 'playing';
    this.winner = null;      // id del ganador (ffa)
    this.winnerTeam = -1;    // equipo ganador (equipos); -1 = empate
    this.score = [0, 0];     // bajas por equipo (tdm) o rondas ganadas (bomb)
    this.nextBullet = 1;
    this.onEvent = () => {};
    // modo bomba
    this.round = 0;
    this.atk = 0;            // equipo que ataca
    this.phase = 'live';     // 'freeze' | 'live' | 'post'
    this.phaseT = 0;
    this.roundT = 0;
    this.bomb = { st: 'none', carrier: null, x: 0, z: 0, site: -1, timer: 0, prog: 0, by: null };
    this.started = false;
  }

  isBomb() { return this.mode === 'bomb'; }
  enemies(a, b) { return a !== b && (!this.teams || a.team !== b.team); }
  // lado del mapa del que sale cada equipo: en bomba depende de quién ataca
  sideOf(team) { return this.isBomb() ? (team === this.atk ? 0 : 1) : team; }

  addPlayer(id, name, color, bot = false, team = 0) {
    const p = {
      id, name, color, bot, team: this.teams ? (team ? 1 : 0) : 0,
      x: 0, z: 0, aim: 0, hp: MAX_HP, alive: false, respawnT: 0.5,
      kills: 0, deaths: 0, fireCd: 0, dashCd: 0, dashT: 0, dashX: 0, dashZ: 0,
      triple: 0, speed: 0, shield: 0, invul: 0, moving: false, acting: false,
      emote: 0, emoteT: 0, emoteN: 0, emoteCd: 0,
      input: { mx: 0, mz: 0, a: 0, f: false, d: false, em: 0, act: false, seq: 0 },
      ai: bot ? { t: 0, target: null, strafe: 1, strafeT: 0, goal: null, stuckT: 0, lx: 0, lz: 0, wander: 0, fireHold: 0, act: false } : null,
    };
    this.players.set(id, p);
    if (this.isBomb()) {
      // en bomba: si la ronda ya está en marcha, espera a la siguiente
      if (!this.started) { this.started = true; this.startRound(); }
      else if (this.phase === 'freeze') this.respawn(p);
      else { p.alive = false; p.respawnT = Infinity; }
    } else this.respawn(p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p && this.bomb.carrier === id) this.dropBomb(p);
    if (this.bomb.by === id) { this.bomb.by = null; this.bomb.prog = 0; }
    this.players.delete(id);
    this.bullets = this.bullets.filter(b => b.owner !== id);
  }

  setInput(id, inp) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    const m = Math.hypot(inp.mx || 0, inp.mz || 0);
    p.input.mx = m > 1 ? inp.mx / m : (+inp.mx || 0);
    p.input.mz = m > 1 ? inp.mz / m : (+inp.mz || 0);
    if (Number.isFinite(inp.a)) p.input.a = inp.a;
    p.input.f = !!inp.f;
    p.input.act = !!inp.u;
    if (inp.d) p.input.d = true;      // el dash se mantiene hasta consumirse
    if (Number.isInteger(inp.em) && inp.em >= 1 && inp.em <= EMOTES.length) p.input.em = inp.em;
    if (Number.isInteger(inp.seq)) p.input.seq = inp.seq;
  }

  respawn(p) {
    let best;
    if (this.teams) {
      // en equipos se aparece en el lado propio, lo más lejos posible de los enemigos
      const list = TEAM_SPAWNS[this.sideOf(p.team)];
      if (this.isBomb()) {
        const mates = [...this.players.values()].filter(q => q.team === p.team);
        best = list[mates.indexOf(p) % list.length];
      } else best = this.farthest(p, list);
    } else best = this.farthest(p, SPAWNS);
    p.x = best[0]; p.z = best[1];
    p.aim = Math.atan2(-p.x, -p.z);
    p.hp = MAX_HP; p.alive = true; p.invul = this.isBomb() ? 0 : SPAWN_SHIELD;
    p.triple = p.speed = p.shield = 0; p.dashT = 0; p.emote = 0; p.acting = false;
    this.onEvent({ e: 'spawn', id: p.id, x: p.x, z: p.z });
  }

  farthest(p, list) {
    let best = list[0], bestD = -1;
    for (const s of list.slice().sort(() => Math.random() - 0.5)) {
      let dmin = 1e9;
      for (const q of this.players.values()) if (q.alive && this.enemies(p, q)) dmin = Math.min(dmin, Math.hypot(q.x - s[0], q.z - s[1]));
      if (dmin > bestD) { bestD = dmin; best = s; }
    }
    return best;
  }

  // ---------- Rondas (modo bomba) ----------
  startRound() {
    this.round++;
    // a mitad de partida los equipos se cambian de papel
    if (this.round === this.goal) this.atk = 1 - this.atk;
    this.bullets = [];
    for (const k of this.pickups) { k.active = true; k.t = 0; }
    for (const p of this.players.values()) { p.respawnT = Infinity; this.respawn(p); }
    this.phase = 'freeze'; this.phaseT = BOMB.freeze; this.roundT = BOMB.roundTime;
    this.bomb = { st: 'none', carrier: null, x: 0, z: 0, site: -1, timer: 0, prog: 0, by: null };
    const atks = [...this.players.values()].filter(p => p.team === this.atk);
    if (atks.length) {
      // la bomba la lleva un atacante al azar (mejor una persona que un bot)
      const humans = atks.filter(p => !p.bot);
      const c = (humans.length ? humans : atks)[Math.floor(Math.random() * (humans.length || atks.length))];
      this.bomb.st = 'carried'; this.bomb.carrier = c.id;
    }
    this.atkSite = Math.random() < 0.5 ? 0 : 1; // punto al que van los bots atacantes
    this.onEvent({ e: 'round', round: this.round, atk: this.atk, carrier: this.bomb.carrier });
  }

  endRound(w, reason) {
    if (this.phase === 'post') return;
    this.score[w]++;
    this.phase = 'post'; this.phaseT = BOMB.after;
    this.bomb.prog = 0; this.bomb.by = null;
    this.onEvent({ e: 'roundEnd', w, reason, score: this.score.slice() });
  }

  dropBomb(p) {
    this.bomb.st = 'dropped'; this.bomb.carrier = null; this.bomb.x = p.x; this.bomb.z = p.z; this.bomb.prog = 0;
    this.onEvent({ e: 'bombDrop', id: p.id, x: p.x, z: p.z });
  }

  siteAt(x, z) { return SITES.findIndex(s => Math.hypot(s.x - x, s.z - z) < BOMB.siteR); }

  // E mantenida: plantar (atacante con la bomba en un punto) o desactivar (defensor junto a la bomba)
  updateBombActions(dt) {
    const bomb = this.bomb;
    if (bomb.st === 'carried') {
      const c = this.players.get(bomb.carrier);
      const site = c ? this.siteAt(c.x, c.z) : -1;
      if (c && c.alive && site >= 0 && c.input.act && !c.moving && !c.input.f) {
        c.acting = true; bomb.prog += dt;
        if (bomb.prog >= BOMB.plantTime) {
          bomb.st = 'planted'; bomb.carrier = null; bomb.x = c.x; bomb.z = c.z; bomb.site = site;
          bomb.timer = BOMB.fuse; bomb.prog = 0;
          this.onEvent({ e: 'plant', id: c.id, site, x: c.x, z: c.z });
        }
      } else bomb.prog = 0;
    } else if (bomb.st === 'planted') {
      let d = this.players.get(bomb.by);
      const ok = q => q && q.alive && q.team !== this.atk && q.input.act && !q.moving && !q.input.f && Math.hypot(q.x - bomb.x, q.z - bomb.z) < BOMB.useR;
      if (!ok(d)) {
        bomb.by = null; bomb.prog = 0;
        d = [...this.players.values()].find(ok);
        if (d) bomb.by = d.id;
      }
      if (d) {
        d.acting = true; bomb.prog += dt;
        if (bomb.prog >= BOMB.defuseTime) {
          bomb.st = 'defused'; bomb.prog = 0;
          this.onEvent({ e: 'defuse', id: d.id, x: bomb.x, z: bomb.z });
          this.endRound(1 - this.atk, 'defuse');
        }
      }
    }
  }

  updateRound(dt) {
    if (this.phase === 'freeze') {
      if ((this.phaseT -= dt) <= 0) { this.phase = 'live'; this.onEvent({ e: 'live' }); }
      return;
    }
    if (this.phase === 'post') {
      if ((this.phaseT -= dt) <= 0) {
        if (this.score[0] >= this.goal || this.score[1] >= this.goal) this.finish();
        else this.startRound();
      }
      return;
    }
    const bomb = this.bomb, def = 1 - this.atk;
    const alive = t => [...this.players.values()].some(p => p.alive && p.team === t);
    const hasTeam = t => [...this.players.values()].some(p => p.team === t);
    if (bomb.st === 'planted') {
      if ((bomb.timer -= dt) <= 0) {
        bomb.st = 'exploded';
        this.onEvent({ e: 'explode', x: bomb.x, z: bomb.z });
        // la explosión elimina a quien esté cerca
        for (const p of this.players.values()) {
          if (p.alive && Math.hypot(p.x - bomb.x, p.z - bomb.z) < 7) this.kill(p, null);
        }
        this.endRound(this.atk, 'explode');
        return;
      }
      if (hasTeam(def) && !alive(def)) this.endRound(this.atk, 'elim');
    } else {
      if ((this.roundT -= dt) <= 0) { this.endRound(def, 'time'); return; }
      if (hasTeam(this.atk) && !alive(this.atk)) this.endRound(def, 'elim');
      else if (hasTeam(def) && !alive(def)) this.endRound(this.atk, 'elim');
    }
    // recoger la bomba del suelo
    if (bomb.st === 'dropped') {
      for (const p of this.players.values()) {
        if (p.alive && p.team === this.atk && Math.hypot(p.x - bomb.x, p.z - bomb.z) < BOMB.useR) {
          bomb.st = 'carried'; bomb.carrier = p.id;
          this.onEvent({ e: 'bombPick', id: p.id });
          break;
        }
      }
    }
  }

  step(dt) {
    if (this.state !== 'playing') return;
    this.time += dt;
    const bomb = this.isBomb();
    if (bomb) this.updateRound(dt);
    const frozen = bomb && this.phase === 'freeze';

    for (const p of this.players.values()) {
      p.acting = false;
      if (!p.alive) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) this.respawn(p);
        continue;
      }
      if (p.bot) this.botThink(p, dt);
      const inp = p.input;
      p.aim = inp.a;
      p.fireCd -= dt; p.dashCd -= dt;
      for (const k of ['triple', 'speed', 'shield', 'invul']) if (p[k] > 0) p[k] = Math.max(0, p[k] - dt);
      if (frozen) { p.moving = false; inp.d = false; inp.em = 0; continue; }

      // dash
      if (inp.d) {
        inp.d = false;
        if (p.dashCd <= 0) {
          let dx = inp.mx, dz = inp.mz;
          if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(p.aim); dz = Math.cos(p.aim); }
          const l = Math.hypot(dx, dz); p.dashX = dx / l; p.dashZ = dz / l;
          p.dashT = DASH_TIME; p.dashCd = DASH_CD;
          this.onEvent({ e: 'dash', id: p.id });
        }
      }
      let vx, vz;
      if (p.dashT > 0) { p.dashT -= dt; vx = p.dashX * DASH_SPEED; vz = p.dashZ * DASH_SPEED; }
      else {
        const sp = SPEED * (p.speed > 0 ? SPEED_BOOST : 1);
        vx = inp.mx * sp; vz = inp.mz * sp;
      }
      p.moving = Math.abs(vx) + Math.abs(vz) > 0.1;
      [p.x, p.z] = moveCircle(p.x, p.z, vx * dt, vz * dt, PLAYER_R);

      // emotes: moverse, impulsarse o disparar los cancela; solo empiezan estando quieto
      p.emoteCd -= dt;
      if (p.emote && (p.moving || inp.f)) p.emote = 0;
      if (p.emote && (p.emoteT -= dt) <= 0) p.emote = 0;
      if (inp.em) {
        if (!p.moving && !inp.f && p.emoteCd <= 0) this.startEmote(p, inp.em, EMOTES[inp.em - 1].time || Infinity);
        inp.em = 0;
      }

      // disparo
      if (inp.f && p.fireCd <= 0) {
        p.fireCd = FIRE_CD;
        const angles = p.triple > 0 ? [-0.16, 0, 0.16] : [0];
        for (const da of angles) {
          const a = p.aim + da;
          const sx = Math.sin(a), sz = Math.cos(a);
          this.bullets.push({
            id: this.nextBullet++, owner: p.id, team: p.team, color: p.color,
            x: p.x + sx * 0.8, z: p.z + sz * 0.8, vx: sx * BULLET_SPEED, vz: sz * BULLET_SPEED, life: BULLET_LIFE,
          });
        }
        this.onEvent({ e: 'shot', id: p.id });
      }

      // objetos
      for (const k of this.pickups) {
        if (!k.active || Math.hypot(k.x - p.x, k.z - p.z) > 1.3) continue;
        if (k.type === 'health' && p.hp >= MAX_HP) continue;
        k.active = false; k.t = PICKUP_RESPAWN;
        if (k.type === 'health') p.hp = Math.min(MAX_HP, p.hp + 40);
        else p[k.type] = POWER_TIME;
        this.onEvent({ e: 'pickup', id: p.id, type: k.type, x: k.x, z: k.z });
      }
    }

    if (bomb && this.phase === 'live') this.updateBombActions(dt);
    for (const k of this.pickups) if (!k.active && (k.t -= dt) <= 0) k.active = true;

    // balas (atraviesan a los compañeros de equipo)
    const keep = [];
    for (const b of this.bullets) {
      const steps = 2;
      let dead = false;
      for (let s = 0; s < steps && !dead; s++) {
        b.x += b.vx * dt / steps; b.z += b.vz * dt / steps;
        if (pointBlocked(b.x, b.z, BULLET_R * 0.5)) {
          dead = true; this.onEvent({ e: 'impact', x: b.x, z: b.z, c: b.color }); break;
        }
        for (const p of this.players.values()) {
          if (!p.alive || p.id === b.owner || (this.teams && p.team === b.team)) continue;
          if (Math.hypot(p.x - b.x, p.z - b.z) < PLAYER_R + BULLET_R) {
            dead = true; this.damage(p, b); break;
          }
        }
      }
      b.life -= dt;
      if (!dead && b.life > 0) keep.push(b);
    }
    this.bullets = keep;

    if (this.time >= this.timeLimit) this.finish();
  }

  startEmote(p, em, time) {
    p.emote = em; p.emoteT = time; p.emoteN++; p.emoteCd = 0.4;
  }

  damage(p, b) {
    if (p.invul > 0) { this.onEvent({ e: 'block', id: p.id, x: b.x, z: b.z }); return; }
    const dmg = p.shield > 0 ? BULLET_DMG * 0.4 : BULLET_DMG;
    p.hp -= dmg;
    this.onEvent({ e: 'hit', id: p.id, by: b.owner, x: b.x, z: b.z, c: b.color });
    if (p.ai) { p.ai.target = b.owner; p.ai.t = 0; p.ai.emoteHold = 0; }
    if (p.hp <= 0) this.kill(p, this.players.get(b.owner));
  }

  // k: quien elimina (null si es la explosión de la bomba)
  kill(p, k) {
    p.hp = 0; p.alive = false; p.deaths++; p.emote = 0;
    p.respawnT = this.isBomb() ? Infinity : RESPAWN_TIME; // en bomba se espera a la siguiente ronda
    if (this.bomb.carrier === p.id) this.dropBomb(p);
    if (k) {
      k.kills++;
      if (this.mode === 'tdm') this.score[k.team]++;
      // los bots a veces celebran la baja con un emote
      if (k.ai && Math.random() < 0.25 && !this.isBomb()) {
        const em = [1, 2, 3][Math.floor(Math.random() * 3)];
        k.ai.emoteHold = 1.6;
        this.startEmote(k, em, 1.6);
      }
    }
    this.onEvent({ e: 'kill', killer: k ? k.id : null, victim: p.id, x: p.x, z: p.z });
    if (k && this.mode === 'ffa' && k.kills >= this.goal) this.finish();
    if (k && this.mode === 'tdm' && this.score[k.team] >= this.goal) this.finish();
  }

  finish() {
    if (this.state !== 'playing') return;
    this.state = 'over';
    const rank = this.ranking();
    if (this.teams) {
      this.winnerTeam = this.score[0] > this.score[1] ? 0 : this.score[1] > this.score[0] ? 1 : -1;
      const best = rank.find(r => r.team === this.winnerTeam);
      this.winner = best ? best.id : null;
    } else this.winner = rank[0] ? rank[0].id : null;
    this.onEvent({ e: 'end', winner: this.winner, winnerTeam: this.winnerTeam });
  }

  ranking() {
    return [...this.players.values()]
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, bot: p.bot, team: p.team }));
  }

  // ---------- IA ----------
  // Meta del bot en el modo bomba: [x, z, acción] o null
  bombGoal(p) {
    const bomb = this.bomb, atk = p.team === this.atk;
    const near = (x, z, r) => Math.hypot(p.x - x, p.z - z) < r;
    if (atk) {
      if (bomb.st === 'carried' && bomb.carrier === p.id) {
        const s = SITES[this.atkSite];
        // dentro del punto: plantar
        return [s.x, s.z, this.siteAt(p.x, p.z) >= 0 && near(s.x, s.z, BOMB.siteR - 1)];
      }
      if (bomb.st === 'dropped') return [bomb.x, bomb.z, false];
      if (bomb.st === 'planted') return [bomb.x + Math.sin(p.id.length + this.round) * 4, bomb.z + 4, false];
      const c = this.players.get(bomb.carrier);
      return c ? [c.x, c.z, false] : null;
    }
    if (bomb.st === 'planted') return [bomb.x, bomb.z, near(bomb.x, bomb.z, BOMB.useR - 0.4)];
    // defensa: repartirse entre los dos puntos
    const mates = [...this.players.values()].filter(q => q.team === p.team);
    const s = SITES[mates.indexOf(p) % 2];
    return [s.x, s.z + 2, false];
  }

  botThink(p, dt) {
    const ai = p.ai, sk = DIFFICULTY[this.difficulty] || DIFFICULTY.normal, inp = p.input;
    inp.act = false;
    if (ai.emoteHold > 0) { ai.emoteHold -= dt; inp.mx = inp.mz = 0; inp.f = false; return; }
    ai.t -= dt; ai.strafeT -= dt; ai.wander -= dt;

    // detectar atascos
    ai.stuckT += dt;
    if (ai.stuckT > 1) {
      if (Math.hypot(p.x - ai.lx, p.z - ai.lz) < 0.6 && ai.wander <= 0 && !ai.acting) {
        ai.wander = 1.2; ai.wx = (Math.random() - 0.5) * 2; ai.wz = (Math.random() - 0.5) * 2;
      }
      ai.stuckT = 0; ai.lx = p.x; ai.lz = p.z;
    }

    if (ai.t <= 0) {
      ai.t = sk.react * (0.7 + Math.random() * 0.6);
      // objetivo: el enemigo visible más cercano, o el más cercano en general
      let best = null, bd = 1e9, bestVis = null, bvd = 1e9;
      for (const q of this.players.values()) {
        if (!q.alive || !this.enemies(p, q)) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) { bd = d; best = q; }
        if (d < 28 && d < bvd && lineOfSight(p.x, p.z, q.x, q.z)) { bvd = d; bestVis = q; }
      }
      const cur = this.players.get(ai.target);
      const curOk = cur && cur.alive && this.enemies(p, cur) && lineOfSight(p.x, p.z, cur.x, cur.z);
      if (!curOk) ai.target = (bestVis || best || {}).id ?? null;
      ai.visible = !!bestVis || !!curOk;
      ai.visDist = bestVis ? bvd : (curOk ? Math.hypot(cur.x - p.x, cur.z - p.z) : 99);

      // meta de movimiento
      ai.goal = null; ai.act = false;
      const want = p.hp < 45 ? 'health' : (p.triple <= 0 && Math.random() < 0.3 ? 'triple' : null);
      if (this.isBomb()) {
        const g = this.bombGoal(p);
        if (g) { ai.goal = [g[0], g[1]]; ai.act = g[2]; }
      } else if (want) {
        let kd = 1e9;
        for (const k of this.pickups) if (k.active && k.type === want) {
          const d = Math.hypot(k.x - p.x, k.z - p.z);
          if (d < kd && d < 30) { kd = d; ai.goal = [k.x, k.z]; }
        }
      }
      if (ai.strafeT <= 0) { ai.strafe = Math.random() < 0.5 ? 1 : -1; ai.strafeT = 0.8 + Math.random() * 1.5; }
    }

    // plantar o desactivar: quieto y sin disparar, salvo que haya un enemigo muy cerca
    ai.acting = ai.act && !(ai.visible && ai.visDist < 9);
    if (ai.acting) { inp.mx = inp.mz = 0; inp.f = false; inp.act = true; return; }

    const t = this.players.get(ai.target);
    let dx = 0, dz = 0;
    if (t && t.alive) {
      const tx = t.x - p.x, tz = t.z - p.z, d = Math.hypot(tx, tz) || 1;
      const vis = ai.visible;
      if (vis) {
        // apuntar con anticipación y error
        const lead = d / BULLET_SPEED;
        const ax = t.x + t.input.mx * SPEED * lead * 0.8 - p.x, az = t.z + t.input.mz * SPEED * lead * 0.8 - p.z;
        const err = (Math.random() - 0.5) * 2 * sk.aimError;
        inp.a = Math.atan2(ax, az) + err;
        ai.fireHold -= dt;
        if (ai.fireHold <= 0) { ai.fireHold = 0.25; ai.firing = Math.random() < sk.fireChance; }
        inp.f = ai.firing && d < 26;
        // moverse lateralmente manteniendo distancia
        const ideal = 9;
        const radial = d > ideal + 2 ? 1 : d < ideal - 3 ? -1 : 0;
        dx = tx / d * radial + (-tz / d) * ai.strafe;
        dz = tz / d * radial + (tx / d) * ai.strafe;
        if (Math.random() < sk.dash * dt * 0.6) inp.d = true;
      } else {
        inp.f = false;
        dx = tx; dz = tz;
        inp.a = Math.atan2(tx, tz);
      }
    } else { inp.f = false; dx = -p.x; dz = -p.z; }

    if (ai.goal) {
      // en bomba la meta manda más que la persecución cuando no hay nadie a la vista
      const gx = ai.goal[0] - p.x, gz = ai.goal[1] - p.z;
      const gl = Math.hypot(gx, gz) || 1;
      if (this.isBomb()) {
        if (!ai.visible) { dx = gx; dz = gz; if (gl > 2) inp.a = Math.atan2(gx, gz); }
        else { dx = dx * 0.6 + gx / gl * 0.8; dz = dz * 0.6 + gz / gl * 0.8; }
        if (gl < 1.2 && !ai.visible) { dx = dz = 0; }
      } else { dx = dx * 0.3 + gx; dz = dz * 0.3 + gz; }
    }
    if (ai.wander > 0) { dx = ai.wx; dz = ai.wz; }

    // esquivar obstáculos: elegir entre 16 direcciones la mejor
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) { inp.mx = inp.mz = 0; return; }
    dx /= l; dz /= l;
    let bx = 0, bz = 0, bs = -1e9;
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2, cx = Math.sin(a), cz = Math.cos(a);
      let s = cx * dx + cz * dz;
      if (pointBlocked(p.x + cx * 1.2, p.z + cz * 1.2, PLAYER_R)) s -= 5;
      else if (pointBlocked(p.x + cx * 2.6, p.z + cz * 2.6, PLAYER_R)) s -= 1.2;
      if (s > bs) { bs = s; bx = cx; bz = cz; }
    }
    inp.mx = bx; inp.mz = bz;
  }

  // ---------- Red ----------
  snapshot() {
    const r = n => Math.round(n * 100) / 100;
    const p = [];
    for (const q of this.players.values()) {
      let f = 0;
      if (q.moving) f |= F.MOVING;
      if (q.dashT > 0) f |= F.DASH;
      if (q.shield > 0) f |= F.SHIELD;
      if (q.triple > 0) f |= F.TRIPLE;
      if (q.speed > 0) f |= F.SPEED;
      if (q.invul > 0) f |= F.INVUL;
      if (q.acting) f |= F.ACT;
      p.push([q.id, r(q.x), r(q.z), r(q.aim), Math.ceil(q.hp), q.alive ? 1 : 0, f, q.kills, q.deaths, q.input.seq,
        r(Math.max(0, q.dashCd)), r(q.triple), r(q.speed), r(q.shield), Number.isFinite(q.respawnT) ? r(Math.max(0, q.respawnT)) : -1,
        q.emote, q.emoteN, q.team]);
    }
    return {
      t: 's', time: r(this.time), st: this.state,
      p, b: this.bullets.map(b => [b.id, r(b.x), r(b.z), r(b.vx), r(b.vz), b.owner]),
      k: this.pickups.map(k => k.active ? 1 : 0),
      md: this.modeState(),
    };
  }

  // Estado del modo que necesita el HUD (también lo usa el anfitrión en su pantalla)
  modeState() {
    const r = n => Math.round(n * 10) / 10;
    const b = this.bomb;
    return {
      m: this.mode, goal: this.goal, sc: this.score.slice(), tl: Number.isFinite(this.timeLimit) ? this.timeLimit : 0,
      rd: this.round, atk: this.atk, ph: this.phase, pt: r(Math.max(0, this.phaseT)), rt: r(Math.max(0, this.roundT)),
      bomb: [b.st, r(b.x), r(b.z), b.carrier, b.site, r(Math.max(0, b.timer)), r(b.prog), b.by],
    };
  }
}
