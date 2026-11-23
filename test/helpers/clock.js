// A controllable clock: call it to get "now" as a Date.
export function fakeClock(iso = '2026-11-23T10:00:00Z') {
  let t = Date.parse(iso);
  const clock = () => new Date(t);
  clock.set = v => { t = Date.parse(v); };
  clock.advanceDays = n => { t += n * 86400000; };
  clock.advanceMs = n => { t += n; };
  return clock;
}
