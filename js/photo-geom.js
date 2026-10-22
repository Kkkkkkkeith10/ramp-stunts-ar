// Geometry for the Photo Stage: turn one photo's depth map into 3D points Pip can walk on.
// Pure functions with plain {x, y, z} points, so they run in Node tests without three.js.
//
// Camera frame (as in three.js): the camera is at the origin looking down -z, x is right,
// y is up in the image. Depth Anything gives relative disparity (near = big), not metres, so
// distances are a guess: disparity is mapped onto 1/near .. 1/far. Shapes look right; true
// sizes need a known length (books or a shoe) to scale them.

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
export function createSurface(depth, cam, { near = DEFAULTS.near, far = DEFAULTS.far, normalize = true } = {}) {
  const { width: w, height: h, channels = 1 } = depth;
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = depth.data[i * channels] / 255;
  const disp = normalize ? normalizeDisparity(raw) : raw;
  const sx = cam.w / w, sy = cam.h / h;

  function dispAt(px, py) {
    // bilinear lookup; px, py are in photo pixels
    const x = Math.min(w - 1.001, Math.max(0, px / sx - 0.5)), y = Math.min(h - 1.001, Math.max(0, py / sy - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    return (disp[i] * (1 - fx) + disp[i + 1] * fx) * (1 - fy) + (disp[i + w] * (1 - fx) + disp[i + w + 1] * fx) * fy;
  }
  function point(px, py) {
    const z = disparityToDistance(dispAt(px, py), near, far);
    return { x: (px - cam.cx) / cam.fx * z, y: -(py - cam.cy) / cam.fy * z, z: -z };
  }
  function pixelOf(p) {
    const z = -p.z;
    return [p.x / z * cam.fx + cam.cx, -p.y / z * cam.fy + cam.cy];
  }
  return { cam, w, h, disp, dispAt, point, pixelOf };
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
