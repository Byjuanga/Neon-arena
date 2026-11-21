// Controles táctiles para móvil y tableta: joysticks que aparecen donde pones el dedo y botones en pantalla.
// Se activan solos si el dispositivo es táctil (o al primer toque).
const $ = id => document.getElementById(id);

// move: joystick izquierdo (moverse / girar); aim: joystick derecho (apuntar y disparar)
// Cada joystick activo es { id, x0, y0, vx, vy, m } con vx, vy entre -1 y 1 y m = fuerza (0 a 1)
export const T = { on: false, move: null, aim: null, brake: false, lastTouch: -1e9 };

const STICK_R = 56; // radio del joystick en píxeles
let api = null, mode = '';

export function initTouch(handlers) {
  api = handlers;
  if (matchMedia('(pointer: coarse)').matches) enable();
  addEventListener('touchstart', () => { T.lastTouch = performance.now(); enable(); }, { passive: true });
  stick($('zoneL'), 'move', $('stickL'));
  stick($('zoneR'), 'aim', $('stickR'));
  for (const b of document.querySelectorAll('#touch [data-k]')) button(b);
}

function enable() {
  if (T.on) return;
  T.on = true;
  document.body.classList.add('touch');
  api.onEnable && api.onEnable();
}

function stick(zone, key, el) {
  const knob = el.firstElementChild;
  zone.addEventListener('pointerdown', e => {
    if (T[key]) return;
    e.preventDefault();
    zone.setPointerCapture(e.pointerId);
    T[key] = { id: e.pointerId, x0: e.clientX, y0: e.clientY, vx: 0, vy: 0, m: 0 };
    document.body.classList.add('stick-' + key);
    el.style.left = e.clientX + 'px'; el.style.top = e.clientY + 'px';
    knob.style.transform = '';
    el.hidden = false;
  });
  zone.addEventListener('pointermove', e => {
    const s = T[key];
    if (!s || s.id !== e.pointerId) return;
    let dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    const d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
    s.vx = dx / STICK_R; s.vy = dy / STICK_R; s.m = Math.min(1, d / STICK_R);
    knob.style.transform = `translate(${dx}px,${dy}px)`;
  });
  const end = e => {
    const s = T[key];
    if (!s || s.id !== e.pointerId) return;
    T[key] = null; el.hidden = true;
    document.body.classList.remove('stick-' + key);
    api.changed && api.changed();
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
}

function button(b) {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { b.setPointerCapture(e.pointerId); } catch (err) {}
    b.classList.add('on');
    api.press(k, true);
  });
  const up = () => {
    if (!b.classList.contains('on')) return;
    b.classList.remove('on');
    api.press(k, false);
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('lostpointercapture', up);
}

// Qué controles se ven: 'arena', 'bomb', 'kart', 'parkour' o '' (ninguno)
export function setTouchMode(m) {
  if (m === mode) return;
  mode = m;
  document.body.dataset.tm = m;
  // al cambiar de modo se sueltan los joysticks y botones
  T.move = T.aim = null; T.brake = false;
  for (const el of document.querySelectorAll('#touch .stick')) el.hidden = true;
  for (const b of document.querySelectorAll('#touch .on')) { b.classList.remove('on'); api.press(b.dataset.k, false); }
}
