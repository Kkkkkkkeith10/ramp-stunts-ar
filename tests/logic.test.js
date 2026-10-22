// Run with: npm test (in prototypes/ramp-stunts-ar)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vec, sideDir, rampFromNumbers, rampFromTaps, pointOnRamp, floorPointAtShoes,
  shoesFromPoint, hopPoints, carOnRun, pretendRunShoes, checkTopHit
} from '../js/ramp.js';
import { createPip, play, pose, settle, HOP_SECONDS } from '../js/pip-anim.js';
import { pipBet, judge, nextTool, compareTruth, predictOptions, discovery } from '../js/rules.js';
import { createLog, EVENT_NAMES } from '../js/events.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' is not near ' + b);
const nearV = (a, b, eps = 1e-6) => { near(a.x, b.x, eps); near(a.y, b.y, eps); near(a.z, b.z, eps); };

test('tier 1: ramp from numbers has the right run, rise and angle', () => {
  const r = rampFromNumbers({ foot: vec(0, 0, 0), dir: vec(1, 0, 0), books: 2, across: 4, bookCm: 2.5, shoeCm: 18 });
  near(r.run, 0.72); near(r.rise, 0.05);
  nearV(r.topBase, vec(-0.72, 0, 0)); nearV(r.top, vec(-0.72, 0.05, 0));
  near(r.angleDeg, Math.atan2(0.05, 0.72) * 180 / Math.PI);
  assert.equal(r.method, 'numbers');
});

test('tier 1: the ramp lies across the camera view', () => {
  nearV(sideDir(vec(0, -0.5, -1)), vec(1, 0, 0));
  nearV(sideDir(vec(1, 0, 0)), vec(0, 0, 1));
});

test('tier 2: two taps give the measured slope', () => {
  const r = rampFromTaps({ foot: vec(0.5, -1.2, 0), top: vec(0.14, -1.14, 0), books: 2, bookCm: 2.5, shoeCm: 18 });
  near(r.run, 0.36); near(r.rise, 0.06);
  assert.equal(r.across, 2);
  assert.equal(r.heightFrom, 'tap');
  assert.equal(r.books, 2, 'keeps the child\'s book count');
  near(r.measuredBookCm, 3);
  nearV(r.dir, vec(1, 0, 0));
});

test('tier 2: a top tap that falls to the floor uses the book count for height', () => {
  const r = rampFromTaps({ foot: vec(0, 0, 0), top: vec(0, 0.002, -0.4), books: 3, bookCm: 2.5, shoeCm: 20 });
  assert.equal(r.heightFrom, 'books');
  near(r.rise, 0.075); assert.equal(r.across, 2);
  nearV(r.dir, vec(0, 0, 1));
});

test('tier 2: rejects taps that are too close or too high', () => {
  assert.equal(rampFromTaps({ foot: vec(0, 0, 0), top: vec(0.03, 0.05, 0), books: 2 }).error, 'too_close');
  assert.equal(rampFromTaps({ foot: vec(0, 0, 0), top: vec(0.5, 0.9, 0), books: 2 }).error, 'too_high');
});

test('tier 2: the top hit only counts when raised and near the book pile', () => {
  const foot = vec(0.4, 0, 0), pile = vec(0, 0, 0);
  assert.equal(checkTopHit(foot, pile, null).reason, 'skipped');
  assert.equal(checkTopHit(foot, pile, vec(0.01, 0.002, 0)).reason, 'floor');
  assert.equal(checkTopHit(foot, pile, vec(-0.1, 0.05, 0)).reason, 'far', 'past the pile');
  assert.equal(checkTopHit(foot, pile, vec(0.02, 0.05, 0.3)).reason, 'far', 'too far sideways');
  const ok = checkTopHit(foot, pile, vec(0.02, 0.05, 0.1));
  assert.equal(ok.ok, true); near(ok.riseCm, 5); near(ok.gapCm, 2); near(ok.sideCm, 10);
});

test('landing point converts to shoes from the foot', () => {
  const r = rampFromNumbers({ foot: vec(0, 0, 0), dir: vec(1, 0, 0), books: 2, across: 4, shoeCm: 20 });
  const a = shoesFromPoint(r, vec(1.03, 0, 0.1));
  assert.equal(a.shoes, 5); near(a.offAxisCm, 10); assert.equal(a.behind, false);
  assert.equal(shoesFromPoint(r, vec(-0.5, 0, 0)).behind, true);
  assert.equal(shoesFromPoint(r, vec(-0.5, 0, 0)).shoes, 0);
  nearV(floorPointAtShoes(r, 3), vec(0.6, 0, 0));
});

test('points on the ramp and hop points', () => {
  const r = rampFromNumbers({ foot: vec(0, 0, 0), dir: vec(1, 0, 0), books: 2, across: 4, bookCm: 2.5, shoeCm: 18 });
  nearV(pointOnRamp(r, 0), r.top); nearV(pointOnRamp(r, 1), r.foot);
  const h = hopPoints(r, 0.07);
  assert.equal(h.across.length, 5); assert.equal(h.up.length, 3);
  nearV(h.across[0], vec(-0.72, 0, 0.07)); nearV(h.across[4], vec(0, 0, 0.07));
  nearV(h.up[2], vec(-0.72, 0.05, 0.07));
});

test('the ghost car goes down the ramp then stops at the bet', () => {
  const r = rampFromNumbers({ foot: vec(0, 0, 0), dir: vec(1, 0, 0), books: 2, across: 4, shoeCm: 20 });
  nearV(carOnRun(r, 5, 0).pos, r.top);
  assert.equal(carOnRun(r, 5, 0.2).onRamp, true);
  nearV(carOnRun(r, 5, 1).pos, vec(1, 0, 0));
  near(carOnRun(r, 5, 1).pitchDeg, 0);
});

test('the preview car goes farther from a steeper ramp, within limits', () => {
  const lo = pretendRunShoes(rampFromNumbers({ foot: vec(0, 0, 0), dir: vec(1, 0, 0), books: 1, across: 4 }));
  const hi = pretendRunShoes(rampFromNumbers({ foot: vec(0, 0, 0), dir: vec(1, 0, 0), books: 3, across: 4 }));
  assert.ok(hi > lo, hi + ' > ' + lo);
  assert.ok(hi <= 14);
});

test('Pip hops along a path and counts each landing', () => {
  const pip = createPip(vec(0, 0, 0));
  const path = [vec(0, 0, 0), vec(0.1, 0, 0), vec(0.2, 0, 0)];
  play(pip, 'hop', 10, { path, hopHeight: 0.05 });
  const mid = pose(pip, 10 + HOP_SECONDS / 2);
  near(mid.lift, 0.05); near(mid.pos.x, 0.05); assert.equal(mid.step, 0);
  nearV(mid.face, vec(1, 0, 0));
  assert.equal(pose(pip, 10 + HOP_SECONDS * 1.5).step, 1);
  const end = pose(pip, 10 + HOP_SECONDS * 3);
  assert.equal(end.done, true); assert.equal(end.step, 2); nearV(end.pos, vec(0.2, 0, 0));
  assert.equal(settle(pip, 12), true);
  assert.equal(pip.state, 'idle'); nearV(pip.pos, vec(0.2, 0, 0));
});

test('Pip cheers once and then is done', () => {
  const pip = createPip(vec(0, 0, 0));
  play(pip, 'cheer', 0);
  assert.equal(pose(pip, 0.5).done, false);
  assert.equal(pose(pip, 1.3).done, true);
  assert.equal(pose(pip, 1.3).lift, 0);
});

test('rules: bets, judging, tools, prediction options', () => {
  assert.equal(pipBet(2), 4); assert.equal(pipBet(20), 11);
  const run = { bet: 5, pipBet: 4, result: 5 };
  assert.equal(judge(run, null).winner, 'child');
  assert.equal(judge({ bet: 1, pipBet: 4, result: 5 }, { result: 3 }).msg, 'New record! I was closer this time!');
  assert.equal(nextTool([{}, {}], { compare: false, repeat: false }), 'compare');
  assert.equal(nextTool([{}, {}], { compare: true, repeat: false }), 'repeat');
  assert.equal(compareTruth({ result: 2 }, { result: 4 }), 'b');
  for (let b = 1; b <= 6; b++) {
    const o = predictOptions(b);
    assert.equal(o.length, 3); assert.ok(o.includes(2 * b));
  }
  assert.match(discovery([{ books: 1, across: 4, result: 3 }, { books: 3, across: 4, result: 7 }]), /went 4 shoes farther/);
});

test('event log keeps the 2D demo event names and rejects unknown ones', () => {
  ['session_start', 'ramp_built', 'pip_bet', 'child_bet', 'launch_recorded', 'result', 'compare_answer', 'tool_used', 'prediction']
    .forEach((e) => assert.ok(EVENT_NAMES.includes(e), e));
  let clock = 1000;
  const log = createLog(() => clock);
  clock = 4200;
  assert.deepEqual(log.add('pip_bet', { shoes: 4 }), { t: 3, e: 'pip_bet', shoes: 4 });
  assert.throws(() => log.add('made_up_event'));
  assert.equal(log.text(), '{"t":3,"e":"pip_bet","shoes":4}');
});
