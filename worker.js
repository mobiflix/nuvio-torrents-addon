// ============================================================
// NUVIO TORRENTS — Cloudflare Worker Addon (v3.0.0)
// Movies: YTS only (1080p, min 15 seeds)
// Series: hindi supported (walang reliable na source)
// ============================================================

const YTS_API_BASE = 'https://movies-api.accel.li/api/v2';
const MIN_SEEDS_MOVIE = 1;
const QUALITY_LABEL = '1080p';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'application/json'
};

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'https://tracker.moeblog.cn:443/announce',
  'udp://open.dstud.io:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'https://tracker.zhuqiy.com:443/announce',
  'https://tracker.pmman.tech:443/announce'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

// ============ MANIFEST ============
const MANIFEST = {
  id: 'community.nuvio.torrents',
  version: '3.0.0',
  name: 'MobiFlix',
  description: 'YTS movie torrents — 1080p, minimum 15 seeders.',
  logo: 'https://em-content.zobj.net/source/apple/391/eagle_1f985.png',
  author: 'Nuvio Team',
  types: ['movie'],
  idPrefixes: ['tt'],
  catalogs: [],
  resources: ['stream'],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
    logging: false
  }
};

// ============ HELPERS ============
function buildMagnet(hash, name) {
  if (!hash) return '';
  const trackers = TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('');
  const dn = name ? '&dn=' + encodeURIComponent(name) : '';
  return 'magnet:?xt=urn:btih:' + hash + dn + trackers;
}

function parseSizeBytes(sizeStr, torrent) {
  if (typeof torrent?.size === 'number' && torrent.size > 0) return Math.floor(torrent.size);
  if (typeof torrent?.bytes === 'number' && torrent.bytes > 0) return Math.floor(torrent.bytes);
  const m = String(sizeStr).match(/([0-9.]+)\s*([GM]B)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'GB') return Math.floor(val * 1073741824);
  if (unit === 'MB') return Math.floor(val * 1048576);
  return 0;
}

// ============ SOURCE: YTS (MOVIES ONLY) ============
async function fetchYTS(imdbId) {
  const debug = { source: 'YTS', url: '', count: 0, error: null };
  try {
    const url = YTS_API_BASE + '/list_movies.json?query_term=' + encodeURIComponent(imdbId);
    debug.url = url;
    const data = await fetch(url, { headers: HEADERS }).then(r => r.json()).catch(() => null);
    if (!data?.data?.movies?.length) {
      debug.error = 'no movies found';
      return { items: [], debug };
    }

    const out = [];
    for (const movie of data.data.movies) {
      for (const t of (movie.torrents || [])) {
        if (t.quality !== '1080p') continue;
        const seeds = parseInt(t.seeds) || 0;
        if (seeds < MIN_SEEDS_MOVIE) continue;
        out.push({
          source: 'YTS',
          hash: t.hash,
          filename: movie.title + ' ' + t.quality,
          seeds,
          peers: parseInt(t.peers) || 0,
          sizeBytes: parseSizeBytes(t.size, t),
          magnet: buildMagnet(t.hash, movie.title)
        });
      }
    }
    debug.count = out.length;
    return { items: out, debug };
  } catch (e) {
    debug.error = e?.message || String(e);
    return { items: [], debug };
  }
}

// ============ BUILD STREAMS ============
function buildStreams(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item.hash || seen.has(item.hash)) continue;
    seen.add(item.hash);
    unique.push(item);
  }
  if (!unique.length) return [];

  unique.sort((a, b) => b.seeds - a.seeds || a.sizeBytes - b.sizeBytes);

  return unique.map(item => {
    const sizeGB = (item.sizeBytes / 1073741824).toFixed(2);
    const extras = [];
    if (/\bX265\b|\bH\.?265\b|\bHEVC\b/i.test(item.filename)) extras.push('X265');
    else if (/\bX264\b|\bH\.?264\b|\bAVC\b/i.test(item.filename)) extras.push('X264');
    if (/\bHDR10\+?\b/i.test(item.filename)) extras.push('HDR10');
    else if (/\bHDR\b/i.test(item.filename)) extras.push('HDR');
    if (/\bATMOS\b/i.test(item.filename)) extras.push('ATMOS');
    if (/\bDTS\b/i.test(item.filename)) extras.push('DTS');
    if (/\b5\.1\b/i.test(item.filename)) extras.push('5.1');

    const titleLine = '🎬 ' + item.filename;
    const qualityLine = '🔥 ' + QUALITY_LABEL + (extras.length ? ' | ' + extras.join(' | ') : '');
    const statsLine = '🌱 ' + item.seeds + ' | 💾 ' + sizeGB + ' GB | 🔗 ' + item.source;
    const description = titleLine + '\n' + qualityLine + '\n' + statsLine;

    return {
      name: item.source + ' | ' + QUALITY_LABEL.toUpperCase() + ' | 🌱 ' + item.seeds,
      title: description,
      description: description,
      url: item.magnet,
      behaviorHints: {
        bingeGroup: 'nuvio-torrents-' + item.source + '-1080p'
      }
    };
  });
}

// ============ ID PARSER ============
function parseId(id) {
  const parts = String(id).split(':');
  return { imdbId: parts[0] };
}

// ============ STREAM HANDLER ============
async function handleStream(type, id) {
  // Movies lang ang supported
  if (type !== 'movie') {
    return { streams: [], _debug: { error: 'series not supported', type, id } };
  }

  const { imdbId } = parseId(id);
  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    return { streams: [], _debug: { error: 'invalid imdb', id } };
  }

  const allDebug = { type, id, imdbId, sources: [] };
  const ytsResult = await fetchYTS(imdbId);
  allDebug.sources.push(ytsResult.debug);

  const streams = buildStreams(ytsResult.items);
  return { streams, _debug: allDebug };
}

// ============ ROUTER ============
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === '/manifest.json' || path === '/') {
      return new Response(JSON.stringify(MANIFEST), { headers: CORS });
    }

    const debugMatch = path.match(/^\/debug\/([^/]+)\/(.+)\.json$/);
    if (debugMatch) {
      const type = debugMatch[1];
      const id = decodeURIComponent(debugMatch[2]);
      try {
        const result = await handleStream(type, id);
        return new Response(JSON.stringify(result, null, 2), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }, null, 2), { headers: CORS });
      }
    }

    const streamMatch = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = decodeURIComponent(streamMatch[2]);
      try {
        const result = await handleStream(type, id);
        return new Response(JSON.stringify({ streams: result.streams }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ streams: [], error: e.message }), { headers: CORS });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
  }
};
