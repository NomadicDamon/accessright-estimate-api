// Vercel serverless function — POST /api/public/estimate
// Counts pages via sitemap (fast, accurate) with HTTP crawl fallback.
// Designed to stay within Vercel Hobby's 10s execution limit.

const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|avif|bmp|tiff?)(\?.*)?$/i;

function isPageUrl(u) {
  try { return !IMAGE_EXT.test(new URL(u).pathname); } catch { return false; }
}

function normalizeOrigin(url) {
  const u = new URL(url.startsWith('http') ? url : `https://${url}`);
  return `${u.protocol}//${u.host}`;
}

const TIERS = [
  { max: 10,  price: 500,  label: 'Up to 10 pages' },
  { max: 50,  price: 1000, label: 'Up to 50 pages' },
  { max: 100, price: 2000, label: 'Up to 100 pages' },
  { max: 200, price: 3000, label: 'Up to 200 pages' },
];

function getTier(count) {
  return TIERS.find(t => count <= t.max) ?? null;
}

async function findSitemapCandidates(origin) {
  const candidates = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(5000) });
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

async function parseSitemap(url, urlSet, depth = 0) {
  if (depth > 5 || urlSet.size > 201) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const text = await res.text();
    for (const [, loc] of text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)) {
      const trimmed = loc.trim();
      if (trimmed.endsWith('.xml') || trimmed.endsWith('.xml.gz')) {
        await parseSitemap(trimmed, urlSet, depth + 1);
      } else {
        urlSet.add(trimmed);
      }
      if (urlSet.size > 201) return;
    }
  } catch {}
}

function extractLinks(html, origin) {
  const links = new Set();
  const originHost = new URL(origin).hostname;
  const hrefRegex = /href=["']([^"'#?]+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const u = new URL(new URL(match[1], origin).href);
      if (u.hostname === originHost && u.protocol.startsWith('http') && isPageUrl(u.href)) {
        u.hash = '';
        u.search = '';
        links.add(u.href);
      }
    } catch {}
  }
  return Array.from(links);
}

// Crawl cap and time budget sized to stay within the 10s Vercel Hobby limit.
const CRAWL_CAP = 40;
const CRAWL_BUDGET_MS = 6000;

async function crawlSite(origin) {
  const visited = new Set();
  const queued = new Set([`${origin}/`]);
  const deadline = Date.now() + CRAWL_BUDGET_MS;

  while (queued.size > 0 && visited.size < CRAWL_CAP && Date.now() < deadline) {
    const batch = Array.from(queued).slice(0, 5);
    for (const u of batch) queued.delete(u);

    const results = await Promise.allSettled(
      batch.map(async (url) => {
        if (visited.has(url)) return [];
        visited.add(url);
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) return [];
          return extractLinks(await res.text(), origin);
        } catch { return []; }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const link of r.value) {
          if (!visited.has(link) && !queued.has(link)) queued.add(link);
        }
      }
    }
  }

  return {
    count: visited.size,
    hitCap: visited.size >= CRAWL_CAP || Date.now() >= deadline,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body ?? {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url field' });
  }

  let origin;
  try {
    origin = normalizeOrigin(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    // Sitemap path — fast and accurate for most sites
    const candidates = await findSitemapCandidates(origin);
    const discovered = new Set();
    for (const candidate of candidates) {
      await parseSitemap(candidate, discovered);
      if (discovered.size > 201) break;
    }

    const sameOrigin = Array.from(discovered).filter(u => {
      try { return new URL(u).hostname === new URL(origin).hostname && isPageUrl(u); } catch { return false; }
    });

    if (sameOrigin.length > 0) {
      if (sameOrigin.length > 200) return res.json({ overLimit: true });
      const tier = getTier(sameOrigin.length);
      return res.json({ pageCount: sameOrigin.length, tier: tier?.label, price: tier?.price ?? null });
    }

    // Crawl fallback for sites without a sitemap
    const { count, hitCap } = await crawlSite(origin);
    if (hitCap) return res.json({ hitCap: true, pageCount: count });
    if (count > 200) return res.json({ overLimit: true });
    const tier = getTier(count);
    return res.json({ pageCount: count, tier: tier?.label, price: tier?.price ?? null });

  } catch (err) {
    console.error('[estimate]', err);
    return res.status(500).json({ error: 'Failed to scan site. Please try again.' });
  }
}
