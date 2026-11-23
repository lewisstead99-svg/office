// All dates the office sees are in UK time (Europe/London).
const TZ = 'Europe/London';
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const longFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const isYmd = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);

export function londonDate(x) {
  if (isYmd(x)) return x;
  return ymdFmt.format(x instanceof Date ? x : new Date(x));
}

export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function longDate(x) {
  return longFmt.format(new Date(londonDate(x) + 'T00:00:00Z'));
}

export function londonDateTime(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  return `${longDate(d)}, ${timeFmt.format(d)}`;
}

export function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / 86400000);
}

// Whole UK calendar days from a's date to b's date (what "day 3" means to the office).
export function calendarDaysBetween(a, b) {
  return Math.round((Date.parse(londonDate(b) + 'T00:00:00Z') - Date.parse(londonDate(a) + 'T00:00:00Z')) / 86400000);
}

// The 14-day cancellation period ends 14 days after the (UK) day the contract was agreed.
export function coolingOffEnds(completedAtIso) {
  return addDays(londonDate(completedAtIso), 14);
}
