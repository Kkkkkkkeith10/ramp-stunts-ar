// The event log: what a later AI "Pip brain" would read. It stays on the device.
// The first nine names match the 2D demo and must not be renamed; AR adds new ones.

export const EVENT_NAMES = [
  'session_start', 'ramp_built', 'pip_bet', 'child_bet', 'launch_recorded',
  'result', 'compare_answer', 'tool_used', 'prediction',
  // added for the AR prototype
  'ar_session', 'pip_placed', 'ramp_measured', 'landing_aimed', 'player_switched'
];

export function createLog(now = () => Date.now()) {
  const t0 = now();
  const rows = [];
  return {
    rows,
    add(e, data) {
      if (EVENT_NAMES.indexOf(e) < 0) throw new Error('Unknown event: ' + e);
      const row = { t: Math.round((now() - t0) / 1000), e };
      if (data) Object.keys(data).forEach((k) => { row[k] = data[k]; });
      rows.push(row);
      return row;
    },
    text() { return rows.map((r) => JSON.stringify(r)).join('\n'); }
  };
}
