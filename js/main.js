// Ramp Stunts AR: Pip stands on the real floor and the real ramp (WebXR in Android Chrome).
// Tier 1: place Pip on the floor, build a virtual ramp from the child's numbers.
// Tier 2: aim at the ramp's foot and the base of the book pile (and try the top edge) to
// measure the real ramp. Preview mode runs the same game in a pretend room, without AR.
import { THREE, COLORS, makePip, applyPipPose, makeRamp, makeFlag, makeCar, placeCar, makeReticle, makePretendRoom, makePops } from './scene.js';
import * as R from './ramp.js';
import { createPip, play, pose, settle } from './pip-anim.js';
import { clamp, plural, ratioText, pipBet, bestRun, judge, nextTool, compareTruth, predictOptions, discovery } from './rules.js';
import { createLog } from './events.js';

const $ = (s) => document.querySelector(s);
const nowSec = () => performance.now() / 1000;
const MAX_SHOES = 14;

// ---------- settings (kept on this device) ----------

const settings = { shoeCm: R.DEFAULTS.shoeCm, bookCm: R.DEFAULTS.bookCm, voice: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('rsar-settings') || '{}')); } catch (e) { /* private mode */ }
function saveSettings() { try { localStorage.setItem('rsar-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }

// ---------- three.js ----------

const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 40);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.6, 1, 0.4);
scene.add(sun);

// Everything in the game lives under `root`, whose frame is the spot where Pip was placed.
// In AR it follows an anchor when the phone supports anchors.
const root = new THREE.Group();
root.matrixAutoUpdate = false;
scene.add(root);
const reticle = makeReticle();
scene.add(reticle);
const pipModel = makePip();
pipModel.visible = false;
root.add(pipModel);
const pops = makePops(root);

let mode = null, session = null, hitSource = null, anchor = null, pretend = null;
const aim = { ok: false, matrix: new THREE.Matrix4(), hit: null, virtual: false };
// What the AR session is doing, for the diagnostics line and the guessed-floor fallback.
const xr = { frames: 0, pose: false, hitFrames: 0, space: 'local', feats: null, floorSpace: false, floorY: null, camY: 0, errors: 0, lastError: '' };
const objs = { ramp: null, flags: {}, ghost: null, car: null, blocks: [], marks: [] };
let pipA = createPip(R.vec(0, 0, 0));
let hopRun = null, carRuns = [];

const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3();
function toLocal(world) {
  tmpM.copy(root.matrixWorld).invert();
  const p = world.clone().applyMatrix4(tmpM);
  return R.vec(p.x, p.y, p.z);
}
function aimLocal() {
  if (!aim.ok) return null;
  return toLocal(tmpV.setFromMatrixPosition(aim.matrix));
}
function cameraLocal() { return toLocal(camera.getWorldPosition(new THREE.Vector3())); }
function cameraForwardLocal() {
  const d = camera.getWorldDirection(new THREE.Vector3());
  tmpM.copy(root.matrixWorld).invert();
  d.transformDirection(tmpM);
  return R.vec(d.x, d.y, d.z);
}

// ---------- game state ----------

function fresh(keep) {
  return {
    screen: 'start', player: keep ? keep.player : 'Me', books: keep ? keep.books : 2, across: keep ? keep.across : 4,
    runs: keep ? keep.runs : [], used: keep ? keep.used : { compare: false, repeat: false },
    ramp: null, numFrame: null, taps: {}, bet: 3, pipBet: null, betReady: false, hint: null, aiming: false,
    manual: 3, sl: { phase: 'count', wrong: 0 }, cmp: { wrong: 0, done: false }, pulse: null, lastRun: null
  };
}
let S = fresh();
let log = createLog();
log.add('session_start', { world: 'ramp_stunts', variant: 'ar' });

// ---------- Pip talks ----------

function say(mood, text) {
  $('#bubble').textContent = text;
  pipModel.userData.setMood(mood);
  if (pipA.state !== 'hop') {
    if (mood === 'happy') play(pipA, 'cheer', nowSec());
    else if (mood === 'oops') play(pipA, 'oops', nowSec());
    else play(pipA, mood === 'think' ? 'think' : 'idle', nowSec());
  }
  if (settings.voice && window.speechSynthesis) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1; u.pitch = 1.35;
      speechSynthesis.speak(u);
    } catch (e) { /* no voice */ }
  }
}

// ---------- Pip moves ----------

function hopAlong(path, opts = {}) {
  if (!path || path.length < 2) { if (opts.onDone) opts.onDone(); return; }
  play(pipA, 'hop', nowSec(), { path, hopSec: opts.hopSec, hopHeight: opts.hopHeight });
  hopRun = { counted: 0, onStep: opts.onStep, onDone: opts.onDone };
}
function linePath(a, b, stepLen = 0.08) {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), n = Math.max(1, Math.ceil(d / stepLen)), out = [];
  for (let i = 0; i <= n; i++) out.push(R.vec(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, a.z + (b.z - a.z) * i / n));
  return out;
}
function onTray(p) { return R.vec(p.x, p.y + 0.006, p.z); }
function pathUpRamp(from, ramp) {
  const path = linePath(from, ramp.foot);
  const m = Math.max(2, Math.ceil(ramp.slopeLength / 0.08));
  for (let i = 1; i <= m; i++) path.push(onTray(R.pointOnRamp(ramp, 1 - i / m)));
  return path;
}
function sideOf(ramp) { return R.vec(-ramp.dir.z, 0, ramp.dir.x); }
function watchSpot(ramp) {
  const s = sideOf(ramp);
  return R.vec(ramp.foot.x - s.x * 0.12 - ramp.dir.x * 0.04, ramp.foot.y, ramp.foot.z - s.z * 0.12 - ramp.dir.z * 0.04);
}
function hopToFloor(onDone) {
  const p = pipA.pos;
  if (p.y < 0.01) { if (onDone) onDone(); return; }
  hopAlong(linePath(p, R.vec(p.x, 0, p.z + 0.001)), { onDone });
}

// ---------- 3D props ----------

function clearFlags(names) {
  (names || Object.keys(objs.flags)).forEach((n) => { if (objs.flags[n]) { root.remove(objs.flags[n]); delete objs.flags[n]; } });
}
function setFlag(name, color, text, shoes, sideOff = 0, labelY = 0.15) {
  clearFlags([name]);
  const f = makeFlag(color, text);
  const lab = f.children[f.children.length - 1];
  if (text) lab.position.y = labelY;
  const p = R.floorPointAtShoes(S.ramp, shoes), s = sideOf(S.ramp);
  f.position.set(p.x + s.x * sideOff, p.y, p.z + s.z * sideOff);
  f.userData.base = f.position.y;
  root.add(f);
  objs.flags[name] = f;
  return f;
}
function setRamp(ramp, ghost) {
  if (objs.ramp) root.remove(objs.ramp);
  S.ramp = ramp;
  objs.ramp = ramp ? makeRamp(ramp, { ghost, maxShoes: MAX_SHOES }) : null;
  if (objs.ramp) root.add(objs.ramp);
}
function clearMarks() { objs.marks.forEach((m) => root.remove(m)); objs.marks = []; }
function addMark(p, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.01, 16, 12), new THREE.MeshBasicMaterial({ color }));
  m.position.set(p.x, p.y + 0.01, p.z);
  root.add(m); objs.marks.push(m);
}
function clearBlocks() { objs.blocks.forEach((b) => root.remove(b)); objs.blocks = []; pops.clear(); }
function clearCars() {
  carRuns = [];
  [objs.ghost, objs.car].forEach((c) => { if (c) root.remove(c); });
  objs.ghost = objs.car = null;
}
function runCar(kind, shoes, onDone) {
  const ghost = kind === 'ghost';
  const car = makeCar(ghost ? COLORS.pip : 0x2D6BD6, ghost);
  if (objs[kind]) root.remove(objs[kind]);
  objs[kind] = car;
  root.add(car);
  carRuns.push({ car, shoes, start: nowSec(), dur: ghost ? 2.2 : 2.6, onDone });
}

// ---------- the glove ----------

const GLOVE = [
  { k: 'compare', n: 'Compare', on: true }, { k: 'split', n: 'Split' }, { k: 'join', n: 'Join' },
  { k: 'group', n: 'Group' }, { k: 'repeat', n: 'Repeat', on: true }
];
function drawGlove() {
  $('#glove').innerHTML = GLOVE.map((f) => {
    const cls = 'finger' + (f.on && S.used[f.k] ? ' on' : '') + (S.hint === f.k ? ' hint' : '') + (f.on ? '' : ' later');
    return '<span class="' + cls + '" style="--fc:var(--c-' + f.k + ')">' + f.n + '</span>';
  }).join('');
}

// ---------- screens ----------

const stepper = (label, key, val) =>
  '<div class="stepper"><span class="lab">' + label + '</span>' +
  '<button class="btn alt" data-act="step" data-k="' + key + '" data-d="-1" aria-label="Fewer">-</button>' +
  '<b id="v-' + key + '">' + val + '</b>' +
  '<button class="btn alt" data-act="step" data-k="' + key + '" data-d="1" aria-label="More">+</button></div>';
const LIMITS = { books: [1, 6], across: [2, 8], bet: [0, MAX_SHOES], manual: [0, MAX_SHOES] };

const screens = {};

// The phone finds the floor by seeing the same floor details (grain, pattern) from slightly
// different places as it moves, so the coaching asks for a slow sweep, light and a patterned floor.
screens.place = {
  html: () => '<h2>Help Pip find the floor</h2>' +
    '<p class="readout" id="floorTxt">Looking for the floor...</p>' +
    '<button class="btn" data-act="place" data-needs-aim>Put Pip here</button>' +
    (mode === 'xr' ? '<button class="btn alt" data-act="placeGuess" id="guessBtn" hidden>Still nothing? Let Pip guess the floor</button>' : '') +
    '<div class="coach" aria-hidden="true"><div class="coach-phone"></div><div class="coach-floor"></div></div>' +
    '<ol class="steps"><li>Point the phone at the floor, one big step in front of you.</li>' +
    '<li>Sweep it slowly left and right, like a torch.</li>' +
    '<li>When the circle turns orange, tap the button.</li></ol>' +
    '<p class="diag" id="diag"></p>',
  enter() { S.aiming = true; S.placeStart = nowSec(); say('idle', "Hi, I'm Pip! Sweep the phone slowly over the floor so I can find it."); }
};

function floorHint(t) {
  if (aim.ok) return aim.virtual ? 'Pip is guessing the floor. Tap Put Pip here.' : 'Found the floor! Tap Put Pip here.';
  if (t < 8) return 'Looking for the floor... keep sweeping slowly.';
  return 'Still looking. Try more light, or a floor with a pattern, like a rug or wood. Plain shiny floors are hard.';
}

screens.build = {
  html: () => '<h2>Build your ramp</h2>' +
    '<p>Playing: <b>' + S.player + '</b> <button class="link" data-act="player">switch</button></p>' +
    stepper('Books high', 'books', S.books) +
    '<p class="tip">Stack the books. Lean the tray from the top book down to the floor.</p>' +
    '<div class="row"><button class="btn" data-act="go" data-to="tapFoot">Show Pip my real ramp</button>' +
    '<button class="btn alt" data-act="go" data-to="numbers">Use numbers instead</button></div>',
  enter() {
    S.aiming = false;
    setRamp(null); clearFlags(); clearCars(); clearMarks(); clearBlocks();
    hopToFloor();
    say('idle', S.runs.length ? 'Change one thing, then show me the new ramp.' : 'Build it for real first. How many books high?');
  }
};

screens.numbers = {
  html: () => '<h2>Tell Pip the numbers</h2>' + stepper('Books high', 'books', S.books) + stepper('Shoes across', 'across', S.across) +
    '<p class="tip">Lay one shoe at a time on the floor under the tray to count across.</p>' +
    '<button class="btn" data-act="makeNumbers">Make Pip\'s ramp</button>',
  enter() { say('idle', 'Pip will build a pretend ramp the same size as yours.'); }
};

screens.tapFoot = {
  html: () => '<h2>1. The bottom</h2><p>Point the ring at the floor where the tray touches it.</p>' +
    '<button class="btn" data-act="tapFoot" data-needs-aim>The bottom is here</button><p class="warn" id="tapMsg"></p>',
  enter() { S.aiming = true; S.taps = {}; clearMarks(); say('think', 'Show me where your ramp ends. That is where the car comes off.'); }
};

screens.tapPile = {
  html: () => '<h2>2. Under the top</h2><p>Now point at the floor right beside the bottom book, under the top of the tray.</p>' +
    '<button class="btn" data-act="tapPile" data-needs-aim>The books start here</button><p class="warn" id="tapMsg"></p>',
  enter() { S.aiming = true; say('think', 'Now the floor under the top of the ramp.'); }
};

screens.tapTop = {
  html: () => '<h2>3. The top edge</h2><p>Last one. Point at the top edge of the tray. Pip will try to see how high it is.</p>' +
    '<div class="row"><button class="btn" data-act="tapTop" data-needs-aim>The top edge is here</button>' +
    '<button class="btn alt" data-act="tapTop" data-skip="1">Skip, use my book count</button></div>',
  enter() { S.aiming = true; say('think', 'Can I see the top? Let us try.'); }
};

screens.rampReady = {
  html: () => {
    const r = S.ramp, note = r.method === 'numbers' ? 'Pip built this from your numbers.' :
      (r.heightFrom === 'tap' ? 'Pip measured the height himself.' : 'Pip could not see the top, so he used your book count for the height.');
    return '<h2>Pip\'s ramp</h2><p class="big-statement"><em>' + plural(r.books, 'book') + '</em> high, <em>' + plural(r.across, 'shoe') + '</em> across.</p>' +
      '<p class="tip small">' + note + ' About ' + Math.round(r.run * 100) + ' cm across, ' + Math.round(r.rise * 100) + ' cm up, ' + Math.round(r.angleDeg) + ' degrees.</p>' +
      '<div class="row"><button class="btn" data-act="rampOK">Looks right</button><button class="btn alt" data-act="go" data-to="build">Measure again</button></div>';
  },
  enter() {
    S.aiming = false; clearMarks();
    say('happy', 'Ooh, a ramp! Let me climb up.');
    hopAlong(pathUpRamp(pipA.pos, S.ramp));
  }
};

screens.bet = {
  html: () => '<h2>Where will it stop?</h2><p class="muted">Watch Pip\'s bet, then move your flag.</p>' + stepper('Your bet', 'bet', S.bet) +
    '<button class="btn" data-act="lockbet" id="betBtn" disabled>Lock my bet</button>',
  enter() {
    S.aiming = false; S.pipBet = null; S.betReady = false;
    clearFlags(); clearCars();
    setFlag('child', COLORS.child, 'You', S.bet, 0.035, 0.19);
    say('think', 'Hmm, let me think...');
    setTimeout(() => {
      if (S.screen !== 'bet') return;
      S.pipBet = pipBet(S.books);
      runCar('ghost', S.pipBet, () => {
        if (S.screen !== 'bet') return;
        setFlag('pip', COLORS.pip, 'Pip', S.pipBet, -0.035, 0.15);
        S.betReady = true;
        const b = $('#betBtn'); if (b) b.disabled = false;
        say('idle', 'I bet ' + plural(S.pipBet, 'shoe') + '! Where does your flag go?');
        log.add('pip_bet', { shoes: S.pipBet, books: S.books });
      });
    }, 800);
  }
};

screens.launch = {
  html: () => '<h2>Release the car!</h2><p>Put your real car at the top of the tray. Let it go. No pushing! Wait until it stops.</p>' +
    (mode === 'preview' ? '<button class="btn alt" data-act="pretendGo">Let the pretend car go</button>' : '') +
    '<button class="btn" data-act="stopped">It stopped</button>',
  enter() {
    if (objs.ghost) { root.remove(objs.ghost); objs.ghost = null; }
    hopAlong(linePath(pipA.pos, watchSpot(S.ramp), 0.07));
    say('happy', 'Ready, steady... let go!');
  }
};

screens.landing = {
  html: () => '<h2>Where did it stop?</h2><p>Point the ring at the front of the car.</p>' +
    '<p class="readout" id="aimTxt">Looking for the floor...</p>' +
    '<button class="btn" data-act="land" data-needs-aim>It stopped here</button>' +
    '<details class="manual"><summary>Count the shoes myself</summary>' + stepper('Shoes', 'manual', S.manual) +
    '<button class="btn alt" data-act="landManual">Use my count</button></details>',
  enter() { S.aiming = true; S.lastAimShoes = null; say('think', 'Whoa! Where did it stop?'); }
};

screens.result = {
  html: () => {
    const run = S.lastRun, tool = nextTool(S.runs, S.used);
    const tip = tool === 'compare' ? "Hmm, I can't tell which run went farther. Use the Compare finger!" :
      tool === 'repeat' ? "Why did it go farther? Let's count the ramp with Repeat." :
      S.runs.length < 2 ? 'Now make it go farther. Change one thing and bet again.' : 'Keep tinkering, or ask a friend to beat your record.';
    return '<h2>It went ' + plural(run.result, 'shoe') + '!</h2><p class="readout">Pip bet ' + run.pipBet + ', you bet ' + run.bet + ', it stopped at ' + run.result + '.</p><p class="tip">' + tip + '</p>' +
      '<div class="row">' +
      (tool === 'compare' ? '<button class="btn glow" style="--fc:var(--c-compare)" data-act="go" data-to="compare">Compare my last two runs</button>' : '') +
      (tool === 'repeat' ? '<button class="btn glow" style="--fc:var(--c-repeat)" data-act="go" data-to="slope">Count the ramp with Repeat</button>' : '') +
      '<button class="btn' + (tool ? ' alt' : '') + '" data-act="go" data-to="build">Go again</button>' +
      '<button class="btn alt" data-act="go" data-to="bet">Same ramp, bet again</button>' +
      (S.runs.length >= 2 && tool !== 'compare' ? '<button class="btn alt" data-act="go" data-to="compare">Compare my last two runs</button>' : '') +
      (tool !== 'repeat' ? '<button class="btn alt" data-act="go" data-to="slope">How steep is my ramp?</button>' : '') +
      '<button class="btn alt" data-act="go" data-to="board">Record cards</button></div>';
  },
  enter() { S.hint = nextTool(S.runs, S.used); }
};

screens.compare = {
  html: () => {
    const a = S.cmp.a, b = S.cmp.b;
    return '<h2>Compare two runs</h2><p class="muted">Look at the two flags on the floor. Which car went farther?</p><div class="opts">' +
      '<button class="opt" data-act="cmp" data-pick="a"><i class="dot" style="background:var(--book1)"></i>Run ' + a.n + ' · ' + plural(a.books, 'book') + ' high</button>' +
      '<button class="opt" data-act="cmp" data-pick="b"><i class="dot" style="background:var(--book2)"></i>Run ' + b.n + ' · ' + plural(b.books, 'book') + ' high</button>' +
      '<button class="opt" data-act="cmp" data-pick="same">They stopped in the same place</button></div><div id="cmpOut"></div>';
  },
  enter() {
    const a = S.cmp.a, b = S.cmp.b;
    S.aiming = false; clearFlags(); clearCars();
    if (!S.ramp) setRamp(a.ramp, a.ramp.method === 'taps');
    setFlag('a', COLORS.runA, 'Run ' + a.n, a.result, -0.035, 0.15);
    setFlag('b', COLORS.runB, 'Run ' + b.n, b.result, 0.035, 0.19);
    S.hint = 'compare'; drawGlove();
    say('think', 'Compare time! Which car is farther from the ramp?');
  }
};

screens.slope = {
  html: () => {
    const sl = S.sl, r = S.ramp;
    if (sl.phase === 'count') return '<h2>Count with Repeat</h2><p>Pip will hop along under your ramp, one shoe at a time. Then he will count the books.</p>' +
      '<button class="btn" data-act="hop">Pip, hop along it!</button>';
    if (sl.phase === 'hop') return '<h2>Hop, hop, hop</h2><p class="readout" id="hopTxt">Counting...</p>';
    if (sl.phase === 'ratio') return '<h2>The ramp\'s secret</h2><p class="big-statement">For every <em>' + r.across + '</em> across, it goes up <em>' + r.books + '</em>.</p>' +
      '<button class="btn" data-act="topredict">Next: a guess</button>';
    if (sl.phase === 'predict') return '<h2>Pip\'s puzzle</h2><p>Your ramp is ' + r.across + ' shoes across and ' + r.books + ' up. Now picture a ramp <b>twice as long</b>: ' + (2 * r.across) + ' shoes across. How many books high keeps it just as steep?</p>' +
      '<div class="opts" id="prOpts">' + predictOptions(r.books).map((o) => '<button class="opt" data-act="pick" data-v="' + o + '">' + plural(o, 'book') + '</button>').join('') + '</div><div id="prOut"></div>';
    return '<h2>What it means for the car</h2><p class="big-statement small-statement">' + discovery(S.runs) + '</p>' +
      '<div class="row"><button class="btn" data-act="go" data-to="build">Build a new ramp and test it</button><button class="btn alt" data-act="go" data-to="board">Record cards</button></div>';
  },
  enter() {
    const sl = S.sl;
    S.aiming = false;
    if (sl.phase === 'count') { clearFlags(); clearCars(); S.hint = 'repeat'; drawGlove(); say('idle', 'Repeat means use one thing again and again. Like my hops!'); }
    if (sl.phase === 'hop') startHops();
    if (sl.phase === 'ratio') say('happy', 'For every ' + S.ramp.across + ' across, it goes up ' + S.ramp.books + '. That is a pattern!');
    if (sl.phase === 'predict') say('think', 'A longer ramp. Same steepness. How high?');
    if (sl.phase === 'done') say('idle', 'Does a steeper ramp send the car farther? Let us look.');
  }
};

function startHops() {
  // beside the ramp, clear of the books (they are 20 cm wide)
  const r = S.ramp, hp = R.hopPoints(r, 0.14);
  let upLabel = null;
  clearBlocks();
  say('happy', 'Here I go!');
  hopAlong(linePath(pipA.pos, hp.across[0], 0.07), {
    onDone: () => hopAlong(hp.across, {
      onStep: (k) => {
        pops.add(String(k), hp.across[k], '#8a6500');
        const t = $('#hopTxt'); if (t) t.textContent = k + ' across...';
        say('happy', String(k));
      },
      onDone: () => {
        // Repeat for height: one block per book, then Pip climbs them
        const bh = r.rise / r.books, base = hp.up[0];
        for (let i = 0; i < r.books; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, bh * 0.94, 0.05), new THREE.MeshStandardMaterial({ color: COLORS.repeat, transparent: true, opacity: 0.6 }));
          b.position.set(base.x, base.y + bh * (i + 0.5), base.z);
          root.add(b); objs.blocks.push(b);
        }
        hopAlong(hp.up.map((p) => R.vec(p.x, p.y + 0.001, p.z)), {
          hopHeight: 0.035,
          onStep: (k) => {
            // one label that counts up, so the labels do not pile on each other
            if (upLabel) root.remove(upLabel);
            upLabel = pops.add(k + ' up', R.vec(hp.up[k].x, hp.up[k].y + 0.02, hp.up[k].z), '#8a6500');
            const t = $('#hopTxt'); if (t) t.textContent = r.across + ' across, ' + k + ' up...';
            say('happy', k + ' up');
          },
          onDone: () => setTimeout(() => {
            if (S.screen !== 'slope') return;
            S.used.repeat = true; S.hint = null; drawGlove();
            log.add('tool_used', { tool: 'repeat', across: r.across, up: r.books });
            S.sl.phase = 'ratio'; render();
          }, 700)
        });
      }
    })
  });
}

screens.board = {
  html: () => {
    const best = bestRun(S.runs);
    const cards = S.runs.slice().reverse().map((r) =>
      '<article class="card' + (best && r.n === best.n ? ' rec' : '') + '"><header><b>Run ' + r.n + '</b><span>' + r.player + (best && r.n === best.n ? ' · record' : '') + '</span></header>' +
      '<p class="big">' + r.result + ' <small>shoes</small></p><p class="muted small">' + ratioText(r.books, r.across) + '. Bet ' + r.bet + ', Pip bet ' + r.pipBet + '.</p></article>').join('');
    return '<h2>Record cards</h2>' +
      (best ? '<p class="record">Record: ' + plural(best.result, 'shoe') + ' by ' + best.player + ' (' + plural(best.books, 'book') + ' high)</p><div class="cards">' + cards + '</div>' : '<p class="muted">No runs yet. Build a ramp and launch a car.</p>') +
      '<div class="row"><button class="btn" data-act="friend">Friend: beat it!</button><button class="btn alt" data-act="go" data-to="build">Another run</button></div>' +
      logBlock();
  },
  enter() { S.aiming = false; S.hint = null; say(S.runs.length ? 'happy' : 'idle', S.runs.length ? 'Look at all your stunts! Can a friend beat the record?' : 'No stunts yet. Let us build a ramp!'); }
};

function logBlock() {
  return '<details class="log"><summary>What the app recorded <span>' + log.rows.length + '</span></summary>' +
    '<button class="btn alt small" data-act="copylog">Copy log</button><pre id="logtxt">' + (log.text() || 'Nothing yet.') + '</pre></details>';
}

function render() {
  const sc = screens[S.screen];
  $('#panel').innerHTML = sc.html();
  $('#panel').scrollTop = 0;
  if (sc.enter) sc.enter();
  drawGlove();
  updateAimUI(true);
}
function go(to) {
  S.screen = to;
  if (to === 'slope') S.sl = { phase: 'count', wrong: 0 };
  if (to === 'compare') S.cmp = { wrong: 0, done: false, a: S.runs[S.runs.length - 2], b: S.runs[S.runs.length - 1] };
  render();
}

// Buttons that need the ring on a surface are disabled until it is.
let lastAimOk = null;
function updateAimUI(force) {
  const ok = aim.ok && S.aiming;
  $('#cross').hidden = !S.aiming;
  $('#cross').classList.toggle('ok', ok);
  if (!force && ok === lastAimOk) return;
  lastAimOk = ok;
  document.querySelectorAll('[data-needs-aim]').forEach((b) => { b.disabled = !ok; });
}

// ---------- actions ----------

function finishRun(result, aimed) {
  S.aiming = false;
  clearFlags(['aim']);
  const prevBest = bestRun(S.runs);
  const run = { n: S.runs.length + 1, player: S.player, books: S.books, across: S.ramp.across, bet: S.bet, pipBet: S.pipBet, result, ramp: S.ramp };
  S.runs.push(run);
  S.lastRun = run;
  if (aimed) log.add('landing_aimed', { shoes: result, along_cm: Math.round(aimed.alongCm), off_axis_cm: Math.round(aimed.offAxisCm) });
  log.add('result', { run: run.n, shoes: run.result, bet: run.bet, pip_bet: run.pipBet, books: run.books, across: run.across, player: run.player });
  setFlag('res', COLORS.ink, 'Stopped', result, 0, 0.23);
  const j = judge(run, prevBest);
  go('result');
  say(j.mood, j.msg);
}

const acts = {
  go: (d) => go(d.to),
  step(d) {
    const lim = LIMITS[d.k];
    S[d.k] = clamp(S[d.k] + Number(d.d), lim[0], lim[1]);
    $('#v-' + d.k).textContent = S[d.k];
    if (d.k === 'books' && pretend) pretend.setBooks(S.books, settings.bookCm);
    if (d.k === 'bet') setFlag('child', COLORS.child, 'You', S.bet, 0.035, 0.19);
  },
  player() { S.player = S.player === 'Me' ? 'Friend' : 'Me'; render(); },
  friend() { S.player = 'Friend'; log.add('player_switched', { player: 'Friend' }); go('build'); },
  place() {
    if (!aim.ok) return;
    root.matrix.copy(aim.matrix);
    if (mode === 'preview') root.matrix.makeTranslation(tmpV.setFromMatrixPosition(aim.matrix));
    root.updateMatrixWorld(true);
    if (mode === 'xr' && aim.hit && aim.hit.createAnchor) {
      aim.hit.createAnchor().then((a) => { if (anchor) anchor.delete(); anchor = a; }).catch(() => { /* keep the fixed pose */ });
    }
    pipA = createPip(R.vec(0, 0, 0));
    pipModel.visible = true;
    log.add('pip_placed', { mode, anchored: mode === 'xr' && !!(aim.hit && aim.hit.createAnchor), floor: aim.virtual ? 'guessed' : 'found' });
    go('build');
    say('happy', 'Here I am, on your floor! Walk around me.');
  },
  // Fallback when the phone finds no surface: aim at a flat floor at a guessed height
  // (the browser's floor estimate if it gives one, else 1.1 m below where the phone is now).
  placeGuess() {
    xr.floorY = xr.floorSpace ? 0 : xr.camY - 1.1;
    log.add('ar_session', { mode: 'webxr', floor_guess: xr.floorSpace ? 'local-floor' : 'camera_minus_1.1m' });
    say('think', 'I will guess where the floor is. Point at the floor and tap Put Pip here.');
  },
  makeNumbers() {
    if (!S.numFrame) S.numFrame = { foot: R.vec(pipA.pos.x, 0, pipA.pos.z), dir: R.sideDir(cameraForwardLocal()) };
    setRamp(R.rampFromNumbers({ foot: S.numFrame.foot, dir: S.numFrame.dir, books: S.books, across: S.across, bookCm: settings.bookCm, shoeCm: settings.shoeCm }), false);
    go('rampReady');
  },
  tapFoot() {
    const p = aimLocal(); if (!p) return;
    S.taps = { foot: p };
    addMark(p, COLORS.child);
    go('tapPile');
  },
  tapPile() {
    const p = aimLocal(); if (!p) return;
    const d = Math.hypot(p.x - S.taps.foot.x, p.z - S.taps.foot.z);
    if (d < 0.08) { $('#tapMsg').textContent = 'That is very close to the bottom. Point under the top of the tray.'; return; }
    // If the ring landed on the tray or a book, keep the spot but drop it to floor height.
    S.taps.pile = R.vec(p.x, S.taps.foot.y, p.z);
    addMark(S.taps.pile, COLORS.repeat);
    go('tapTop');
  },
  tapTop(d) {
    const topHit = d.skip ? null : aimLocal();
    const { foot, pile } = S.taps;
    const chk = R.checkTopHit(foot, pile, topHit);
    const top = chk.ok ? R.vec(pile.x, topHit.y, pile.z) : R.vec(pile.x, foot.y, pile.z);
    const ramp = R.rampFromTaps({ foot, top, books: S.books, bookCm: settings.bookCm, shoeCm: settings.shoeCm });
    S.topCheck = chk;
    if (ramp.error) { go('tapFoot'); $('#tapMsg').textContent = ramp.error === 'too_high' ? 'That top was too high. Try again.' : 'Those points were too close. Try again.'; return; }
    setRamp(ramp, true);
    go('rampReady');
  },
  rampOK() {
    const r = S.ramp;
    S.across = r.across;
    log.add('ramp_built', { books: r.books, across: r.across, player: S.player, method: r.method });
    log.add('ramp_measured', {
      method: r.method, run_cm: Math.round(r.run * 100), rise_cm: Math.round(r.rise * 1000) / 10,
      angle_deg: Math.round(r.angleDeg), height_from: r.heightFrom,
      top_hit: r.method === 'taps' ? S.topCheck.reason : undefined,
      top_hit_rise_cm: r.method === 'taps' && S.topCheck.riseCm != null ? Math.round(S.topCheck.riseCm * 10) / 10 : undefined,
      shoe_cm: settings.shoeCm, book_cm: settings.bookCm
    });
    go('bet');
  },
  lockbet() {
    if (!S.betReady) return;
    log.add('child_bet', { shoes: S.bet });
    go('launch');
  },
  pretendGo(d, el) {
    el.disabled = true;
    runCar('car', R.pretendRunShoes(S.ramp), null);
  },
  stopped() {
    log.add('launch_recorded', { video: false, watched: mode === 'xr' ? 'ar' : 'preview' });
    go('landing');
  },
  land() {
    const p = aimLocal(); if (!p) return;
    const a = R.shoesFromPoint(S.ramp, p);
    if (a.behind) { $('#aimTxt').textContent = 'That is behind the ramp. Point where the car stopped.'; return; }
    finishRun(Math.min(MAX_SHOES, a.shoes), a);
  },
  landManual() { finishRun(S.manual, null); },
  cmp(d, el) {
    if (S.cmp.done) return;
    const a = S.cmp.a, b = S.cmp.b, truth = compareTruth(a, b), ok = d.pick === truth;
    log.add('compare_answer', { picked: d.pick, correct: ok, run_a: a.n, run_b: b.n });
    if (!ok) {
      S.cmp.wrong++; el.classList.add('wrong');
      say('think', S.cmp.wrong > 1 ? 'Look at the floor: the farther car is the one furthest from the ramp.' : 'Look again. Where did each car stop?');
      if (S.cmp.wrong > 1 && truth !== 'same') S.pulse = truth;
      return;
    }
    S.cmp.done = true; S.pulse = null; el.classList.add('right');
    S.used.compare = true; S.hint = null; drawGlove();
    log.add('tool_used', { tool: 'compare', wrong_tries: S.cmp.wrong });
    const diff = Math.abs(a.result - b.result);
    const line = truth === 'same' ? 'Same spot! Both stopped at ' + a.result + '.' : 'Run ' + (truth === 'a' ? a.n : b.n) + ' went ' + plural(diff, 'shoe') + ' farther.';
    const chg = a.books !== b.books ? 'What changed: ' + a.books + ' books became ' + b.books + ' books.' : 'You used the same number of books both times.';
    say('happy', line);
    $('#cmpOut').innerHTML = '<p class="say-ok">' + line + '</p><p class="tip">' + chg + '</p>' +
      '<div class="row"><button class="btn glow" style="--fc:var(--c-repeat)" data-act="go" data-to="slope">Why? Count the ramp with Repeat</button><button class="btn alt" data-act="go" data-to="build">Go again</button></div>';
    S.hint = 'repeat'; drawGlove();
  },
  hop() { S.sl.phase = 'hop'; render(); },
  topredict() { S.sl.phase = 'predict'; render(); },
  pick(d, el) {
    const v = Number(d.v), ok = v === 2 * S.ramp.books;
    log.add('prediction', { asked_across: 2 * S.ramp.across, answer_books: v, correct: ok });
    if (!ok) {
      S.sl.wrong++; el.classList.add('wrong');
      $('#prOut').innerHTML = '<p class="say-no">Not quite. Picture two of your ramps joined end to end: the same steepness, twice as long.</p>';
      say('think', 'Two ramps joined together, same steepness. How high is the top now?');
      return;
    }
    el.classList.add('right');
    document.querySelectorAll('#prOpts .opt').forEach((b) => { b.disabled = true; });
    $('#prOut').innerHTML = '<p class="say-ok">Yes! Twice as long, twice as high. The pattern repeats.</p><div class="row"><button class="btn" data-act="todone">What does it mean for the car?</button><button class="btn alt" data-act="go" data-to="build">Try it for real</button></div>';
    say('happy', 'Twice as long needs twice as high. The pattern repeats!');
  },
  todone() { S.sl.phase = 'done'; render(); },
  copylog(d, btn) {
    const txt = log.text();
    const ok = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy log'; }, 1500); };
    const fallback = () => {
      const r = document.createRange(); r.selectNodeContents($('#logtxt'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = 'Selected, press copy';
    };
    try { navigator.clipboard.writeText(txt).then(ok, fallback); } catch (e) { fallback(); }
  },
  exit() { if (session) session.end(); else endGame(); },
  startXR: () => startXR(),
  startPreview: () => startPreview()
};

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const f = acts[b.getAttribute('data-act')];
  if (f) f(b.dataset, b);
});
// Taps on the overlay are for the buttons, not for the AR scene.
$('#overlay').addEventListener('beforexrselect', (e) => e.preventDefault());

// ---------- per-frame game updates ----------

let lastT = nowSec();
function tick() {
  const now = nowSec(), dt = Math.min(0.1, now - lastT);
  lastT = now;
  root.updateMatrixWorld(true);

  const p = pose(pipA, now);
  if (hopRun) {
    while (hopRun.counted < p.step) { hopRun.counted++; if (hopRun.onStep) hopRun.onStep(hopRun.counted); }
    if (p.done) { const h = hopRun; hopRun = null; settle(pipA, now); if (h.onDone) h.onDone(); }
  } else if (p.done) settle(pipA, now);
  if (pipModel.visible) applyPipPose(pipModel, pose(pipA, now), cameraLocal());

  carRuns = carRuns.filter((c) => {
    const u = (now - c.start) / c.dur, at = R.carOnRun(S.ramp, c.shoes, u);
    placeCar(c.car, at.onRamp ? onTray(at.pos) : at.pos, S.ramp.dir, at.pitchDeg);
    if (u >= 1) { if (c.onDone) c.onDone(); return false; }
    return true;
  });

  // live "about N shoes" while aiming at the landing spot
  if (S.screen === 'landing' && S.ramp) {
    const a = aim.ok ? aimLocal() : null;
    const t = $('#aimTxt');
    if (a) {
      const m = R.shoesFromPoint(S.ramp, a);
      if (!objs.flags.aim) setFlag('aim', COLORS.ink, null, 0);
      objs.flags.aim.position.set(a.x, a.y, a.z);
      const txt = m.behind ? 'That is behind the ramp.' : 'About ' + plural(Math.min(MAX_SHOES, m.shoes), 'shoe') + ' from the ramp.';
      if (t && t.textContent !== txt) t.textContent = txt;
    } else if (t && t.textContent !== 'Looking for the floor...') t.textContent = 'Looking for the floor...';
  }

  // the flag to look at bounces after two wrong compares
  ['a', 'b'].forEach((k) => {
    const f = objs.flags[k];
    if (f) f.position.y = f.userData.base + (S.pulse === k ? Math.abs(Math.sin(now * 5)) * 0.03 : 0);
  });
  // floor coaching and grown-up diagnostics on the first screen
  if (S.screen === 'place' && now - (S.diagAt || 0) > 0.4) {
    S.diagAt = now;
    const t = now - S.placeStart, ft = $('#floorTxt'), g = $('#guessBtn'), dg = $('#diag');
    if (ft) ft.textContent = floorHint(t);
    if (g) g.hidden = !(t > 12 && !aim.ok && xr.floorY == null);
    if (dg) dg.textContent = mode === 'xr'
      ? 'Tech info: frames ' + xr.frames + ', phone tracked ' + (xr.pose ? 'yes' : 'no') + ', floor hits ' + xr.hitFrames +
        ', space ' + xr.space + ', features ' + (xr.feats ? xr.feats.join(' ') : 'unknown') +
        (xr.errors ? ', errors ' + xr.errors + ': ' + xr.lastError : '')
      : 'Preview mode: no camera, a pretend room.';
  }
  pops.update(dt);
  reticle.visible = aim.ok && S.aiming;
  updateAimUI(false);
}

// ---------- preview mode (no AR): a pretend room you can look around ----------

const orbit = { theta: 0.5, phi: 1.0, r: 1.15, target: new THREE.Vector3(0.35, 0, 0.12), pts: new Map() };
const raycaster = new THREE.Raycaster();
const upQuat = new THREE.Quaternion();
function previewFrame() {
  camera.position.setFromSphericalCoords(orbit.r, orbit.phi, orbit.theta).add(orbit.target);
  camera.lookAt(orbit.target);
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hit = raycaster.intersectObjects(pretend.targets(), false)[0];
  aim.ok = !!hit;
  if (hit) aim.matrix.compose(hit.point.clone().add(new THREE.Vector3(0, 0.001, 0)), upQuat, new THREE.Vector3(1, 1, 1));
  reticle.matrix.copy(aim.matrix);
}
canvas.addEventListener('pointerdown', (e) => { orbit.pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'preview' || !orbit.pts.has(e.pointerId)) return;
  const prev = orbit.pts.get(e.pointerId);
  if (orbit.pts.size === 1) {
    orbit.theta -= (e.clientX - prev.x) * 0.008;
    orbit.phi = clamp(orbit.phi - (e.clientY - prev.y) * 0.006, 0.2, 1.5);
  } else {
    const [a, b] = [...orbit.pts.values()], before = Math.hypot(a.x - b.x, a.y - b.y);
    orbit.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [c, d] = [...orbit.pts.values()], after = Math.hypot(c.x - d.x, c.y - d.y);
    if (before > 0) orbit.r = clamp(orbit.r * before / after, 0.3, 3);
  }
  orbit.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
['pointerup', 'pointercancel'].forEach((n) => canvas.addEventListener(n, (e) => orbit.pts.delete(e.pointerId)));
canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.r = clamp(orbit.r * (1 + e.deltaY * 0.001), 0.3, 3); }, { passive: false });
window.addEventListener('resize', () => {
  if (mode === 'xr') return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- starting and ending ----------

function beginGame() {
  S = fresh(S);
  root.matrix.identity();
  pipModel.visible = false;
  document.body.classList.add('playing');
  $('#start').hidden = true;
  $('#hud').hidden = false;
  go('place');
}

function endGame() {
  if (anchor) { try { anchor.delete(); } catch (e) { /* gone */ } }
  anchor = null; hitSource = null; session = null;
  if (pretend) { scene.remove(pretend.room); pretend = null; }
  mode = null;
  renderer.setAnimationLoop(null);
  setRamp(null); clearFlags(); clearCars(); clearMarks(); clearBlocks();
  pipModel.visible = false; reticle.visible = false; aim.ok = false; hopRun = null;
  S.aiming = false; S.screen = 'start';
  if (window.speechSynthesis) speechSynthesis.cancel();
  document.body.classList.remove('playing', 'preview');
  $('#hud').hidden = true;
  $('#start').hidden = false;
  $('#startLog').innerHTML = S.runs.length ? logBlock() : '';
}

// One AR frame: read the hit test, the guessed floor and the anchor, then update and draw.
// three.js asks for the next AR frame only after this returns, so an uncaught error here
// would stop AR for good (the camera keeps showing, everything else freezes). Errors are
// caught, counted and shown in the tech info line instead.
const camPos = new THREE.Vector3(), camDir = new THREE.Vector3(), camQ = new THREE.Quaternion();
function xrStep(t, frame) {
  if (!frame) return;
  try {
    const ref = renderer.xr.getReferenceSpace();
    const vp = frame.getViewerPose(ref);
    xr.frames++;
    xr.pose = !!vp;
    const hits = hitSource ? frame.getHitTestResults(hitSource) : [];
    aim.virtual = false;
    if (hits.length) {
      xr.hitFrames++;
      const hp = hits[0].getPose(ref);
      aim.ok = !!hp; aim.hit = hits[0];
      if (hp) aim.matrix.fromArray(hp.transform.matrix);
    } else { aim.ok = false; aim.hit = null; }
    if (vp) {
      const p = vp.transform.position, o = vp.transform.orientation;
      camPos.set(p.x, p.y, p.z);
      xr.camY = p.y;
      // no real hit: use the guessed floor plane, if the fallback is on
      if (!aim.ok && xr.floorY != null) {
        camDir.set(0, 0, -1).applyQuaternion(camQ.set(o.x, o.y, o.z, o.w));
        const d = camDir.y < -0.05 ? (xr.floorY - camPos.y) / camDir.y : -1;
        if (d > 0 && d < 6) {
          aim.matrix.makeTranslation(camPos.x + camDir.x * d, xr.floorY, camPos.z + camDir.z * d);
          aim.ok = true; aim.virtual = true;
        }
      }
    }
    reticle.matrix.copy(aim.matrix);
    if (anchor && frame.trackedAnchors && frame.trackedAnchors.has(anchor)) {
      const ap = frame.getPose(anchor.anchorSpace, ref);
      if (ap) root.matrix.fromArray(ap.transform.matrix);
    }
    tick();
    renderer.render(scene, camera);
  } catch (err) {
    xr.errors++;
    if (!xr.lastError) {
      xr.lastError = String(err && err.message ? err.message : err).slice(0, 160);
      log.add('ar_session', { mode: 'webxr', error: xr.lastError, screen: S.screen });
    }
    try { updateAimUI(false); } catch (e) { /* keep going */ }
  }
}

async function startXR() {
  const status = $('#xrStatus');
  try {
    const s = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay'],
      optionalFeatures: ['anchors', 'local-floor'],
      domOverlay: { root: $('#overlay') }
    });
    session = s;
    mode = 'xr';
    scene.background = null;
    const feats = s.enabledFeatures ? Array.from(s.enabledFeatures) : null;
    Object.assign(xr, { frames: 0, pose: false, hitFrames: 0, feats, floorY: null, errors: 0, lastError: '' });
    xr.floorSpace = !!(feats && feats.indexOf('local-floor') >= 0);
    xr.space = xr.floorSpace ? 'local-floor' : 'local';
    renderer.xr.setReferenceSpaceType(xr.space);
    // Set the loop before the session starts, so three.js runs only the AR frame loop.
    // Setting it afterwards also restarts the normal browser loop, which draws outside AR frames.
    renderer.setAnimationLoop(xrStep);
    await renderer.xr.setSession(s);
    const viewer = await s.requestReferenceSpace('viewer');
    hitSource = await s.requestHitTestSource({ space: viewer });
    s.addEventListener('end', endGame);
    log.add('ar_session', { mode: 'webxr', features: feats, space: xr.space, dom_overlay: s.domOverlayState ? s.domOverlayState.type : null });
    status.textContent = '';
    beginGame();
  } catch (err) {
    status.textContent = 'Could not start AR: ' + (err && err.message ? err.message : err);
    status.className = 'warn';
    if (session) { try { session.end(); } catch (e) { /* ignore */ } }
  }
}

function startPreview() {
  mode = 'preview';
  pretend = makePretendRoom();
  pretend.setBooks(S.books, settings.bookCm);
  scene.add(pretend.room);
  scene.background = new THREE.Color(0xE9F0F2);
  document.body.classList.add('preview');
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  log.add('ar_session', { mode: 'preview' });
  beginGame();
  renderer.setAnimationLoop(previewStep);
}
function previewStep() {
  previewFrame();
  tick();
  renderer.render(scene, camera);
}

// ---------- the start page ----------

function bindSettings() {
  const shoe = $('#setShoe'), book = $('#setBook'), voice = $('#setVoice');
  shoe.value = settings.shoeCm; book.value = settings.bookCm; voice.checked = settings.voice;
  const upd = () => {
    settings.shoeCm = clamp(Number(shoe.value) || R.DEFAULTS.shoeCm, 10, 35);
    settings.bookCm = clamp(Number(book.value) || R.DEFAULTS.bookCm, 0.5, 8);
    settings.voice = voice.checked;
    saveSettings();
  };
  [shoe, book, voice].forEach((el) => el.addEventListener('change', upd));
}

async function checkSupport() {
  const status = $('#xrStatus'), btn = $('#xrBtn');
  let msg = '', ok = false;
  if (!window.isSecureContext) msg = 'AR needs a secure page (https or localhost). Preview still works.';
  else if (!navigator.xr) msg = 'This browser has no WebXR. On Android, open this page in Chrome. iPhone Safari is not expected to work (not yet checked on a device).';
  else {
    try { ok = await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { ok = false; }
    msg = ok ? 'AR is ready on this phone.' : 'This device or browser does not offer AR. Check that Google Play Services for AR is installed. Preview still works.';
  }
  btn.disabled = !ok;
  status.textContent = msg;
  status.className = ok ? 'okmsg' : 'warn';
}

bindSettings();
checkSupport();

// Installable and usable offline once loaded.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* fine without it */ });
}

// For headless tests: read-only view of the game state.
// aimAt() points the preview camera's centre at a spot in the pretend room.
window.__rsar = {
  get S() { return S; }, get mode() { return mode; }, get aimOk() { return aim.ok; }, log: () => log.rows, acts,
  aimAt(x, y, z) { orbit.target.set(x, y, z); if (mode === 'preview') previewStep(); }, aimLocal: () => aimLocal(),
  // step preview frames by hand (a hidden browser tab pauses requestAnimationFrame)
  frames(n = 1) { for (let i = 0; i < n; i++) if (mode === 'preview') previewStep(); }
};
