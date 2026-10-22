import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCamera, disparityToDistance, createSurface, fitFloor, floorFrame, surfacePath } from '../js/photo-geom.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' is not near ' + b);

// A synthetic depth map: a flat floor 1 m below a camera tilted down by `pitchDeg`,
// written as disparity in the same 0..255 scale the model gives.
function floorDepth(w, h, pitchDeg, cam, nearM = 0.5, farM = 4) {
  const data = new Uint8Array(w * h), p = -pitchDeg * Math.PI / 180;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x + 0.5 - cam.cx) / cam.fx, dy = -(y + 0.5 - cam.cy) / cam.fy;
    // camera ray (dx, dy, -1) in world: rotate about x by the pitch
    const wy = dy * Math.cos(p) - (-1) * Math.sin(p);
    const z = wy < -1e-3 ? Math.min(farM, 1 / -wy) : farM; // depth along the optical axis
    const d = (1 / z - 1 / farM) / (1 / nearM - 1 / farM);
    data[y * w + x] = Math.round(Math.min(1, Math.max(0, d)) * 255);
  }
  return { data, width: w, height: h, channels: 1 };
}

test('disparity maps onto the near..far range', () => {
  near(disparityToDistance(1), 0.5); near(disparityToDistance(0), 4);
  assert.ok(disparityToDistance(0.5) > 0.5 && disparityToDistance(0.5) < 4);
});

test('a surface point projects back to the same pixel', () => {
  const cam = makeCamera(200, 150);
  const s = createSurface(floorDepth(200, 150, 35, cam), cam, { normalize: false });
  const p = s.point(120, 110), px = s.pixelOf(p);
  near(px[0], 120, 1e-6); near(px[1], 110, 1e-6);
  assert.ok(p.z < 0, 'in front of the camera');
});

test('the floor fit finds the floor under a tilted camera', () => {
  const cam = makeCamera(200, 150);
  const s = createSurface(floorDepth(200, 150, 35, cam), cam, { normalize: false });
  const f = fitFloor(s);
  assert.ok(f.ok, 'share ' + f.share);
  // world up seen from a camera pitched down 35 degrees
  near(f.n.x, 0, 0.05); near(f.n.y, Math.cos(35 * Math.PI / 180), 0.05); near(f.n.z, Math.sin(35 * Math.PI / 180), 0.05);
});

test('the floor frame makes the floor normal "up"', () => {
  const fr = floorFrame({ x: 0, y: 0.8, z: 0.6 });
  const u = fr.toLocal({ x: 0, y: 0.8, z: 0.6 });
  near(u.x, 0); near(u.y, 1); near(u.z, 0);
  const q = { x: 0.3, y: -0.2, z: 0.5 }, back = fr.toCam(fr.toLocal(q));
  near(back.x, q.x); near(back.y, q.y); near(back.z, q.z);
});

test('a surface path is evenly spaced and ends at the target', () => {
  const cam = makeCamera(200, 150);
  const s = createSurface(floorDepth(200, 150, 35, cam), cam, { normalize: false });
  const path = surfacePath(s, [40, 120], [160, 120], 0.05);
  assert.ok(path.length > 3);
  const end = s.point(160, 120), last = path[path.length - 1];
  near(last.x, end.x); near(last.z, end.z);
  for (let i = 1; i < path.length - 1; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
    assert.ok(d > 0.04 && d < 0.07, 'step ' + d);
  }
});
