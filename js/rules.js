// Game rules and Pip's wording, ported from the 2D demo (prototypes/ramp-stunts.html).
// Pure functions, no DOM.

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
export const ratioText = (books, across) => plural(books, 'book') + ' up for every ' + plural(across, 'shoe') + ' across';

// Pip's bet grows with the books, so a steeper ramp makes him bet farther.
export const pipBet = (books) => clamp(2 + books, 1, 11);

export function bestRun(runs) {
  let b = null;
  runs.forEach((r) => { if (!b || r.result > b.result) b = r; });
  return b;
}

// Who was closer, and what Pip says about it.
export function judge(run, prevBest) {
  const dBet = Math.abs(run.bet - run.result), dPip = Math.abs(run.pipBet - run.result);
  let msg, mood = 'happy', winner;
  if (dBet === 0) { msg = 'Exactly! You called it.'; winner = 'child'; }
  else if (dBet < dPip) { msg = 'You beat my guess!'; winner = 'child'; }
  else if (dBet > dPip) { msg = 'I was closer this time!'; mood = 'oops'; winner = 'pip'; }
  else { msg = 'We missed by the same amount.'; winner = 'tie'; }
  const record = !prevBest || run.result > prevBest.result;
  if (record && prevBest) msg = 'New record! ' + msg;
  return { msg, mood, winner, record };
}

// Which glove finger the world needs next: Compare after two runs, then Repeat.
export function nextTool(runs, used) {
  if (runs.length >= 2 && !used.compare) return 'compare';
  if (used.compare && !used.repeat) return 'repeat';
  return null;
}

export function compareTruth(a, b) {
  return a.result > b.result ? 'a' : (a.result < b.result ? 'b' : 'same');
}

// Three answers for "twice as long, how high?", always including the right one (2 x books).
export function predictOptions(books) {
  const opts = [];
  [books, 2 * books, books + 2, books + 3].forEach((x) => { if (opts.indexOf(x) < 0) opts.push(x); });
  const out = opts.slice(0, 3);
  if (out.indexOf(2 * books) < 0) out[2] = 2 * books;
  return out.sort((x, y) => x - y);
}

export function discovery(runs) {
  let lo = null, hi = null;
  runs.forEach((r) => {
    if (!lo || r.books < lo.books || (r.books === lo.books && r.result > lo.result)) lo = r;
    if (!hi || r.books > hi.books || (r.books === hi.books && r.result > hi.result)) hi = r;
  });
  if (!lo || lo.books === hi.books) return 'Try a different number of books and run again. Then we can see whether steeper goes farther.';
  const diff = hi.result - lo.result;
  if (diff > 0) return 'Your steeper ramp (' + ratioText(hi.books, hi.across) + ') went ' + plural(diff, 'shoe') + ' farther than the flatter one (' + ratioText(lo.books, lo.across) + ').';
  if (diff === 0) return 'The steeper and flatter ramps stopped in the same place. Why might that happen?';
  return 'The steeper ramp did not go farther this time. Maybe it is too steep and the car tumbled. What do you think?';
}
