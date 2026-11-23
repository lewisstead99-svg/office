import { londonDate, longDate, coolingOffEnds, daysBetween } from './dates.js';

export const EV = Object.freeze(Object.fromEntries([
  'created', 'sent', 'email_failed', 'opened', 'consented', 'signed', 'reminded', 'chased',
  'cancelled', 'expired', 'completed', 'seller_cancelled', 'replaced', 'reinstated', 'copy_emailed',
].map(k => [k, k])));

export const TABS = ['out', 'cooling', 'signed', 'ended', 'drafts'];

export function tabOf(state) {
  if (state === 'draft') return 'drafts';
  if (state === 'out' || state === 'cooling' || state === 'signed') return state;
  return 'ended';
}

// Work out where a contract stands from its event log. The log is the source of truth;
// contract.state is only a cached copy of this result.
export function deriveState({ contract, signers = [], events = [], now = new Date() }) {
  const has = type => events.some(e => e.type === type);
  const last = type => [...events].reverse().find(e => e.type === type);
  const signedCount = signers.filter(s => s.status === 'signed').length;
  const base = { coolingOffUntil: null, signedCount, signerCount: signers.length, daysWaiting: null };
  const out = (state, label, extra = {}) => ({ state, label, ...base, ...extra });

  if (has('cancelled')) return out('cancelled', 'Cancelled by office');
  if (!has('sent')) return out('draft', 'Draft');
  if (has('expired')) return out('expired', 'Expired');
  if (!has('completed')) {
    const sentAt = contract.sentAt || last('sent')?.at;
    return out('out', 'Out for signing', { daysWaiting: sentAt ? daysBetween(sentAt, now) : null });
  }
  const swap = [...events].reverse().find(e => e.type === 'replaced' || e.type === 'reinstated');
  if (swap?.type === 'replaced') return out('replaced', `Replaced by v${swap.data?.byVersion} on ${longDate(swap.at)}`);
  if (has('seller_cancelled')) return out('seller_cancelled', 'Cancelled by seller');

  const completedAt = contract.completedAt || last('completed')?.at;
  const end = coolingOffEnds(completedAt);
  const within = londonDate(now) <= end;
  if (within && signers.some(s => s.startMarketingNow === false)) {
    return out('cooling', `Cooling off until ${longDate(end)}`, { coolingOffUntil: end });
  }
  if (within && signers.length && signers.every(s => s.startMarketingNow === true)) {
    return out('signed', 'Signed – marketing may start');
  }
  return out('signed', 'Signed');
}
