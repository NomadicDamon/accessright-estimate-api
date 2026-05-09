// Edge Function — streams page-discovery progress as SSE events.
// Vercel Edge Runtime gives 30s, no crawl cap needed.
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NON_PAGE_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|tar\.gz|gz|rar|7z|mp3|wav|ogg|flac|aac|m4a|mp4|avi|mov|wmv|flv|webm|mkv|woff2?|ttf|eot|otf|js|css|json|csv|map|swf|exe|dmg|pkg|deb|rpm|png|jpg|jpeg|gif|webp|svg|ico|avif|bmp|tiff?)(\?.*)?$/i;
const NON_PAGE_PATH = /\/wp-json(\/|$)|\/feed(\/|$)|\/page\/\d+\/|%7[Bb]%7[Bb]|\{\{|xmlrpc\.php/i;

function isPageUrl(u) {
  try {
    const p = new URL(u).pathname;
    return !NON_PAGE_EXT.test(p) && !NON_PAGE_PATH.test(p);
  } catch { return false; }
}

function normalizePageUrl(u) {
  try {
    const parsed = new URL(u);
    parsed.pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    parsed.hash = '';
    parsed.search = '';
    return parsed.href;
  } catch { return null; }
}

function normalizeOrigin(url) {
  const u = new URL(url.startsWith('http') ? url : `https://${url}`);
  return `${u.protocol}//${u.host}`;
}

// ── Pricing config ────────────────────────────────────────────────────────────
// Base fee covers the first basePages pages. Each additional page is charged at
// the rate for the tier it falls into — rates decrease at each volume break.
const PRICING = {
  base:      500,  // minimum price
  basePages: 10,   // pages included in base
  tiers: [
    { upTo: 50,       rate: 20 },  // pages 11–50
    { upTo: 100,      rate: 14 },  // pages 51–100
    { upTo: 150,      rate: 11 },  // pages 101–150
    { upTo: 200,      rate: 9  },  // pages 151–200
    { upTo: Infinity, rate: 7  },  // pages 201+
  ],
};

function calculatePrice(pageCount) {
  if (pageCount <= PRICING.basePages) return PRICING.base;
  let price = PRICING.base;
  let prev = PRICING.basePages;
  let remaining = pageCount - PRICING.basePages;
  for (const tier of PRICING.tiers) {
    const inTier = Math.min(remaining, tier.upTo - prev);
    if (inTier <= 0) break;
    price += inTier * tier.rate;
    remaining -= inTier;
    prev = tier.upTo;
    if (remaining <= 0) break;
  }
  return price;
}
// ──────────────────────────────────────────────────────────────────────────────

function abortAfter(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function findSitemapCandidates(origin) {
  const candidates = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: abortAfter(5000) });
    if (res.ok) {
      const text = await res.text();
      for (const m of text.match(/^Sitemap:\s*(.+)$/gim) ?? []) {
        candidates.push(m.replace(/^Sitemap:\s*/i, '').trim());
      }
    }
  } catch {}
  if (!candidates.length) {
    candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
  }
  return candidates;
}

async function parseSitemap(url, urlSet, onProgress, depth = 0) {
  if (depth > 5) return;
  try {
    const res = await fetch(url, { signal: abortAfter(5000) });
    if (!res.ok) return;
    const text = await res.text();
    for (const [, loc] of text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)) {
      const trimmed = loc.trim();
      if (trimmed.endsWith('.xml') || trimmed.endsWith('.xml.gz')) {
        await parseSitemap(trimmed, urlSet, onProgress, depth + 1);
      } else {
        const norm = normalizePageUrl(trimmed);
        if (norm) {
          urlSet.add(norm);
          if (urlSet.size % 5 === 0) onProgress({ type: 'progress', count: urlSet.size });
        }
      }
    }
  } catch {}
}

function extractLinks(html, origin) {
  const links = new Set();
  const originHost = new URL(origin).hostname;
  const re = /href=["']([^"'#?]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const norm = normalizePageUrl(new URL(m[1], origin).href);
      if (!norm) continue;
      const u = new URL(norm);
      if (u.hostname === originHost && u.protocol.startsWith('http') && isPageUrl(norm)) {
        links.add(norm);
      }
    } catch {}
  }
  return Array.from(links);
}

async function crawlSite(origin, onProgress) {
  const visited = new Set();
  const queued = new Set([`${origin}/`]);
  const deadline = Date.now() + 25000; // leave 5s for overhead within the 30s Edge limit

  while (queued.size > 0 && visited.size <= 200 && Date.now() < deadline) {
    const batch = Array.from(queued).slice(0, 10);
    for (const u of batch) queued.delete(u);

    await Promise.allSettled(
      batch.map(async (url) => {
        if (visited.has(url)) return;
        visited.add(url);
        try {
          const res = await fetch(url, { signal: abortAfter(1000) });
          if (!res.ok) return;
          for (const link of extractLinks(await res.text(), origin)) {
            if (!visited.has(link) && !queued.has(link)) queued.add(link);
          }
        } catch {}
      })
    );

    onProgress({ type: 'progress', count: visited.size });
    if (visited.size > 200) { onProgress({ type: 'complete', overLimit: true }); return; }
  }

  const count = visited.size;
  if (count > 200) { onProgress({ type: 'complete', overLimit: true }); return; }
  onProgress({ type: 'complete', pageCount: count, price: calculatePrice(count), pages: Array.from(visited).sort() });
}

async function discoverUrls(origin, onProgress) {
  const candidates = await findSitemapCandidates(origin);
  const discovered = new Set();

  for (const candidate of candidates) {
    await parseSitemap(candidate, discovered, onProgress);
  }

  const sameOrigin = Array.from(discovered).filter(u => {
    try { return new URL(u).hostname === new URL(origin).hostname && isPageUrl(u); } catch { return false; }
  });

  if (sameOrigin.length > 0) {
    onProgress({ type: 'progress', count: sameOrigin.length });
    if (sameOrigin.length > 200) { onProgress({ type: 'complete', overLimit: true }); return; }
    onProgress({ type: 'complete', pageCount: sameOrigin.length, price: calculatePrice(sameOrigin.length), pages: sameOrigin.sort() });
    return;
  }

  await crawlSite(origin, onProgress);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const { url } = body ?? {};
  if (!url || typeof url !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing url field' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let origin;
  try { origin = normalizeOrigin(url); } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await discoverUrls(origin, send);
      } catch {
        send({ type: 'error', message: 'Scan failed. Please try again.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
