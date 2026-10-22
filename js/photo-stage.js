// Pip's Photo Stage: one photo, depth from Depth Anything V2 Small on this device, and Pip
// running around inside the photo in 3D. No AR session, no tracking, no floor scanning.
//
// The photo becomes a 3D surface built from the camera's own viewpoint, so from the "photo
// view" it lines up exactly with the photo, and nearer real things hide Pip. Pip lives in a
// floor frame (y along the fitted floor normal) so his hops stay upright.
import { THREE, makePip, applyPipPose, makeCar, placeCar, makeLabel } from './scene.js';
import { createPip, play, pose, settle } from './pip-anim.js';
import {
  makeCamera, createSurface, fitFloor, floorFrame, surfacePath, DEFAULTS,
  upFromOrientation, upInPhoto, upFromPitch, fitDispPlane, calibrateShift, rampFromPhotoTaps, scaleFromBooks
} from './photo-geom.js';
import { plural, ratioText } from './rules.js';
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

const $ = (s) => document.querySelector(s);
const nowSec = () => performance.now() / 1000;
const MODEL = 'onnx-community/depth-anything-v2-small';
const MAX_SIDE = 640;
const HOP = 0.06; // metres per hop at Pip's normal size (sizes are a guess, see photo-geom.js)
env.allowLocalModels = false;

const tech = { backend: '', loadS: 0, depthS: 0, floor: null, tilt: null, cal: null };
function status(text, cls) { const s = $('#status'); s.textContent = text; s.className = cls || ''; }
function say(text) {
  $('#bubble').textContent = text;
  if (window.speechSynthesis) {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.pitch = 1.35; speechSynthesis.speak(u); } catch (e) { /* no voice */ }
  }
}
function showTech() {
  const f = tech.floor, t = tech.tilt, c = tech.cal;
  $('#tech').textContent = 'Depth model ' + tech.backend + ', loaded in ' + tech.loadS.toFixed(1) + ' s, depth in ' + tech.depthS.toFixed(2) + ' s. ' +
    (t ? 'Camera tilt from ' + t.source + ': ' + t.deg.toFixed(0) + ' degrees down, roll ' + (t.roll || 0).toFixed(0) + '. ' : 'No camera tilt: depth is a guess, slopes may read flat. ') +
    (c ? (c.ok ? 'Depth calibrated (floor matches gravity within ' + c.mismatchDeg.toFixed(1) + ' degrees). ' : 'Calibration failed (' + c.reason + '), using the guess. ') : '') +
    (f ? 'Floor fit ' + Math.round(f.share * 100) + '% of the lower photo' + (f.ok ? '' : ' (weak, so "up" may be off)') + '.' : '');
}

// ---------- the phone's tilt at photo time ----------

// Keep the last second of DeviceOrientation readings. The in-page camera takes the photo and
// the tilt at the same moment (averaged over the last half second, so a small shake does not
// spoil it). The camera-app fallback can only read just before and just after.
// iPhone asks permission first, on a tap.
const tiltLog = [];
window.addEventListener('deviceorientation', (e) => {
  if (e.beta == null || e.gamma == null) return;
  const now = performance.now();
  tiltLog.push({ beta: e.beta, gamma: e.gamma, at: now });
  while (tiltLog.length && now - tiltLog[0].at > 1000) tiltLog.shift();
});
let tiltBefore = null;
function readTilt() {
  const r = tiltLog[tiltLog.length - 1];
  return r ? { ...r } : null;
}
// Average of the last `ms` of readings, and how much they wandered (degrees).
function averageTilt(ms = 500) {
  const now = performance.now(), recent = tiltLog.filter((r) => now - r.at <= ms);
  if (!recent.length) return null;
  const avg = (k) => recent.reduce((s, r) => s + r[k], 0) / recent.length;
  const spread = (k) => Math.max(...recent.map((r) => r[k])) - Math.min(...recent.map((r) => r[k]));
  return { beta: avg('beta'), gamma: avg('gamma'), at: now, count: recent.length, wander: Math.max(spread('beta'), spread('gamma')) };
}
async function askTiltPermission() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') { try { await D.requestPermission(); } catch (e) { /* refused */ } }
}
// "Up" in the camera frame, how far the camera points down, and its roll, from a reading.
function tiltFromReading(r, source) {
  const up = upInPhoto(upFromOrientation(r.beta, r.gamma));
  return { up, deg: Math.asin(Math.max(-1, Math.min(1, up.z))) * 180 / Math.PI, roll: Math.atan2(up.x, up.y) * 180 / Math.PI, source };
}
function tiltFromDeg(deg, source) { return { up: upFromPitch(deg), deg, roll: 0, source }; }

// ---------- the depth model ----------

let estimator = null;
async function loadModel() {
  const hasGPU = !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  tech.backend = hasGPU ? 'webgpu' : 'wasm';
  status('Pip is learning to see (downloading the depth model, ' + (hasGPU ? '50' : '27') + ' MB the first time)...');
  const t0 = performance.now();
  let last = -1;
  estimator = await pipeline('depth-estimation', MODEL, {
    device: tech.backend, dtype: hasGPU ? 'fp16' : 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        const pct = Math.round(p.loaded / p.total * 100);
        if (pct !== last) { last = pct; status('Pip is learning to see: ' + pct + '%'); }
      }
    }
  });
  tech.loadS = (performance.now() - t0) / 1000;
  status('Ready. Take or choose a photo.', 'ok');
}

// ---------- photo in, depth out ----------

// Shrink big phone photos first: faster, and the model works at about 518 px anyway.
async function shrink(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return { canvas: c, url: URL.createObjectURL(blob), w: c.width, h: c.height };
}

let photo = null, depth = null;
// sensorTilt: the tilt measured when this photo was taken, or null if unknown (a library photo).
async function usePhoto(url, sensorTilt = null) {
  if (!estimator) { status('Pip is still learning to see. Try again in a moment.'); return; }
  status('Pip is looking at your photo...');
  say('Ooh, let me look...');
  photo = await shrink(url);
  photo.sensorTilt = sensorTilt;
  worldScale = { k: 1, fromBooks: false, books: 0 };
  const image = await RawImage.read(photo.url);
  const t0 = performance.now();
  depth = (await estimator(image)).depth;
  tech.depthS = (performance.now() - t0) / 1000;
  buildStage();
  status('Done.', 'ok');
  $('#pick').hidden = true;
  $('#stagebox').hidden = false;
  $('#controls').hidden = false;
  $('#stagebox').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- three.js stage ----------

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0E1920);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(0.5, 1, 0.8);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.02, 30);

let surface = null, frame = null, mesh = null, floorGroup = null, pipModel = null;
let pipA = null, pipPx = null, hopRun = null, carRun = null, ramp = null, mode = 'walk';
const view = { yaw: 0, pitch: 0, zoom: 1, pivot: new THREE.Vector3(0, 0, -1.5) };
let meshView = false, helpers = null;
const labels = [];

// The stage's size factor: 1 = the guess (floor about 1 m away); set from the child's books.
let worldScale = { k: 1, fromBooks: false, books: 0 };

// Book thickness and shoe length, shared with the AR app on this phone (same storage key).
function loadSizes() {
  const s = { bookCm: 2.5, shoeCm: 18 };
  try { Object.assign(s, JSON.parse(localStorage.getItem('rsar-settings') || '{}')); } catch (e) { /* private mode */ }
  return s;
}
function saveSizes(patch) {
  try {
    const all = JSON.parse(localStorage.getItem('rsar-settings') || '{}');
    localStorage.setItem('rsar-settings', JSON.stringify({ ...all, ...patch }));
  } catch (e) { /* ignore */ }
}

function settingsNow() {
  return { size: Number($('#size').value) / 100, depthAmt: Number($('#depthAmt').value) / 100 };
}

// Which tilt to use: the sensor's (default), one set by hand, or none (the old guess).
function effectiveTilt() {
  const m = $('#tiltMode').value;
  if (m === 'off') return null;
  if (m === 'manual') return tiltFromDeg(Number($('#tiltDeg').value), 'hand setting');
  return photo.sensorTilt;
}

function buildStage(keep = null) {
  buildStageInner(keep);
  applyMeshView();
}

// ---------- "Show 3D mesh": check what the depth model and the maths made of the photo ----------

// Wireframe in depth colours, plus: the fitted floor as a grid, gravity's "up" as an arrow,
// the measured ramp (foot on the floor to the top) as a line, and the camera where the photo
// was taken. Free orbit and zoom.
function applyMeshView() {
  if (!mesh) return;
  if (helpers) { helpers.forEach((h) => h.parent && h.parent.remove(h)); helpers = null; }
  const m = mesh.material;
  if (!meshView) { applyShowDepth(); return; }
  m.map = null; m.vertexColors = true; m.needsUpdate = true;
  helpers = [];
  const v = (a) => new THREE.Vector3(a.x, a.y, a.z);

  // a coarse wire grid over the solid depth colours, so the shape reads at a glance
  const segX = 48, segY = Math.max(2, Math.round(segX * photo.h / photo.w)), pts = [];
  const P = (i, j) => surface.point(i / segX * photo.w, j / segY * photo.h);
  for (let j = 0; j <= segY; j++) for (let i = 0; i <= segX; i++) {
    const p = P(i, j);
    if (i < segX) { const q = P(i + 1, j); pts.push(p.x, p.y, p.z, q.x, q.y, q.z); }
    if (j < segY) { const q = P(i, j + 1); pts.push(p.x, p.y, p.z, q.x, q.y, q.z); }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x0E1920, transparent: true, opacity: 0.45 }));
  scene.add(wire); helpers.push(wire);

  // the floor: a grid on the fitted plane, under the middle of the photo
  const f = tech.floor, p0 = { x: -f.d * f.n.x, y: -f.d * f.n.y, z: -f.d * f.n.z };
  const floorY = local(p0).y, mid = local(view.pivot);
  const grid = new THREE.GridHelper(2 * worldScale.k, 20, 0x0B7A85, 0x4c8c94);
  grid.position.set(mid.x, floorY + 0.001, mid.z);
  floorGroup.add(grid); helpers.push(grid);

  // gravity's up, from the floor under the middle
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(mid.x, floorY, mid.z), 0.3 * worldScale.k, 0xD9A400);
  floorGroup.add(arrow); helpers.push(arrow);

  // the measured ramp
  if (ramp && ramp.footC && ramp.topC) {
    const a = local(ramp.footC), b = local(ramp.topC);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v(a), v(b)]), new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false }));
    line.renderOrder = 20;
    floorGroup.add(line); helpers.push(line);
    [a, b].forEach((p) => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.012 * worldScale.k, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false }));
      s.position.copy(v(p)); s.renderOrder = 20;
      floorGroup.add(s); helpers.push(s);
    });
    // the floor point straight under the top, to show rise and run
    const under = { x: b.x, y: a.y, z: b.z };
    const legs = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v(a), v(under), v(b)]), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.01, gapSize: 0.008, depthTest: false }));
    legs.computeLineDistances(); legs.renderOrder = 20;
    floorGroup.add(legs); helpers.push(legs);
  }

  // where the camera was (the photo's viewpoint)
  const shot = new THREE.PerspectiveCamera(camera.fov, photo.w / photo.h, 0.02, 0.25 * worldScale.k);
  shot.updateMatrixWorld(true);
  const ch = new THREE.CameraHelper(shot);
  scene.add(ch); helpers.push(ch);
}

$('#meshBtn').addEventListener('click', () => {
  meshView = !meshView;
  $('#meshBtn').setAttribute('aria-pressed', String(meshView));
  $('#meshBtn').textContent = meshView ? 'Back to the photo' : 'Show 3D mesh';
  $('#meshTip').textContent = meshView
    ? 'Mesh view: drag to orbit, pinch or scroll to zoom. Grid = the floor Pip found. Yellow arrow = up from the tilt sensor. Red line = the ramp as measured, white dashes = its rise and run. The small frame shows where the camera was.'
    : 'Drag to tilt the stage. Tap to move Pip. Nearer real things hide him.';
  // start the mesh view from the side, centred on the ramp if Pip has measured one
  if (meshView) {
    view.homePivot = view.pivot.clone();
    if (ramp && ramp.footC && ramp.topC) view.pivot.set((ramp.footC.x + ramp.topC.x) / 2, (ramp.footC.y + ramp.topC.y) / 2, (ramp.footC.z + ramp.topC.z) / 2);
    view.yaw = 0.9; view.pitch = 0.35; view.zoom = ramp && ramp.footC ? 0.9 : 1.8;
  } else {
    if (view.homePivot) view.pivot.copy(view.homePivot);
    view.yaw = 0; view.pitch = 0; view.zoom = 1;
  }
  setTag(meshView ? '3D mesh view' : 'Tap the floor to move Pip');
  applyMeshView();
});

// keep: { pipPx, ramp: { bottomPx, topPx, hops } } to rebuild without the drop-in (after resizing).
function buildStageInner(keep = null) {
  const { size, depthAmt } = settingsNow();
  const cam = makeCamera(photo.w, photo.h);
  const far = DEFAULTS.near + (DEFAULTS.far - DEFAULTS.near) * depthAmt;
  surface = createSurface(depth, cam, { near: DEFAULTS.near, far, distScale: worldScale.k });

  // With the camera's tilt, solve the depth shift so the floor faces up (see photo-geom.js).
  tech.tilt = effectiveTilt();
  tech.cal = null;
  if (tech.tilt) {
    tech.cal = calibrateShift(fitDispPlane(surface), tech.tilt.up);
    if (tech.cal.ok) surface = createSurface(depth, cam, { shift: tech.cal.shift, scale: tech.cal.scale, distScale: worldScale.k });
  }
  tech.floor = fitFloor(surface);
  // gravity is the better "up" when we have it; otherwise the fitted floor
  frame = floorFrame(tech.cal && tech.cal.ok ? tech.tilt.up : tech.floor.n);

  // clear the old stage
  [mesh, floorGroup].forEach((o) => { if (o) scene.remove(o); });
  labels.length = 0; ramp = null; carRun = null; hopRun = null;
  $('#carBtn').disabled = true;

  // the photo as a surface: a grid of points pushed out to their guessed distance
  const segX = 160, segY = Math.max(2, Math.round(segX * photo.h / photo.w));
  const pos = new Float32Array((segX + 1) * (segY + 1) * 3), uv = new Float32Array((segX + 1) * (segY + 1) * 2);
  const col = new Float32Array((segX + 1) * (segY + 1) * 3), idx = [];
  for (let j = 0; j <= segY; j++) for (let i = 0; i <= segX; i++) {
    const k = j * (segX + 1) + i, px = i / segX * photo.w, py = j / segY * photo.h, p = surface.point(px, py);
    pos.set([p.x, p.y, p.z], k * 3);
    uv.set([i / segX, 1 - j / segY], k * 2);
    const t = surface.dispAt(px, py);
    col.set([0.05 + 0.9 * t, 0.2 + 0.5 * t * (1 - t) * 2, 0.55 * (1 - t) + 0.1], k * 3);
    if (i < segX && j < segY) idx.push(k, k + segX + 1, k + 1, k + 1, k + segX + 1, k + segX + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  const tex = new THREE.CanvasTexture(photo.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  mesh.userData.tex = tex;
  scene.add(mesh);
  applyShowDepth();

  // Pip's world: axes standing on the fitted floor
  floorGroup = new THREE.Group();
  floorGroup.matrixAutoUpdate = false;
  const v = (a) => new THREE.Vector3(a.x, a.y, a.z);
  floorGroup.matrix.makeBasis(v(frame.right), v(frame.up), v(frame.back));
  scene.add(floorGroup);
  pipModel = makePip();
  pipModel.scale.setScalar(size);
  floorGroup.add(pipModel);

  // the camera: the photo's own viewpoint, with a little tilt around the middle of the photo
  camera.fov = 2 * Math.atan((photo.h / 2) / cam.fy) * 180 / Math.PI;
  camera.aspect = photo.w / photo.h;
  camera.updateProjectionMatrix();
  const mid = surface.point(photo.w / 2, photo.h / 2);
  view.pivot.set(mid.x, mid.y, mid.z);
  view.yaw = 0; view.pitch = 0;
  sizeCanvas();

  // Pip drops in near the bottom middle of the photo, on the floor (or stays put after resizing)
  pipPx = keep ? keep.pipPx : [photo.w * 0.5, photo.h * 0.86];
  const land = local(surface.point(pipPx[0], pipPx[1]));
  pipA = createPip(land);
  const cam0 = local({ x: 0, y: 0, z: 0 });
  pipModel.rotation.y = Math.atan2(cam0.x - land.x, cam0.z - land.z); // start facing the child
  mode = 'walk';
  setTag('Tap the floor to move Pip');
  $('#booksBox').hidden = true;
  if (keep && keep.ramp) {
    ramp = { ...keep.ramp };
    marker(local(surface.point(...ramp.bottomPx)), 0x0B7A85);
    marker(local(surface.point(...ramp.topPx)), 0xD9A400);
    measureRamp();
    $('#carBtn').disabled = false;
    return;
  }
  const up = 0.35 * size;
  hopAlong([{ x: land.x, y: land.y + up, z: land.z }, land], { hopSec: 0.55, hopHeight: 0 }, () => say("Wheee! I'm in your photo! Tap the floor and I'll hop there."));
  showTech();
}

const local = (p) => frame.toLocal(p);

function sizeCanvas() {
  if (!photo) return;
  const w = canvas.clientWidth || 360;
  const h = Math.min(window.innerHeight * 0.68, w * photo.h / photo.w);
  canvas.style.height = h + 'px';
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', sizeCanvas);

function applyShowDepth() {
  if (!mesh) return;
  const show = $('#showDepth').checked;
  mesh.material.map = show ? null : mesh.userData.tex;
  mesh.material.vertexColors = show;
  mesh.material.needsUpdate = true;
}

// ---------- Pip moves ----------

function hopAlong(path, opts, onDone, onStep) {
  const { size } = settingsNow();
  if (path.length < 2) { if (onDone) onDone(); return; }
  play(pipA, 'hop', nowSec(), { path, hopSec: opts.hopSec || 0.38, hopHeight: opts.hopHeight != null ? opts.hopHeight : 0.045 * size });
  hopRun = { counted: 0, onDone, onStep };
}

// A path over the photo's surface from one pixel to another, as Pip-frame points.
function pathTo(fromPx, toPx, maxHops = 28) {
  const { size } = settingsNow();
  let step = HOP * size, pts = surfacePath(surface, fromPx, toPx, step);
  if (pts.length > maxHops + 1) pts = surfacePath(surface, fromPx, toPx, step * (pts.length - 1) / maxHops);
  return pts.map(local);
}

function walkTo(px) {
  if (hopRun) return;
  const path = pathTo(pipPx, px);
  say(path.length > 12 ? 'That is far! Hop, hop, hop...' : 'Hop!');
  hopAlong(path, {}, () => { pipPx = px; say(['Here!', 'Made it!', 'Tap somewhere else!'][Math.floor(Math.random() * 3)]); });
}

function addLabel(text, p, color = '#8a6500') {
  const { size } = settingsNow();
  const s = makeLabel(text, { color, height: 0.035 * Math.max(0.7, size) });
  s.position.set(p.x, p.y + 0.15 * size, p.z);
  floorGroup.add(s);
  labels.push(s);
  return s;
}
function clearLabels() { labels.splice(0).forEach((s) => floorGroup.remove(s)); }

function marker(p, color) {
  const { size } = settingsNow();
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.012 * size, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.set(p.x, p.y + 0.005, p.z);
  m.renderOrder = 15;
  floorGroup.add(m);
  labels.push(m);
}

// ---------- the ramp: tap the bottom, then the top; Pip climbs and counts ----------

function rampTap(px) {
  if (mode === 'rampBottom') {
    clearLabels();
    ramp = { bottomPx: px };
    marker(local(surface.point(px[0], px[1])), 0x0B7A85);
    mode = 'rampTop';
    setTag('Now tap the top of the ramp');
    say('And where is the top?');
    return;
  }
  ramp.topPx = px;
  marker(local(surface.point(px[0], px[1])), 0xD9A400);
  mode = 'busy';
  setTag('Watch Pip climb');
  say('Here I go!');
  hopAlong(pathTo(pipPx, ramp.bottomPx), {}, () => {
    pipPx = ramp.bottomPx;
    const climb = pathTo(ramp.bottomPx, ramp.topPx, 16);
    hopAlong(climb, { hopSec: 0.5 }, () => {
      pipPx = ramp.topPx;
      ramp.hops = climb.length - 1;
      measureRamp();
      say(ramp.hops + ' hops to the top! ' + (ramp.rise > 0.01 ? 'How many books high is it?' : 'Hmm, that looked flat to me.'));
      mode = 'walk';
      setTag('Tap the floor to move Pip');
      $('#carBtn').disabled = false;
      $('#booksBox').hidden = !(ramp.rise > 0.005);
    }, (k) => addLabel(String(k), climb[k]));
  });
}

// Slope numbers: the bottom on the floor, the top from depth (Pip's hops follow the photo).
function measureRamp() {
  const m = rampFromPhotoTaps(surface, tech.floor, frame.up, ramp.bottomPx, ramp.topPx);
  if (m.ok) { ramp.rise = m.rise; ramp.run = m.run; ramp.footC = m.foot; ramp.topC = m.top; }
  else {
    const a = local(surface.point(...ramp.bottomPx)), b = local(surface.point(...ramp.topPx));
    ramp.rise = b.y - a.y; ramp.run = Math.hypot(b.x - a.x, b.z - a.z);
  }
  showTech();
  $('#tech').textContent += ' Ramp: ' + Math.round(ramp.run * 100) + ' cm across, ' + Math.round(ramp.rise * 100) + ' cm up, ' +
    Math.round(Math.atan2(ramp.rise, ramp.run) * 180 / Math.PI) + ' degrees' +
    (worldScale.fromBooks ? ' (sized from ' + plural(worldScale.books, 'book') + ').' : ' (sizes are a guess until you tell Pip the books).');
  if (meshView) applyMeshView();
}

// The child's book count sets the real size: rebuild the stage scaled about the camera, so the
// photo view, Pip's spot and the ramp taps all stay where they are.
function applyBooks() {
  const books = Number($('#booksVal').textContent), s = loadSizes();
  const r = scaleFromBooks(ramp.rise, books, s.bookCm);
  if (!r.ok) { say('Hmm, I could not work that out. Try showing me the ramp again.'); return; }
  worldScale = { k: worldScale.k * r.k, fromBooks: true, books };
  const keep = { pipPx, ramp: { bottomPx: ramp.bottomPx, topPx: ramp.topPx, hops: ramp.hops } };
  buildStage(keep);
  const across = Math.max(1, Math.round(ramp.run * 100 / s.shoeCm));
  ramp.books = books; ramp.across = across;
  $('#booksBox').hidden = true;
  say('Now I know how big it is! ' + ratioText(books, across) + '.');
}

// ---------- Pip's ghost car: down the ramp and along the floor beyond it ----------

function ghostCar() {
  if (!ramp || !ramp.topPx || ramp.hops == null || carRun) return;
  const { size } = settingsNow();
  // keep going past the bottom, the same way, for twice the ramp's length (in the photo)
  const dx = ramp.bottomPx[0] - ramp.topPx[0], dy = ramp.bottomPx[1] - ramp.topPx[1];
  const endPx = [
    Math.min(photo.w - 2, Math.max(2, ramp.bottomPx[0] + dx * 2)),
    Math.min(photo.h - 2, Math.max(2, ramp.bottomPx[1] + dy * 2))
  ];
  const down = surfacePath(surface, ramp.topPx, ramp.bottomPx, 0.01).map(local);
  const on = surfacePath(surface, ramp.bottomPx, endPx, 0.01).map(local);
  const pts = down.concat(on.slice(1));
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  const car = makeCar(0xEE8A1F, true);
  car.scale.setScalar(size);
  floorGroup.add(car);
  carRun = { car, pts, len, rampLen: len[down.length - 1], start: nowSec(), dur: 2.6 };
  say('Watch my bet... vroom!');
}

function carAt(c, s) {
  let i = 1;
  while (i < c.len.length - 1 && c.len[i] < s) i++;
  const a = c.pts[i - 1], b = c.pts[i], seg = Math.max(1e-6, c.len[i] - c.len[i - 1]), t = Math.min(1, Math.max(0, (s - c.len[i - 1]) / seg));
  const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  const flat = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
  return { p, dir: { x: (b.x - a.x) / flat, y: 0, z: (b.z - a.z) / flat }, pitch: Math.atan2(b.y - a.y, flat) * 180 / Math.PI };
}

// ---------- input: drag to tilt, tap to act ----------

const ray = new THREE.Raycaster();
let press = null;
const fingers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  press = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: fingers.size > 1 ? 99 : 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (fingers.size === 2 && fingers.has(e.pointerId)) {
    // pinch to zoom (mesh view)
    const [a, b] = [...fingers.values()], before = Math.hypot(a.x - b.x, a.y - b.y);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [c, d] = [...fingers.values()], after = Math.hypot(c.x - d.x, c.y - d.y);
    if (meshView && before > 0 && after > 0) view.zoom = Math.max(0.3, Math.min(4, view.zoom * before / after));
    press.moved = 99;
    return;
  }
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  press.moved += Math.abs(e.clientX - press.lx) + Math.abs(e.clientY - press.ly);
  if (press.moved > 10) {
    // a little tilt in the photo view; free orbit in the mesh view
    const yawMax = meshView ? Math.PI : 0.55, pitchMin = meshView ? -0.3 : -0.45, pitchMax = meshView ? 1.45 : 0.45;
    view.yaw = Math.max(-yawMax, Math.min(yawMax, view.yaw - (e.clientX - press.lx) * 0.005));
    view.pitch = Math.max(pitchMin, Math.min(pitchMax, view.pitch - (e.clientY - press.ly) * 0.005));
  }
  press.lx = e.clientX; press.ly = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  if (!meshView) return;
  e.preventDefault();
  view.zoom = Math.max(0.3, Math.min(4, view.zoom * (1 + e.deltaY * 0.001)));
}, { passive: false });
canvas.addEventListener('pointerup', (e) => {
  fingers.delete(e.pointerId);
  const p = press; press = null;
  if (!p || p.moved > 10 || !mesh) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, camera);
  const hit = ray.intersectObject(mesh, false)[0];
  if (!hit) return;
  tapPixel(surface.pixelOf(hit.point));
});
canvas.addEventListener('pointercancel', (e) => { fingers.delete(e.pointerId); press = null; });

function tapPixel(px) {
  if (mode === 'walk') walkTo(px);
  else if (mode === 'rampBottom' || mode === 'rampTop') rampTap(px);
}

function setTag(t) { $('#tag').textContent = t; }

$('#rampBtn').addEventListener('click', () => {
  if (hopRun) return;
  mode = 'rampBottom';
  $('#booksBox').hidden = true;
  setTag('Tap the bottom of the ramp');
  say('Show me your ramp! Tap the bottom first.');
});
$('#carBtn').addEventListener('click', ghostCar);
$('#homeBtn').addEventListener('click', () => { view.yaw = 0; view.pitch = 0; view.zoom = 1; });
$('#newBtn').addEventListener('click', () => {
  $('#pick').hidden = false; $('#stagebox').hidden = true; $('#controls').hidden = true;
  say('New photo? Show me!');
});
$('#size').addEventListener('change', () => { if (photo) buildStage(); });
$('#depthAmt').addEventListener('change', () => { if (photo) buildStage(); });
$('#showDepth').addEventListener('change', applyShowDepth);
$('#tiltMode').addEventListener('change', () => { if (photo) buildStage(); });
$('#booksMinus').addEventListener('click', () => { $('#booksVal').textContent = Math.max(1, Number($('#booksVal').textContent) - 1); });
$('#booksPlus').addEventListener('click', () => { $('#booksVal').textContent = Math.min(12, Number($('#booksVal').textContent) + 1); });
$('#booksBtn').addEventListener('click', applyBooks);
{
  const s = loadSizes();
  $('#bookCm').value = s.bookCm; $('#shoeCm').value = s.shoeCm;
  $('#bookCm').addEventListener('change', () => saveSizes({ bookCm: Math.min(8, Math.max(0.5, Number($('#bookCm').value) || 2.5)) }));
  $('#shoeCm').addEventListener('change', () => saveSizes({ shoeCm: Math.min(35, Math.max(10, Number($('#shoeCm').value) || 18)) }));
}
$('#tiltDeg').addEventListener('input', () => { $('#tiltVal').textContent = $('#tiltDeg').value + ' deg'; });
$('#tiltDeg').addEventListener('change', () => { if (photo && $('#tiltMode').value === 'manual') buildStage(); });

// ---------- the in-page camera: photo and tilt at the same moment ----------

let stream = null;
$('#camBtn').addEventListener('click', async () => {
  // no in-page camera here: fall back to the camera app (still inside this tap)
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { tiltBefore = readTilt(); $('#cam').click(); return; }
  askTiltPermission(); // iPhone: must be asked on the tap
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }
    });
  } catch (err) {
    status('The camera could not open here (' + (err && err.name ? err.name : 'blocked') + '). Use "Choose a photo", or allow the camera for this page.', 'err');
    return;
  }
  const v = $('#video');
  v.srcObject = stream;
  await v.play().catch(() => {});
  $('#pick').hidden = true;
  $('#camView').hidden = false;
  say('Point me at your ramp. Hold still, then tap Take it.');
});

function closeCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('#video').srcObject = null;
  $('#camView').hidden = true;
}

$('#camCancel').addEventListener('click', () => { closeCamera(); $('#pick').hidden = false; });

$('#snapBtn').addEventListener('click', async () => {
  const v = $('#video');
  if (!v.videoWidth) return;
  // the frame and the tilt, together
  const reading = averageTilt(500);
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  closeCamera();
  let tilt = null;
  if (reading) {
    tilt = tiltFromReading(reading, 'phone sensor at the moment of the photo');
    if (reading.wander > 3) tilt.source += ' (the phone was moving ' + reading.wander.toFixed(0) + ' degrees)';
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  usePhoto(URL.createObjectURL(blob), tilt).catch(fail);
});

// live tilt readout and a horizon line while the camera is open
function showLiveTilt() {
  if ($('#camView').hidden) return;
  const r = averageTilt(300), el = $('#tiltLive'), hz = $('#horizon');
  if (!r) { el.textContent = 'No tilt reading yet (move the phone a little)'; hz.hidden = true; return; }
  const t = tiltFromReading(r, '');
  hz.hidden = false;
  hz.style.transform = 'rotate(' + t.roll.toFixed(1) + 'deg)';
  hz.classList.toggle('level', Math.abs(t.roll) < 2);
  el.textContent = 'Camera points ' + t.deg.toFixed(0) + ' degrees down' + (Math.abs(t.roll) >= 2 ? ', tipped ' + Math.abs(t.roll).toFixed(0) + ' degrees' : ', level') +
    (r.wander > 3 ? ' · hold still' : '');
}

// Fallback: the phone's camera app. Tilt is read just before it opens (tiltBefore, set when the
// button falls back) and just after it returns.
$('#cam').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  // give the sensor a moment to report again now the page is back
  const back = performance.now();
  await new Promise((r) => setTimeout(r, 600));
  const after = readTilt();
  const r = after && after.at > back ? after : tiltBefore;
  let tilt = r ? tiltFromReading(r, 'phone sensor') : null;
  if (tilt && tiltBefore && after && after.at > back) {
    const moved = Math.abs(after.beta - tiltBefore.beta) + Math.abs(after.gamma - tiltBefore.gamma);
    if (moved > 8) tilt.source = 'phone sensor (phone moved, keep it on the stand)';
  }
  usePhoto(URL.createObjectURL(f), tilt).catch(fail);
});
$('#lib').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) usePhoto(URL.createObjectURL(f), null).catch(fail); // tilt unknown for older photos
});
// the sample was rendered by a camera tilted down about 33 degrees
$('#sample').addEventListener('click', () => usePhoto('sample-ramp.jpg', tiltFromDeg(33, 'the sample\'s camera')).catch(fail));
function fail(err) { status('Something went wrong: ' + (err && err.message ? err.message : err), 'err'); console.error(err); }

// ---------- per frame ----------

function step() {
  const now = nowSec();
  if (mesh) {
    // orbit the photo's middle; at yaw = pitch = 0 the camera is exactly where the photo was taken
    const d = view.pivot.length() * view.zoom;
    const dir = new THREE.Vector3(Math.sin(view.yaw) * Math.cos(view.pitch), Math.sin(view.pitch), Math.cos(view.yaw) * Math.cos(view.pitch));
    camera.position.copy(view.pivot).addScaledVector(dir, d);
    camera.lookAt(view.pivot);

    if (pipA) {
      const p = pose(pipA, now);
      if (hopRun) {
        while (hopRun.counted < p.step) { hopRun.counted++; if (hopRun.onStep) hopRun.onStep(hopRun.counted); }
        if (p.done) { const h = hopRun; hopRun = null; settle(pipA, now); if (h.onDone) h.onDone(); }
      } else if (p.done) settle(pipA, now);
      applyPipPose(pipModel, pose(pipA, now), local(camera.position));
    }

    if (carRun) {
      const c = carRun, u = Math.min(1, (now - c.start) / c.dur), total = c.len[c.len.length - 1];
      // speed up down the ramp, then slow to a stop
      const s = u < 0.35 ? (u / 0.35) ** 2 * c.rampLen : c.rampLen + (1 - (1 - (u - 0.35) / 0.65) ** 2) * (total - c.rampLen);
      const at = carAt(c, Math.min(total, s));
      placeCar(c.car, at.p, at.dir, at.pitch);
      if (u >= 1 && now - c.start > c.dur + 1.5) { floorGroup.remove(c.car); carRun = null; }
    }
    renderer.render(scene, camera);
  }
}
function loop() { step(); showLiveTilt(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);

loadModel().catch(fail);

// For headless tests.
window.__stage = {
  usePhoto, tapPixel, get ready() { return !!estimator; }, get mode() { return mode; }, get busy() { return !!hopRun || !!carRun; },
  get ramp() { return ramp; }, get pipPx() { return pipPx; }, tech, ghostCar,
  // height above the floor (metres, in Pip's frame) at a photo pixel
  heightAt(px, py) { return local(surface.point(px, py)).y - local(surface.point(photo.w * 0.5, photo.h * 0.95)).y; },
  dispAt(px, py) { return surface.dispAt(px, py); }, frames(n = 1) { for (let i = 0; i < n; i++) step(); }
};
