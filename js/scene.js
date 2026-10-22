// three.js objects for Ramp Stunts AR: Pip, the virtual ramp, shoe marks, flags, cars, the
// aiming reticle and the pretend room used in preview mode. Sizes are real-world metres.
import * as THREE from '../vendor/three.module.min.js';

export { THREE };

export const COLORS = {
  pip: 0xEE8A1F, helm: 0x2C4155, ink: 0x14222C, white: 0xFFFFFF,
  book: [0x4C7FB8, 0xC85A54, 0x5B9A6B, 0xD9A400, 0x7A4BD8, 0x2D6BD6],
  tray: 0xB88A55, mark: 0xF4F1E8, compare: 0x7A4BD8, repeat: 0xD9A400,
  child: 0x0B7A85, runA: 0x4C7FB8, runB: 0xC85A54, floor: 0xD9CBB0
};

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...extra });
const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

// ---------- text labels ----------

export function makeLabel(text, { color = '#14222C', bg = 'rgba(255,255,255,0.92)', height = 0.035 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '700 64px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  c.width = w; c.height = 96;
  ctx.font = font;
  ctx.fillStyle = bg;
  const r = 30;
  ctx.beginPath();
  ctx.moveTo(r, 4); ctx.lineTo(w - r, 4); ctx.quadraticCurveTo(w - 4, 4, w - 4, r);
  ctx.lineTo(w - 4, 92 - r); ctx.quadraticCurveTo(w - 4, 92, w - r, 92);
  ctx.lineTo(r, 92); ctx.quadraticCurveTo(4, 92, 4, 92 - r);
  ctx.lineTo(4, r); ctx.quadraticCurveTo(4, 4, r, 4); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(height * w / 96, height, 1);
  s.renderOrder = 10;
  return s;
}

// ---------- Pip ----------

export function makePip() {
  const pip = new THREE.Group();
  const body = new THREE.Group();
  pip.add(body);

  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.045, 32, 24), std(COLORS.pip));
  torso.position.y = 0.05;
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.0475, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2.1), std(COLORS.helm, { roughness: 0.35 }));
  helmet.position.y = 0.056;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.004, 0.07), std(COLORS.white));
  stripe.position.set(0, 0.104, 0.0);
  body.add(torso, helmet, stripe);

  [-1, 1].forEach((sx) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.011, 16, 12), std(COLORS.white, { roughness: 0.3 }));
    eye.position.set(sx * 0.017, 0.047, 0.037);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 12, 8), std(COLORS.ink, { roughness: 0.2 }));
    pupil.position.set(sx * 0.017, 0.047, 0.047);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), std(COLORS.pip));
    hand.position.set(sx * 0.052, 0.036, 0.008);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), std(COLORS.helm));
    foot.scale.set(1.3, 0.7, 1.8);
    foot.position.set(sx * 0.019, 0.008, 0.008);
    body.add(eye, pupil, hand, foot);
  });

  const mouthMat = std(COLORS.ink);
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.0095, 0.0025, 8, 20, Math.PI), mouthMat);
  smile.rotation.z = Math.PI;
  smile.position.set(0, 0.031, 0.043);
  const frown = new THREE.Mesh(new THREE.TorusGeometry(0.0085, 0.0025, 8, 20, Math.PI), mouthMat);
  frown.position.set(0, 0.022, 0.042);
  const ooh = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 12, 8), mouthMat);
  ooh.position.set(0, 0.028, 0.044);
  body.add(smile, frown, ooh);

  pip.userData = {
    body,
    setMood(mood) {
      smile.visible = mood === 'idle' || mood === 'happy';
      smile.scale.setScalar(mood === 'happy' ? 1.4 : 1);
      frown.visible = mood === 'oops';
      ooh.visible = mood === 'think';
    }
  };
  pip.userData.setMood('idle');
  return pip;
}

// Apply a pose from pip-anim.js. `cameraLocal` is the camera position in the same frame,
// used to turn Pip toward the child when he is not travelling.
export function applyPipPose(pip, p, cameraLocal) {
  pip.position.set(p.pos.x, p.pos.y, p.pos.z);
  let face = p.face;
  if (!face && cameraLocal) {
    const dx = cameraLocal.x - p.pos.x, dz = cameraLocal.z - p.pos.z, l = Math.hypot(dx, dz);
    if (l > 1e-4) face = { x: dx / l, z: dz / l };
  }
  if (face) {
    const target = Math.atan2(face.x, face.z);
    let d = target - pip.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    pip.rotation.y += d * (p.face ? 1 : 0.12);
  }
  const body = pip.userData.body;
  body.position.y = p.lift;
  body.scale.set(1 / Math.sqrt(p.squash), p.squash, 1 / Math.sqrt(p.squash));
  body.rotation.set(0, p.spin, p.tilt);
}

// ---------- ramp ----------

// The virtual ramp in its own frame: origin at the foot, +x along the run-out.
// `ghost` draws a see-through outline, used when it sits over a real ramp (tier 2).
export function makeRamp(ramp, { ghost = false, maxShoes = 14 } = {}) {
  const g = new THREE.Group();
  g.position.copy(v3(ramp.foot));
  g.rotation.y = Math.atan2(-ramp.dir.z, ramp.dir.x);

  const angle = Math.atan2(ramp.rise, ramp.run);
  const trayMat = std(COLORS.tray, ghost ? { transparent: true, opacity: 0.35, depthWrite: false } : {});
  const tray = new THREE.Mesh(new THREE.BoxGeometry(ramp.slopeLength, 0.006, 0.13), trayMat);
  tray.position.set(-ramp.run / 2, ramp.rise / 2 + 0.003, 0);
  tray.rotation.z = -angle;
  g.add(tray);
  if (ghost) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(tray.geometry), new THREE.LineBasicMaterial({ color: COLORS.repeat }));
    edges.position.copy(tray.position); edges.rotation.copy(tray.rotation);
    g.add(edges);
  } else {
    const bh = ramp.rise / ramp.books;
    for (let i = 0; i < ramp.books; i++) {
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.14, bh * 0.96, 0.2), std(COLORS.book[i % COLORS.book.length]));
      book.position.set(-ramp.run - 0.055, bh * (i + 0.5), 0);
      g.add(book);
    }
  }

  // shoe marks along the floor where the car runs on
  const shoe = ramp.shoeCm / 100;
  const markMat = new THREE.MeshBasicMaterial({ color: COLORS.mark, transparent: true, opacity: 0.85, depthWrite: false });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(maxShoes * shoe, 0.004), markMat);
  line.rotation.x = -Math.PI / 2;
  line.position.set(maxShoes * shoe / 2, 0.001, 0);
  g.add(line);
  for (let n = 1; n <= maxShoes; n++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.005, n % 5 === 0 ? 0.1 : 0.06), markMat);
    tick.rotation.x = -Math.PI / 2;
    tick.position.set(n * shoe, 0.001, 0);
    const lab = makeLabel(String(n), { height: 0.022 });
    lab.position.set(n * shoe, 0.012, 0.06);
    g.add(tick, lab);
  }
  return g;
}

// ---------- flags and cars ----------

export function makeFlag(color, text) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.12, 8), std(0x333333));
  pole.position.y = 0.06;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(0.05, -0.015); shape.lineTo(0, -0.03); shape.lineTo(0, 0);
  const cloth = new THREE.Mesh(new THREE.ShapeGeometry(shape), std(color, { side: THREE.DoubleSide }));
  cloth.position.set(0.002, 0.12, 0);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 16), std(color));
  base.position.y = 0.002;
  g.add(pole, cloth, base);
  if (text) {
    const lab = makeLabel(text, { height: 0.026 });
    lab.position.set(0, 0.15, 0);
    g.add(lab);
  }
  return g;
}

// A toy car, nose along +x, wheels on y = 0. A ghost car is see-through (Pip's bet).
export function makeCar(color, ghost = false) {
  const g = new THREE.Group();
  const extra = ghost ? { transparent: true, opacity: 0.45, depthWrite: false } : {};
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 0.034), std(color, extra));
  body.position.y = 0.016;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.028), std(color, extra));
  cab.position.set(-0.006, 0.031, 0);
  g.add(body, cab);
  const wheelGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.006, 16);
  [[0.022, 0.017], [0.022, -0.017], [-0.022, 0.017], [-0.022, -0.017]].forEach(([x, z]) => {
    const w = new THREE.Mesh(wheelGeo, std(0x222222, extra));
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.008, z);
    g.add(w);
  });
  return g;
}

// Place a car on the run: `pos` is the contact point, the car points along `dir`.
export function placeCar(car, pos, dir, pitchDeg) {
  car.position.copy(v3(pos));
  car.rotation.set(0, Math.atan2(-dir.z, dir.x), -pitchDeg * Math.PI / 180, 'YXZ');
}

// ---------- reticle ----------

export function makeReticle() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.038, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLORS.pip, depthTest: false }));
  ring.renderOrder = dot.renderOrder = 20;
  g.add(ring, dot);
  g.matrixAutoUpdate = false;
  g.visible = false;
  return g;
}

// ---------- the pretend room for preview mode ----------

// A floor and a "real" ramp made of books and a tray, so aiming and the two-tap
// measurement can be tried on a laptop. Returns the meshes to aim at.
export function makePretendRoom() {
  const room = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), std(COLORS.floor, { roughness: 0.9 }));
  room.add(floor);
  const grid = new THREE.GridHelper(8, 40, 0xbfae8e, 0xcdbd9f);
  grid.position.y = 0.0005;
  room.add(grid);
  const ramp = new THREE.Group();
  room.add(ramp);
  const pretend = {
    room, floor, ramp, foot: { x: 0.15, y: 0, z: -0.05 }, run: 0.4,
    setBooks(books, bookCm) {
      ramp.clear();
      const h = books * bookCm / 100, bh = bookCm / 100;
      for (let i = 0; i < books; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, bh * 0.97, 0.21), std(COLORS.book[(i + 2) % COLORS.book.length]));
        b.position.set(pretend.foot.x - pretend.run - 0.06, bh * (i + 0.5), pretend.foot.z);
        ramp.add(b);
      }
      const len = Math.hypot(pretend.run, h);
      const tray = new THREE.Mesh(new THREE.BoxGeometry(len, 0.006, 0.14), std(0x8f8f8f, { roughness: 0.4 }));
      tray.position.set(pretend.foot.x - pretend.run / 2, h / 2 + 0.003, pretend.foot.z);
      tray.rotation.z = -Math.atan2(h, pretend.run);
      tray.userData.isTray = true;
      ramp.add(tray);
    },
    targets() { return [floor, ...ramp.children]; }
  };
  return pretend;
}

// ---------- short pop-up numbers (Repeat counting) ----------

export function makePops(parent) {
  const live = [];
  return {
    add(text, pos, color = '#14222C') {
      const s = makeLabel(text, { color, height: 0.04 });
      s.position.copy(v3(pos));
      s.position.y += 0.14;
      parent.add(s);
      live.push({ s, age: 0, keep: true });
      return s;
    },
    update(dt) {
      live.forEach((p) => { p.age += dt; if (p.age < 0.4) p.s.position.y += dt * 0.08; });
    },
    clear() { live.splice(0).forEach((p) => parent.remove(p.s)); }
  };
}
