// Pip's animation states as pure functions of time, so they can be tested without a renderer.
// The scene reads pose() every frame and applies it to Pip's 3D model.
// States: idle, think, hop (along a path of points), cheer, oops.

export const HOP_SECONDS = 0.42;
const ONE_SHOT = { cheer: 1.2, oops: 1.2 };

const copy = (a) => ({ x: a.x, y: a.y, z: a.z });

export function createPip(pos) {
  return { state: 'idle', start: 0, pos: copy(pos), path: null, hopSec: HOP_SECONDS, hopHeight: 0.05 };
}

// Start a state. For 'hop', opts.path is a list of points; Pip jumps from each to the next.
export function play(pip, state, now, opts = {}) {
  pip.state = state;
  pip.start = now;
  pip.path = state === 'hop' ? opts.path.map(copy) : null;
  pip.hopSec = opts.hopSec || HOP_SECONDS;
  pip.hopHeight = opts.hopHeight != null ? opts.hopHeight : 0.05;
  if (pip.path) pip.pos = copy(pip.path[0]);
}

// Pose at time `now` (seconds). `lift` is extra height, `squash` scales y (and 1/sqrt in x, z),
// `spin` and `tilt` are radians. `face` is the direction of travel, or null to face the camera.
// `step` counts finished hops. `done` is true once a hop path or one-shot state has finished.
export function pose(pip, now) {
  const t = Math.max(0, now - pip.start);
  const base = { pos: copy(pip.pos), lift: 0, squash: 1, spin: 0, tilt: 0, face: null, step: 0, done: false };

  if (pip.state === 'idle' || pip.state === 'think') {
    base.lift = 0.004 * Math.sin(t * 2.6);
    base.squash = 1 + 0.02 * Math.sin(t * 2.6);
    if (pip.state === 'think') base.tilt = 0.22;
    return base;
  }

  if (pip.state === 'hop') {
    const path = pip.path, n = path.length - 1;
    const k = Math.floor(t / pip.hopSec);
    if (n < 1 || k >= n) {
      return { ...base, pos: copy(path[Math.max(0, n)]), step: Math.max(0, n), done: true };
    }
    const f = t / pip.hopSec - k, a = path[k], b = path[k + 1];
    const pos = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    const dx = b.x - a.x, dz = b.z - a.z, flat = Math.hypot(dx, dz);
    return {
      ...base, pos,
      lift: 4 * f * (1 - f) * pip.hopHeight,
      // squash on take-off and landing, stretch in the air
      squash: f < 0.15 || f > 0.85 ? 0.86 : 1.08,
      face: flat > 1e-4 ? { x: dx / flat, y: 0, z: dz / flat } : null,
      step: k
    };
  }

  if (pip.state === 'cheer') {
    const len = ONE_SHOT.cheer, f = (t % (len / 2)) / (len / 2);
    return { ...base, lift: t < len ? 4 * f * (1 - f) * 0.05 : 0, spin: t < len ? Math.min(1, t / len) * Math.PI * 2 : 0, done: t >= len };
  }

  if (pip.state === 'oops') {
    const len = ONE_SHOT.oops;
    return { ...base, tilt: t < len ? 0.25 * Math.sin(t * 14) * (1 - t / len) : 0, squash: 0.94, done: t >= len };
  }

  return base;
}

// After a finished hop or one-shot, keep Pip where he ended and go back to idle.
export function settle(pip, now) {
  const p = pose(pip, now);
  if (!p.done) return false;
  pip.pos = p.pos;
  pip.state = 'idle';
  pip.start = now;
  pip.path = null;
  return true;
}
