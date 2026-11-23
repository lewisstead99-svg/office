// A simple per-key sliding-window limiter. On Vercel it is per function instance, which is
// enough to blunt password guessing and link scraping; it is not a hard global limit.
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return key => {
    const t = now();
    const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
    return true;
  };
}
