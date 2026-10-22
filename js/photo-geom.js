// Geometry for the Photo Stage: turn one photo's depth map into 3D points Pip can walk on.
// Pure functions with plain {x, y, z} points, so they run in Node tests without three.js.
//
// Camera frame (as in three.js): the camera is at the origin looking down -z, x is right,
// y is up in the image. Depth Anything gives relative disparity d (near = big): the true
// inverse distance is scale * (d + shift), with both unknown. Angles depend only on the shift.
// Without help, d is mapped onto a guessed 1/near .. 1/far range, which flattens slopes.
// With the phone's tilt at photo time (gravity in the camera frame), the shift is solved so the
// fitted floor faces up (see calibrateShift). The scale then only sets sizes, not angles.

export const DEFAULTS = { hfovDeg: 66, near: 0.5, far: 4 };

// A pinhole camera for a photo of w x h pixels. Phone main cameras are roughly 65-75 degrees wide.
export function makeCamera(w, h, hfovDeg = DEFAULTS.hfovDeg) {
  const fx = (w / 2) / Math.tan(hfovDeg * Math.PI / 360);
  return { w, h, fx, fy: fx, cx: w / 2, cy: h / 2 };
}

export function disparityToDistance(d, near = DEFAULTS.near, far = DEFAULTS.far) {
  const t = Math.min(1, Math.max(0, d));
  return 1 / (1 / far + (1 / near - 1 / far) * t);
}

// Spread the disparity values over 0..1, clipping the extreme 2% at each end.
export function normalizeDisparity(values, lo = 0.02, hi = 0.98) {
  const sorted = Float32Array.from(values).sort();
  const a = sorted[Math.floor(lo * (sorted.length - 1))], b = sorted[Math.floor(hi * (sorted.length - 1))];
  const out = new Float32Array(values.length), span = Math.max(1e-6, b - a);
  for (let i = 0; i < values.length; i++) out[i] = Math.min(1, Math.max(0, (values[i] - a) / span));
  return out;
}

// depth: { data, width, height, channels } as returned by the depth model (0..255, near = bright).
// Mapping: either a guessed near/far range, or a calibrated { shift, scale } where
// 1 / distance = scale * (d + shift). Distances are capped at maxDist.
export function createSurface(depth, cam, { near = DEFAULTS.near, far = DEFAULTS.far, normalize = true, shift = null, scale = null, maxDist = 30 } = {}) {
  const { width: w, height: h, channels = 1 } = depth;
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = depth.data[i * channels] / 255;
  const disp = normalize ? normalizeDisparity(raw) : raw;
  const sx = cam.w / w, sy = cam.h / h;
  const calibrated = shift != null && scale != null;
  const distance = calibrated
    ? (d) => 1 / Math.max(1 / maxDist, scale * (d + shift))
    : (d) => disparityToDistance(d, near, far);

  function dispAt(px, py) {
    // bilinear lookup; px, py are in photo pixels
    const x = Math.min(w - 1.001, Math.max(0, px / sx - 0.5)), y = Math.min(h - 1.001, Math.max(0, py / sy - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    return (disp[i] * (1 - fx) + disp[i + 1] * fx) * (1 - fy) + (disp[i + w] * (1 - fx) + disp[i + w + 1] * fx) * fy;
  }
  function point(px, py) {
    const z = distance(dispAt(px, py));
    return { x: (px - cam.cx) / cam.fx * z, y: -(py - cam.cy) / cam.fy * z, z: -z };
  }
  function pixelOf(p) {
    const z = -p.z;
    return [p.x / z * cam.fx + cam.cx, -p.y / z * cam.fy + cam.cy];
  }
  return { cam, w, h, disp, dispAt, point, pixelOf, calibrated };
}

// ---------- calibration from the phone's tilt ----------

// "Up" in the phone's own frame (x right, y to the top of the screen, z out of the screen)
// from DeviceOrientation beta and gamma, in degrees. For the back camera held in portrait this
// is also "up" in the camera frame. Upright phone: (0, 1, 0). Flat on its back: (0, 0, 1).
export function upFromOrientation(betaDeg, gammaDeg) {
  const b = betaDeg * Math.PI / 180, g = gammaDeg * Math.PI / 180;
  return { x: -Math.sin(g) * Math.cos(b), y: Math.sin(b), z: Math.cos(g) * Math.cos(b) };
}

// The photo shown upright (EXIF applied) may be the phone turned sideways. Turn "up" in steps
// of 90 degrees about the camera axis to whichever way points most to the top of the photo.
export function upInPhoto(up) {
  const turns = [
    { x: up.x, y: up.y }, { x: -up.y, y: up.x }, { x: -up.x, y: -up.y }, { x: up.y, y: -up.x }
  ];
  let best = turns[0];
  turns.forEach((t) => { if (t.y > best.y) best = t; });
  return { x: best.x, y: best.y, z: up.z };
}

// "Up" for a camera tilted down by `deg` (no roll): the manual fallback.
export function upFromPitch(deg) {
  const p = deg * Math.PI / 180;
  return { x: 0, y: Math.cos(p), z: Math.sin(p) };
}

// The floor in disparity space. For any plane, disparity is a linear function of the normalized
// image coordinates: d = a * xn + b * yn + g, whatever the unknown shift and scale. RANSAC over
// the lower part of the photo finds it, and returns the floor samples' disparities too.
export function fitDispPlane(surface, { fromRow = 0.55, samples = 900, iters = 300, seed = 11, tol = 0.012 } = {}) {
  const { cam } = surface, rand = rng(seed), pts = [];
  for (let i = 0; i < samples; i++) {
    const px = rand() * cam.w, py = (fromRow + rand() * (1 - fromRow)) * cam.h;
    pts.push({ xn: (px - cam.cx) / cam.fx, yn: -(py - cam.cy) / cam.fy, d: surface.dispAt(px, py) });
  }
  let best = null;
  for (let k = 0; k < iters; k++) {
    const p = [0, 1, 2].map(() => pts[Math.floor(rand() * pts.length)]);
    // solve d = a xn + b yn + g through three samples (Cramer's rule)
    const m = p.map((q) => [q.xn, q.yn, 1]), det = det3(m);
    if (Math.abs(det) < 1e-9) continue;
    const r = p.map((q) => q.d);
    const a = det3(m.map((row, i) => [r[i], row[1], row[2]])) / det;
    const b = det3(m.map((row, i) => [row[0], r[i], row[2]])) / det;
    const g = det3(m.map((row, i) => [row[0], row[1], r[i]])) / det;
    const inl = pts.filter((q) => Math.abs(a * q.xn + b * q.yn + g - q.d) < tol);
    if (!best || inl.length > best.inl.length) best = { a, b, g, inl };
  }
  if (!best) return { ok: false, share: 0 };
  return { a: best.a, b: best.b, g: best.g, share: best.inl.length / pts.length, ok: best.inl.length / pts.length > 0.3, floorD: best.inl.map((q) => q.d) };
}
function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

// Solve the disparity shift so the floor faces "up". With 1/z = scale * (d + shift), the floor's
// normal in the camera frame is proportional to (a, b, -(g + shift)); it must be parallel to up,
// pointing the other way (the floor is below). The scale is set so the floor's middle distance
// is `floorDistance` metres: sizes are still a guess, angles are not.
export function calibrateShift(plane, up, { floorDistance = 1 } = {}) {
  if (!plane.ok) return { ok: false, reason: 'no_floor' };
  const h2 = up.x * up.x + up.y * up.y;
  if (h2 < 0.02) return { ok: false, reason: 'straight_down' };
  const lambda = (plane.a * up.x + plane.b * up.y) / h2;
  if (lambda >= 0) return { ok: false, reason: 'floor_upside_down' };
  const shift = -lambda * up.z - plane.g;
  const vals = plane.floorD.map((d) => d + shift).sort((p, q) => p - q);
  if (vals[0] <= 1e-4) return { ok: false, reason: 'behind_camera', shift };
  const mid = vals[Math.floor(vals.length / 2)];
  // how well the floor's own tilt (left-right) agrees with the sensor's roll: 0 = perfect
  const n = norm({ x: plane.a, y: plane.b, z: -(plane.g + shift) }), u = norm(up);
  const mismatchDeg = Math.acos(Math.min(1, Math.abs(dot(n, u)))) * 180 / Math.PI;
  return { ok: true, shift, scale: 1 / (floorDistance * mid), mismatchDeg };
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

// A small seeded random generator, so floor fitting gives the same answer every time.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Find the floor: the plane that most points in the lower part of the photo lie on (RANSAC).
// Returns the plane's normal (pointing up, toward the camera's "up"), offset and inlier share.
export function fitFloor(surface, { fromRow = 0.55, samples = 900, iters = 300, seed = 7 } = {}) {
  const { cam } = surface, rand = rng(seed), pts = [];
  for (let i = 0; i < samples; i++) {
    const px = rand() * cam.w, py = (fromRow + rand() * (1 - fromRow)) * cam.h;
    pts.push(surface.point(px, py));
  }
  let best = null;
  for (let k = 0; k < iters; k++) {
    const a = pts[Math.floor(rand() * pts.length)], b = pts[Math.floor(rand() * pts.length)], c = pts[Math.floor(rand() * pts.length)];
    let n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(n.x, n.y, n.z) < 1e-9) continue;
    n = norm(n);
    if (n.y < 0) n = { x: -n.x, y: -n.y, z: -n.z };
    if (n.y < 0.3) continue; // floors face up in the picture, not sideways
    const d = -dot(n, a);
    let count = 0;
    for (const p of pts) if (Math.abs(dot(n, p) + d) < 0.015 + 0.01 * -p.z) count++;
    if (!best || count > best.count) best = { n, d, count };
  }
  if (!best) return { n: { x: 0, y: 1, z: 0 }, d: 1, share: 0, ok: false };
  return { n: best.n, d: best.d, share: best.count / pts.length, ok: best.count / pts.length > 0.3 };
}

// Axes that stand on the floor: y along the floor normal, z toward the camera, x to the right.
// Pip's animation code assumes y is up, so he lives in this frame.
export function floorFrame(n) {
  const up = norm(n);
  let back = { x: 0, y: 0, z: 1 };
  back = norm(sub(back, { x: up.x * dot(back, up), y: up.y * dot(back, up), z: up.z * dot(back, up) }));
  const right = cross(up, back);
  return {
    right, up, back,
    toLocal: (p) => ({ x: dot(p, right), y: dot(p, up), z: dot(p, back) }),
    toCam: (q) => ({
      x: right.x * q.x + up.x * q.y + back.x * q.z,
      y: right.y * q.x + up.y * q.y + back.y * q.z,
      z: right.z * q.x + up.z * q.y + back.z * q.z
    })
  };
}

// Points along the surface between two pixels, one every `step` metres of 3D distance.
// Following the surface means Pip goes up and over whatever is between the two points.
export function surfacePath(surface, a, b, step = 0.06, fine = 120) {
  const dense = [];
  for (let i = 0; i <= fine; i++) {
    const t = i / fine;
    dense.push(surface.point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
  }
  const out = [dense[0]];
  let acc = 0;
  for (let i = 1; i < dense.length; i++) {
    acc += Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y, dense[i].z - dense[i - 1].z);
    if (acc >= step) { out.push(dense[i]); acc = 0; }
  }
  const last = dense[dense.length - 1], tail = out[out.length - 1];
  if (tail !== last) {
    if (Math.hypot(last.x - tail.x, last.y - tail.y, last.z - tail.z) < step * 0.4 && out.length > 1) out[out.length - 1] = last;
    else out.push(last);
  }
  return out;
}

// The ramp's slope from two taps. Depth models can misjudge a thin, plain tray (one render read
// it as a flat board floating above the floor), so the bottom is not taken from depth: a ramp's
// bottom touches the floor, so it is where the line through the bottom tap meets the floor
// plane. The top comes from depth. `floor` is { n, d } with n . p + d = 0, `up` is gravity's up.
export function rampFromPhotoTaps(surface, floor, up, bottomPx, topPx) {
  const { cam } = surface;
  const r = { x: (bottomPx[0] - cam.cx) / cam.fx, y: -(bottomPx[1] - cam.cy) / cam.fy, z: -1 };
  const den = dot(floor.n, r);
  if (Math.abs(den) < 1e-6) return { ok: false, reason: 'parallel' };
  const t = -floor.d / den;
  if (t <= 0) return { ok: false, reason: 'floor_behind' };
  const foot = { x: r.x * t, y: r.y * t, z: r.z * t };
  const top = surface.point(topPx[0], topPx[1]);
  const v = sub(top, foot), u = norm(up);
  const rise = dot(v, u);
  const run = Math.sqrt(Math.max(0, dot(v, v) - rise * rise));
  return { ok: true, foot, top, rise, run, angleDeg: Math.atan2(rise, run) * 180 / Math.PI };
}
