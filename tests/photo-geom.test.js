import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCamera, disparityToDistance, createSurface, fitFloor, floorFrame, surfacePath,
  upFromOrientation, upInPhoto, upFromPitch, fitDispPlane, calibrateShift
} from '../js/photo-geom.js';

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

// ---------- calibration from the phone's tilt ----------

test('up from DeviceOrientation: upright, flat, tilted down, sideways', () => {
  const u1 = upFromOrientation(90, 0); near(u1.x, 0); near(u1.y, 1); near(u1.z, 0);
  const u2 = upFromOrientation(0, 0); near(u2.y, 0); near(u2.z, 1);
  const u3 = upFromOrientation(60, 0); near(u3.y, Math.sin(Math.PI / 3)); near(u3.z, 0.5);
  // landscape: the phone's +x points up; in the upright photo that is "up"
  const side = upInPhoto({ x: 0.85, y: 0, z: 0.5 }); near(side.y, 0.85); near(side.x, 0); near(side.z, 0.5);
  const same = upInPhoto({ x: 0.1, y: 0.8, z: 0.5 }); near(same.y, 0.8); near(same.x, 0.1);
});

// A room seen by a camera 0.6 m above the floor, tilted down: a floor, plus a tray leaning on
// books (rise 7.5 cm over 40 cm across, 10.6 degrees). The depth map is written like the model's:
// inverse depth with an unknown scale and shift, then stretched to 0..255.
function rampRoom(w, h, pitchDeg, cam) {
  const p = -pitchDeg * Math.PI / 180, c = Math.cos(p), s = Math.sin(p);
  const camH = 0.6, F = { x: 0.15, y: -camH, z: -0.65 }, T = { x: -0.25, y: -camH + 0.075, z: -0.65 };
  const along = { x: F.x - T.x, y: F.y - T.y, z: 0 };
  const nT = { x: -along.y, y: along.x, z: 0 }; // tray normal (up-ish), unnormalized
  const inv = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xn = (x + 0.5 - cam.cx) / cam.fx, yn = -(y + 0.5 - cam.cy) / cam.fy;
    const r = { x: xn, y: yn * c + s, z: yn * s - c }; // world ray for camera ray (xn, yn, -1)
    let t = r.y < -1e-4 ? -camH / r.y : 50;
    const den = nT.x * r.x + nT.y * r.y;
    if (Math.abs(den) > 1e-9) {
      const tt = (nT.x * T.x + nT.y * T.y) / den, q = { x: r.x * tt, y: r.y * tt, z: r.z * tt };
      const u = ((q.x - T.x) * along.x + (q.y - T.y) * along.y) / (along.x ** 2 + along.y ** 2);
      if (tt > 0 && tt < t && u >= 0 && u <= 1 && Math.abs(q.z - T.z) < 0.07) t = tt;
    }
    inv[y * w + x] = 1 / Math.min(t, 50);
  }
  // unknown affine (the model's scale and shift), then stretch to 0..255
  const aff = Array.from(inv, (v) => 0.37 * v - 0.11);
  let lo = Infinity, hi = -Infinity; aff.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
  const data = new Uint8Array(w * h);
  aff.forEach((v, i) => { data[i] = Math.round((v - lo) / (hi - lo) * 255); });
  const proj = (P) => { // world point to pixel
    const q = { x: P.x, y: P.y * c + P.z * s, z: -P.y * s + P.z * c };
    return [q.x / -q.z * cam.fx + cam.cx, -q.y / -q.z * cam.fy + cam.cy];
  };
  return { depth: { data, width: w, height: h, channels: 1 }, topPx: proj({ x: T.x + 0.02, y: T.y - 0.0037, z: T.z }), footPx: proj({ x: F.x - 0.02, y: F.y + 0.0037, z: F.z }) };
}

function slopeDeg(surface, up, a, b) {
  const pa = surface.point(a[0], a[1]), pb = surface.point(b[0], b[1]);
  const d = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
  const rise = d.x * up.x + d.y * up.y + d.z * up.z;
  const run = Math.sqrt(Math.max(0, d.x * d.x + d.y * d.y + d.z * d.z - rise * rise));
  return Math.atan2(Math.abs(rise), run) * 180 / Math.PI;
}

test('the tilt sensor fixes the flat slopes: a 10.6 degree ramp reads about 10.6', () => {
  const cam = makeCamera(320, 240), pitch = 33, up = upFromPitch(pitch);
  const room = rampRoom(320, 240, pitch, cam);
  const guess = createSurface(room.depth, cam);
  const plane = fitDispPlane(guess);
  assert.ok(plane.ok, 'floor share ' + plane.share);
  const cal = calibrateShift(plane, up);
  assert.ok(cal.ok, cal.reason);
  assert.ok(cal.mismatchDeg < 1.5, 'mismatch ' + cal.mismatchDeg);
  const fixed = createSurface(room.depth, cam, { shift: cal.shift, scale: cal.scale });
  const truth = Math.atan2(0.075, 0.4) * 180 / Math.PI;
  const before = slopeDeg(guess, up, room.footPx, room.topPx), after = slopeDeg(fixed, up, room.footPx, room.topPx);
  assert.ok(Math.abs(after - truth) < 1.5, 'calibrated slope ' + after.toFixed(1) + ' vs ' + truth.toFixed(1));
  assert.ok(Math.abs(before - truth) > Math.abs(after - truth), 'guess ' + before.toFixed(1) + ' should be worse');
  // and the calibrated floor really faces up
  const f = fitFloor(fixed);
  near(f.n.x, up.x, 0.03); near(f.n.y, up.y, 0.03); near(f.n.z, up.z, 0.03);
});

test('calibration refuses impossible cases', () => {
  assert.equal(calibrateShift({ ok: false }, upFromPitch(30)).reason, 'no_floor');
  assert.equal(calibrateShift({ ok: true, a: 0, b: -0.3, g: 0.5, floorD: [0.5] }, { x: 0, y: 0.05, z: 0.99 }).reason, 'straight_down');
  assert.equal(calibrateShift({ ok: true, a: 0, b: 0.3, g: 0.5, floorD: [0.5] }, upFromPitch(30)).reason, 'floor_upside_down');
});

test('ramp from photo taps: the bottom comes from the floor, the top from depth', async () => {
  const { rampFromPhotoTaps } = await import('../js/photo-geom.js');
  const cam = makeCamera(320, 240), pitch = 33, up = upFromPitch(pitch);
  const room = rampRoom(320, 240, pitch, cam);
  const guess = createSurface(room.depth, cam);
  const cal = calibrateShift(fitDispPlane(guess), up);
  const fixed = createSurface(room.depth, cam, { shift: cal.shift, scale: cal.scale });
  const floor = fitFloor(fixed);
  const r = rampFromPhotoTaps(fixed, floor, up, room.footPx, room.topPx);
  assert.ok(r.ok, r.reason);
  near(r.angleDeg, Math.atan2(0.075, 0.4) * 180 / Math.PI, 1.5);
  // the foot really is on the floor
  near(r.foot.x * floor.n.x + r.foot.y * floor.n.y + r.foot.z * floor.n.z + floor.d, 0, 1e-9);
});

test('distScale resizes the stage about the camera: same pixels, same angles', () => {
  const cam = makeCamera(200, 150);
  const depth = floorDepth(200, 150, 35, cam);
  const a = createSurface(depth, cam, { normalize: false }), b = createSurface(depth, cam, { normalize: false, distScale: 2 });
  const pa = a.point(120, 110), pb = b.point(120, 110);
  near(pb.x, 2 * pa.x); near(pb.y, 2 * pa.y); near(pb.z, 2 * pa.z);
  const px = b.pixelOf(pb); near(px[0], 120, 1e-6); near(px[1], 110, 1e-6);
});

test('scale from books: the ramp comes out the real size', async () => {
  const { scaleFromBooks, rampFromPhotoTaps } = await import('../js/photo-geom.js');
  assert.equal(scaleFromBooks(0.001, 3, 2.5).reason, 'flat');
  assert.equal(scaleFromBooks(0.1, 0, 2.5).reason, 'no_books');
  near(scaleFromBooks(0.15, 3, 2.5).k, 0.5);
  // the synthetic room: 3 books of 2.5 cm, a ramp 40 cm across
  const cam = makeCamera(320, 240), up = upFromPitch(33), room = rampRoom(320, 240, 33, cam);
  const cal = calibrateShift(fitDispPlane(createSurface(room.depth, cam)), up);
  const s1 = createSurface(room.depth, cam, { shift: cal.shift, scale: cal.scale });
  const r1 = rampFromPhotoTaps(s1, fitFloor(s1), up, room.footPx, room.topPx);
  const k = scaleFromBooks(r1.rise, 3, 2.5);
  assert.ok(k.ok, k.reason);
  const s2 = createSurface(room.depth, cam, { shift: cal.shift, scale: cal.scale, distScale: k.k });
  const r2 = rampFromPhotoTaps(s2, fitFloor(s2), up, room.footPx, room.topPx);
  near(r2.rise, 0.075, 0.003);
  near(r2.run, 0.40, 0.04);
  near(r2.angleDeg, r1.angleDeg, 0.3);
});
