// Mapas de los minijuegos: el circuito de Neón Kart, los coches y el recorrido de la Carrera de Neón.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK, TRACK_HW, trackPoint } from './race.js';
import { COURSE } from './parkour.js';

const glow = (c, k = 2.2) => new THREE.Color(c).multiplyScalar(k);
function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
// números pseudoaleatorios repetibles (el decorado es igual para todos)
function rng(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

// Cinta a lo largo de la pista entre dos desplazamientos laterales
function ribbon(lat0, lat1, y = 0, vScale = 8) {
  const pos = [], uv = [], idx = [];
  const N = TRACK.N;
  for (let i = 0; i <= N; i++) {
    const p = TRACK.pts[i % N], s = i === N ? TRACK.L : p.s;
    pos.push(p.x + p.nx * lat0, y, p.z + p.nz * lat0, p.x + p.nx * lat1, y, p.z + p.nz * lat1);
    uv.push(0, s / vScale, 1, s / vScale);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // que la cara de arriba mire hacia arriba
  const n = g.attributes.normal; if (n.getY(0) < 0) { g.setIndex(idx.reverse()); g.computeVertexNormals(); }
  return g;
}
function edgeLine(lat, y, color) {
  const pts = TRACK.pts.map(p => new THREE.Vector3(p.x + p.nx * lat, y, p.z + p.nz * lat));
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: glow(color, 2.5), toneMapped: false }));
}
// Pieza plana colocada sobre la pista en (s, lat), orientada en el sentido de la marcha
function onTrack(mesh, s, lat, y) {
  const p = trackPoint(s, lat);
  mesh.position.set(p.x, y, p.z);
  mesh.rotation.y = Math.atan2(p.tx, p.tz);
  return mesh;
}

// ---------- Neón Kart ----------
export function buildKartWorld() {
  const group = new THREE.Group();
  // suelo con rejilla
  const gridTex = canvasTex(256, 256, (g, w) => {
    g.fillStyle = '#07081a'; g.fillRect(0, 0, w, w);
    g.strokeStyle = '#161c48'; g.lineWidth = 3; g.strokeRect(0, 0, w, w);
  }, true);
  gridTex.repeat.set(60, 60);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.9, metalness: 0.1, envMapIntensity: 0.05 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true; ground.userData.flat = true;
  group.add(ground);
  // asfalto
  const roadTex = canvasTex(128, 128, (g, w) => {
    g.fillStyle = '#10132a'; g.fillRect(0, 0, w, w);
    g.fillStyle = '#141838'; for (let i = 0; i < 300; i++) g.fillRect(Math.random() * w, Math.random() * w, 2, 2);
    g.fillStyle = '#2b3170'; g.fillRect(w / 2 - 2, 0, 4, w / 2); // línea discontinua central
  }, true);
  const road = new THREE.Mesh(ribbon(-TRACK_HW, TRACK_HW, 0.01), new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.75, metalness: 0.1, envMapIntensity: 0.08 }));
  road.receiveShadow = true; road.userData.flat = true;
  group.add(road);
  // bordes de neón y barreras
  for (const [lat, col] of [[TRACK_HW - 0.2, '#00e5ff'], [-(TRACK_HW - 0.2), '#ff2bd6']]) {
    group.add(new THREE.Mesh(ribbon(lat - 0.18, lat + 0.18, 0.02, 1000), new THREE.MeshBasicMaterial({ color: glow(col, 1.6), toneMapped: false })));
    const outer = lat + Math.sign(lat) * 0.5;
    group.add(edgeLine(outer, 0.9, col));
    const wall = new THREE.Mesh(wallStrip(outer, 0.9), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    group.add(wall);
  }
  // línea de salida y meta
  const checker = canvasTex(128, 32, (g, w, h) => {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#ffffff' : '#111111'; g.fillRect(i * 8, j * 8, 8, 8); }
  });
  group.add(onTrack(new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HW * 2, 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: checker })), 0, 0, 0.03));
  // arco de meta
  const arch = new THREE.Group();
  const postGeo = new THREE.BoxGeometry(0.6, 6, 0.6), barGeo = new THREE.BoxGeometry(TRACK_HW * 2 + 2, 0.8, 0.6);
  const archMat = new THREE.MeshBasicMaterial({ color: glow('#ffd400', 1.8), toneMapped: false });
  const l = new THREE.Mesh(postGeo, archMat); l.position.set(TRACK_HW + 1, 3, 0);
  const r = new THREE.Mesh(postGeo, archMat); r.position.set(-TRACK_HW - 1, 3, 0);
  const b = new THREE.Mesh(barGeo, archMat); b.position.set(0, 6, 0);
  arch.add(l, r, b);
  group.add(onTrack(arch, 0, 0, 0));
  // placas de turbo
  const chevron = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#2a1000'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ff8a1f'; g.lineWidth = 10;
    for (let y = 10; y < h; y += 40) { g.beginPath(); g.moveTo(6, y + 26); g.lineTo(w / 2, y); g.lineTo(w - 6, y + 26); g.stroke(); }
  });
  const padMat = new THREE.MeshBasicMaterial({ map: chevron, color: new THREE.Color(1.8, 1.8, 1.8), toneMapped: false });
  for (const p of TRACK.pads) group.add(onTrack(new THREE.Mesh(new THREE.PlaneGeometry(p.hw * 2, p.len).rotateX(-Math.PI / 2), padMat), p.s + p.len / 2, p.lat, 0.03));
  // rampas
  const rampMat = new THREE.MeshStandardMaterial({ color: '#1b2040', metalness: 0.5, roughness: 0.4, envMapIntensity: 0.3 });
  const rampEdge = new THREE.LineBasicMaterial({ color: glow('#ffd400', 2.5), toneMapped: false });
  for (const rp of TRACK.ramps) {
    const g = new THREE.Group();
    const w = TRACK_HW * 2 - 0.6, len = rp.len, h = 0.7;
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(len, 0), new THREE.Vector2(len, h)]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    geo.translate(-len / 2, 0, -w / 2); geo.rotateY(-Math.PI / 2);
    const m = new THREE.Mesh(geo, rampMat); m.castShadow = m.receiveShadow = true;
    g.add(m, new THREE.LineSegments(new THREE.EdgesGeometry(geo), rampEdge));
    group.add(onTrack(g, rp.s + rp.len / 2, 0, 0));
  }
  // cajas de objetos
  const qTex = canvasTex(64, 64, (g, w) => {
    const gr = g.createLinearGradient(0, 0, w, w); gr.addColorStop(0, '#ff2bd6'); gr.addColorStop(1, '#00e5ff');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
    g.fillStyle = '#ffffff'; g.font = '900 46px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', w / 2, w / 2 + 3);
  });
  const boxMat = new THREE.MeshBasicMaterial({ map: qTex, transparent: true, opacity: 0.9, color: new THREE.Color(1.4, 1.4, 1.4), toneMapped: false });
  const boxGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
  const boxes = TRACK.boxes.map(bx => { const p = trackPoint(bx.s, bx.lat); const m = new THREE.Mesh(boxGeo, boxMat); m.position.set(p.x, 1, p.z); group.add(m); return m; });
  // decorado: torres de neón alrededor (juntas en una sola pieza)
  const rand = rng(7), towers = [], tEdges = [];
  for (let i = 0; i < 220 && towers.length < 70; i++) {
    const x = (rand() - 0.5) * 260, z = (rand() - 0.5) * 240;
    let dmin = Infinity;
    for (let k = 0; k < TRACK.N; k += 3) dmin = Math.min(dmin, Math.hypot(TRACK.pts[k].x - x, TRACK.pts[k].z - z));
    if (dmin < TRACK_HW + 8) continue;
    const w = 3 + rand() * 5, h = 4 + rand() * 22, d = 3 + rand() * 5;
    const g = new THREE.BoxGeometry(w, h, d).translate(x, h / 2, z);
    towers.push(g); tEdges.push(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)).translate(x, h / 2, z));
  }
  const tw = new THREE.Mesh(mergeGeometries(towers), new THREE.MeshStandardMaterial({ color: '#121634', metalness: 0.6, roughness: 0.5, envMapIntensity: 0.25 }));
  tw.userData.flat = true; group.add(tw);
  group.add(new THREE.LineSegments(mergeGeometries(tEdges), new THREE.LineBasicMaterial({ color: glow('#8f5bff', 2), toneMapped: false })));
  // minas (se reutilizan)
  const mineGeo = new THREE.SphereGeometry(0.45, 12, 8), mineMat = new THREE.MeshBasicMaterial({ color: glow('#ff3355', 2.4), toneMapped: false });
  const mines = []; const mineMesh = () => { const m = new THREE.Mesh(mineGeo, mineMat); group.add(m); mines.push(m); return m; };
  return { group, boxes, mines, mineMesh };
}

function wallStrip(lat, h) {
  const pos = [], idx = [], N = TRACK.N;
  for (let i = 0; i <= N; i++) {
    const p = TRACK.pts[i % N];
    pos.push(p.x + p.nx * lat, 0, p.z + p.nz * lat, p.x + p.nx * lat, h, p.z + p.nz * lat);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}

// Coche de neón del color del jugador
export function makeCar(color) {
  const c = new THREE.Color(color);
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const dark = new THREE.MeshStandardMaterial({ color: '#161a33', metalness: 0.7, roughness: 0.35 });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.45, 3.6), dark); chassis.position.y = 0.55;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 0.8), dark); nose.position.set(0, 0.42, 2.0);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 1.4),
    new THREE.MeshStandardMaterial({ color: c.clone().multiplyScalar(0.25), emissive: c.clone().multiplyScalar(0.5), metalness: 0.3, roughness: 0.2 }));
  cabin.position.set(0, 1.0, -0.3);
  const stripeMat = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.2), toneMapped: false });
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 3.5), stripeMat); s1.position.set(1.02, 0.62, 0);
  const s2 = s1.clone(); s2.position.x = -1.02;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.06), new THREE.MeshBasicMaterial({ color: glow('#ff2040', 2.5), toneMapped: false })); tail.position.set(0, 0.64, -1.82);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: glow('#ffffff', 2), toneMapped: false })); head.position.set(0, 0.5, 2.41);
  chassis.castShadow = cabin.castShadow = true;
  body.add(chassis, nose, cabin, s1, s2, tail, head);
  const wheels = [];
  const wGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 14).rotateZ(Math.PI / 2), wMat = new THREE.MeshStandardMaterial({ color: '#08090f', roughness: 0.8 });
  for (const [x, z] of [[1.05, 1.25], [-1.05, 1.25], [1.05, -1.25], [-1.05, -1.25]]) { const w = new THREE.Mesh(wGeo, wMat); w.position.set(x, 0.42, z); body.add(w); wheels.push(w); }
  const under = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(1.5), transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
  under.position.y = 0.06; root.add(under);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.4, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: glow('#ff8a1f', 2.6), toneMapped: false }));
  flame.position.set(0, 0.6, -2.5); flame.visible = false; body.add(flame);
  const shield = new THREE.Mesh(new THREE.SphereGeometry(2.6, 20, 14),
    new THREE.MeshBasicMaterial({ color: '#8f5bff', transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }));
  shield.position.y = 0.8; shield.visible = false; root.add(shield);
  return { root, body, wheels, flame, shield, under };
}

// ---------- Carrera de Neón (parkour) ----------
const PLAT_COLORS = { static: '#00e5ff', cp: '#ffd400', finish: '#ffd400', move: '#ff2bd6', fall: '#ff6a1f', bounce: '#39ff6a' };
export function buildParkourWorld() {
  const group = new THREE.Group();
  // vacío: rejilla muy abajo
  const gridTex = canvasTex(256, 256, (g, w) => {
    g.fillStyle = '#04050f'; g.fillRect(0, 0, w, w);
    g.strokeStyle = '#1b2252'; g.lineWidth = 3; g.strokeRect(0, 0, w, w);
  }, true);
  gridTex.repeat.set(40, 40);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshBasicMaterial({ map: gridTex }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, -22, -90); group.add(floor);

  const dark = new THREE.MeshStandardMaterial({ color: '#141933', metalness: 0.5, roughness: 0.5, envMapIntensity: 0.15 });
  const statics = [], staticEdges = {}, dynamic = [];
  COURSE.plats.forEach((p, i) => {
    const geo = new THREE.BoxGeometry(p.w, p.th, p.d);
    const col = PLAT_COLORS[p.type] || '#00e5ff';
    if (p.type === 'move' || p.type === 'fall') {
      const g = new THREE.Group();
      const m = new THREE.Mesh(geo, dark); m.castShadow = m.receiveShadow = true; m.userData.flat = true;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: glow(col, 2.4), toneMapped: false }));
      g.add(m, e); g.position.set(p.x, p.y - p.th / 2, p.z);
      group.add(g); dynamic.push({ i, g, p });
    } else {
      statics.push(geo.clone().translate(p.x, p.y - p.th / 2, p.z));
      (staticEdges[col] = staticEdges[col] || []).push(new THREE.EdgesGeometry(geo).translate(p.x, p.y - p.th / 2, p.z));
    }
    // cara de arriba de colores especiales
    if (p.type === 'bounce' || p.type === 'cp' || p.type === 'finish') {
      const top = new THREE.Mesh(new THREE.PlaneGeometry(p.w - 0.3, p.d - 0.3).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: p.type === 'bounce' ? 0.55 : p.type === 'finish' ? 0.2 : p.cp === 0 ? 0.04 : 0.09, depthWrite: false, toneMapped: false }));
      top.position.set(p.x, p.y + 0.02, p.z); group.add(top);
    }
  });
  const st = new THREE.Mesh(mergeGeometries(statics), dark); st.castShadow = st.receiveShadow = true; st.userData.flat = true;
  group.add(st);
  for (const [col, list] of Object.entries(staticEdges)) group.add(new THREE.LineSegments(mergeGeometries(list), new THREE.LineBasicMaterial({ color: glow(col, 2.4), toneMapped: false })));
  // barras láser
  const lasers = COURSE.lasers.map(l => {
    const g = new THREE.Group(); g.position.set(l.x, l.y + (l.h0 + l.h1) / 2, l.z);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(l.len * 2, (l.h1 - l.h0), 0.22), new THREE.MeshBasicMaterial({ color: glow('#ff3355', 2.8), toneMapped: false }));
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.6, 16), dark); pivot.position.y = -0.2;
    g.add(bar, pivot); group.add(g);
    return { g, l };
  });
  // arcos de puntos de control y meta
  const archMat = new THREE.MeshBasicMaterial({ color: glow('#ffd400', 1.8), toneMapped: false });
  for (const p of COURSE.plats) {
    if (p.type !== 'cp' && p.type !== 'finish') continue;
    const h = p.type === 'finish' ? 5 : 3.2, w = Math.min(p.w - 1, 9);
    const a = new THREE.Group();
    const post = new THREE.BoxGeometry(0.35, h, 0.35);
    const l = new THREE.Mesh(post, archMat); l.position.set(-w / 2, h / 2, 0);
    const r = new THREE.Mesh(post, archMat); r.position.set(w / 2, h / 2, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(w + 0.35, 0.35, 0.35), archMat); b.position.set(0, h, 0);
    a.add(l, r, b);
    if (p.type === 'finish') {
      const t = canvasTex(256, 64, (g, w2, h2) => { g.fillStyle = '#ffd400'; g.font = '900 52px Orbitron, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('META', w2 / 2, h2 / 2 + 3); });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
      sign.position.set(0, h + 0.8, 0); a.add(sign);
    }
    a.position.set(p.x, p.y, p.z + (p.type === 'finish' ? p.d / 2 - 0.5 : 0));
    if (p.cp !== 0) group.add(a);
  }
  return { group, dynamic, lasers };
}
