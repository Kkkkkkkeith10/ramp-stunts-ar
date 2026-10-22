// Ramp geometry for Ramp Stunts AR.
// Pure functions with plain {x, y, z} points, so they run in Node tests without three.js.
// Units are metres. y is up. The car rolls from the top of the ramp down to the foot,
// then on along the floor in the direction `dir`.

export const DEFAULTS = { bookCm: 2.5, shoeCm: 18 };

export const vec = (x, y, z) => ({ x, y, z });
const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => vec(a.x * s, a.y * s, a.z * s);
const lerp = (a, b, t) => add(a, scale(sub(b, a), t));
const copy = (a) => vec(a.x, a.y, a.z);

// Horizontal unit vector, or null if the vector is (almost) vertical.
export function flatUnit(d) {
  const l = Math.hypot(d.x, d.z);
  return l < 1e-6 ? null : vec(d.x / l, 0, d.z / l);
}

// The floor direction to the right of a camera looking along `forward`.
// Tier 1 lays the virtual ramp across the view so the child sees it side on.
export function sideDir(forward) {
  const f = flatUnit(forward) || vec(0, 0, -1);
  return vec(-f.z, 0, f.x);
}

function finish(o) {
  const topBase = add(o.foot, scale(o.dir, -o.run));
  const top = add(topBase, vec(0, o.rise, 0));
  return {
    foot: copy(o.foot), top, topBase, dir: o.dir,
    run: o.run, rise: o.rise, slopeLength: Math.hypot(o.run, o.rise),
    angleDeg: Math.atan2(o.rise, o.run) * 180 / Math.PI,
    books: o.books, across: o.across, bookCm: o.bookCm, shoeCm: o.shoeCm,
    method: o.method, heightFrom: o.heightFrom
  };
}

// Tier 1: a virtual ramp from the child's counts, with its foot at a floor point.
export function rampFromNumbers({ foot, dir, books, across, bookCm = DEFAULTS.bookCm, shoeCm = DEFAULTS.shoeCm }) {
  return finish({
    foot, dir: flatUnit(dir) || vec(1, 0, 0),
    run: across * shoeCm / 100, rise: books * bookCm / 100,
    books, across, bookCm, shoeCm, method: 'numbers', heightFrom: 'books'
  });
}

// Tier 2: a ramp from two aimed points, the foot (on the floor) and the top edge.
// An inclined tray is often not found by plane detection, so the top hit may land on the
// floor behind the ramp. Then the height comes from the child's book count instead.
// `books` stays the child's own count: it is the unit Pip talks about.
export function rampFromTaps({ foot, top, books, bookCm = DEFAULTS.bookCm, shoeCm = DEFAULTS.shoeCm, minRunCm = 8, minRiseCm = 1, maxRiseCm = 60 }) {
  const flat = vec(foot.x - top.x, 0, foot.z - top.z);
  const run = Math.hypot(flat.x, flat.z);
  if (run < minRunCm / 100) return { error: 'too_close', runCm: run * 100 };
  let rise = top.y - foot.y, heightFrom = 'tap';
  if (rise > maxRiseCm / 100) return { error: 'too_high', riseCm: rise * 100 };
  if (rise < minRiseCm / 100) { rise = books * bookCm / 100; heightFrom = 'books'; }
  const ramp = finish({
    foot, dir: flatUnit(flat), run, rise,
    books, across: Math.max(1, Math.round(run * 100 / shoeCm)),
    bookCm, shoeCm, method: 'taps', heightFrom
  });
  if (heightFrom === 'tap') ramp.measuredBookCm = rise * 100 / books;
  return ramp;
}

// Tier 2 aims at the floor beside the bottom book (under the top of the tray), which plane
// detection finds reliably, then tries the top edge itself. The top hit only counts if it is
// raised above the floor and near the pile along the ramp's line (the child may aim at the
// pile from the side, so sideways distance is allowed more slack). Otherwise the ray
// probably went past the tray.
export function checkTopHit(foot, pileBase, topHit, { minRiseCm = 1, maxGapCm = 8, maxSideCm = 20 } = {}) {
  if (!topHit) return { ok: false, reason: 'skipped' };
  const riseCm = (topHit.y - pileBase.y) * 100;
  const ax = pileBase.x - foot.x, az = pileBase.z - foot.z, len = Math.hypot(ax, az) || 1;
  const tx = topHit.x - foot.x, tz = topHit.z - foot.z;
  const gapCm = Math.abs((tx * ax + tz * az) / len - len) * 100;
  const sideCm = Math.abs(tx * az - tz * ax) / len * 100;
  if (riseCm < minRiseCm) return { ok: false, reason: 'floor', riseCm, gapCm, sideCm };
  if (gapCm > maxGapCm || sideCm > maxSideCm) return { ok: false, reason: 'far', riseCm, gapCm, sideCm };
  return { ok: true, reason: 'raised', riseCm, gapCm, sideCm };
}

// A point on the ramp surface: s = 0 at the top edge, s = 1 at the foot.
export function pointOnRamp(ramp, s) {
  return lerp(ramp.top, ramp.foot, s);
}

// A floor point n shoes beyond the foot, where the car runs on.
export function floorPointAtShoes(ramp, n) {
  return add(ramp.foot, scale(ramp.dir, n * ramp.shoeCm / 100));
}

// Where an aimed floor point sits along the run-out, in shoes from the foot.
export function shoesFromPoint(ramp, p) {
  const rel = sub(p, ramp.foot);
  const along = rel.x * ramp.dir.x + rel.z * ramp.dir.z;
  const off = Math.abs(rel.x * ramp.dir.z - rel.z * ramp.dir.x);
  const exact = along * 100 / ramp.shoeCm;
  return {
    shoes: Math.max(0, Math.round(exact)), exact,
    alongCm: along * 100, offAxisCm: off * 100,
    behind: exact < -0.5
  };
}

// Pip's Repeat hops: along the floor beside the ramp, one shoe at a time from under the
// top to the foot, then up a column of books at the top. Offset sideways so he is not
// inside the tray.
export function hopPoints(ramp, sideOffset = 0.07) {
  const side = vec(-ramp.dir.z, 0, ramp.dir.x);
  const base = add(ramp.topBase, scale(side, sideOffset));
  const across = [], up = [];
  for (let i = 0; i <= ramp.across; i++) across.push(add(base, scale(ramp.dir, ramp.run * i / ramp.across)));
  for (let i = 0; i <= ramp.books; i++) up.push(add(base, vec(0, ramp.rise * i / ramp.books, 0)));
  return { across, up };
}

// A car run for Pip's bet: accelerate down the ramp, then slow to a stop `shoes` from the foot.
// u runs 0..1. Returns the contact point and the pitch of the surface.
export function carOnRun(ramp, shoes, u, rampShare = 0.35) {
  const t = Math.min(1, Math.max(0, u));
  if (t < rampShare) {
    const s = (t / rampShare) ** 2;
    return { pos: pointOnRamp(ramp, s), pitchDeg: ramp.angleDeg, onRamp: true };
  }
  const w = (t - rampShare) / (1 - rampShare);
  const eased = 1 - (1 - w) ** 2;
  return { pos: floorPointAtShoes(ramp, shoes * eased), pitchDeg: 0, onRamp: false };
}

// A rough stand-in for a real car, used only in preview mode where there is no real car.
// Energy: height lost minus rolling friction. Very steep ramps make the car nose-dive.
export function pretendRunShoes(ramp, { mu = 0.035, crashDeg = 40, maxShoes = 14 } = {}) {
  let d = ramp.rise / mu - ramp.run;
  if (ramp.angleDeg > crashDeg) d *= Math.max(0.2, 1 - (ramp.angleDeg - crashDeg) / 30);
  return Math.min(maxShoes, Math.max(0, Math.round(d * 100 / ramp.shoeCm)));
}
