// ============================================================
// NUVIO TORRENTS — Cloudflare Worker Addon (v1.1.0)
// Sources: YTS + EZTV + 1337x (via apibay)
// Quality: 1080p only
// ============================================================

const TMDB_API_KEY = '1865f43a0549ca50d341dd9ab8b29f49';
const YTS_API_BASE = 'https://movies-api.accel.li/api/v2';
const MIN_SEEDS_MOVIE = 15;
const MIN_SEEDS_SERIES = 5;   // mas mababa para sa series
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
  version: '1.1.0',
  name: 'MobiFlix',
  description: '1080p torrent magnet links — YTS + EZTV + 1337x.',
  logo: 'https://em-content.zobj.net/source/apple/391/eagle_1f985.png',
  author: 'Nuvio Team',
  types: ['movie', 'series'],
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

function normalizeTitle(title) {
  if (!title) return '';
  return String(title).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function titleWords(title) {
  return normalizeTitle(title).split(/\s+/).filter(w => w.length > 2);
}

function buildSePatterns(season, episode) {
  const s = String(season), e = String(episode);
  const sPad = s.padStart(2, '0'), ePad = e.padStart(2, '0');
  return [
    new RegExp('S' + sPad + '[\\s._-]?E' + ePad, 'i'),
    new RegExp('\\b' + s + 'x' + ePad + '\\b', 'i'),
    new RegExp('Season[\\s._-]?' + s + '[\\s._-]?Episode[\\s._-]?' + e, 'i'),
    new RegExp('S' + sPad + '[\\s._-]?' + ePad, 'i'),
    new RegExp('\\b' + sPad + ePad + '\\b', 'i')
  ];
}

function matchesSe(name, season, episode) {
  return buildSePatterns(season, episode).some(p => p.test(name));
}

function is1080p(filename) {
  return /\b1080p\b|\bFHD\b/i.test(filename);
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

// ============ SOURCE: YTS ============
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

// ============ SOURCE: EZTV ============
async function fetchEztv(imdbId, season, episode) {
  const debug = { source: 'EZTV', url: '', count: 0, error: null };
  try {
    // EZTV requires NUMERIC imdb_id (no "tt")
    const numericId = String(imdbId).replace(/^tt/, '');
    const url = 'https://eztvx.to/api/get-torrents?imdb_id=' + numericId + '&limit=100';
    debug.url = url;
    const data = await fetch(url, { headers: HEADERS }).then(r => r.json()).catch(() => null);
    if (!data?.torrents || !Array.isArray(data.torrents)) {
      debug.error = 'no torrents array';
      return { items: [], debug };
    }
    debug.totalFetched = data.torrents.length;

    const out = [];
    for (const t of data.torrents) {
      if (!t?.hash || !t?.filename) continue;
      if (String(t.season) !== String(season) || String(t.episode) !== String(episode)) continue;
      if (!is1080p(t.filename)) continue;
      const seeds = parseInt(t.seeds) || 0;
      if (seeds < MIN_SEEDS_SERIES) continue;
      out.push({
        source: 'EZTV',
        hash: t.hash,
        filename: t.filename,
        seeds,
        peers: parseInt(t.peers) || 0,
        sizeBytes: parseInt(t.size_bytes) || 0,
        magnet: t.magnet_url || buildMagnet(t.hash, t.filename)
      });
    }
    debug.count = out.length;
    return { items: out, debug };
  } catch (e) {
    debug.error = e?.message || String(e);
    return { items: [], debug };
  }
}

// ============ SOURCE: 1337x (via apibay) ============
async function fetch1337x(title, season, episode) {
  const debug = { source: '1337x', urls: [], count: 0, error: null };
  try {
    const queries = [
      title + ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0') + ' 1080p',
      title + ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0') + ' x265',
      title + ' ' + season + 'x' + String(episode).padStart(2, '0') + ' 1080p'
    ];
    const seen = new Set();
    const all = [];
    for (const q of queries) {
      try {
        const url = 'https://apibay.org/q.php?q=' + encodeURIComponent(q) + '&cat=0';
        debug.urls.push(url);
        const arr = await fetch(url, { headers: HEADERS }).then(r => r.json()).catch(() => null);
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (t && t.info_hash && !seen.has(t.info_hash) && t.info_hash !== '0000000000000000000000000000000000000000') {
              seen.add(t.info_hash);
              all.push(t);
            }
          }
        }
      } catch (_) {}
    }
    debug.totalFetched = all.length;

    const out = [];
    const tWords = titleWords(title);
    for (const t of all) {
      if (!matchesSe(t.name, season, episode)) continue;
      if (!is1080p(t.name)) continue;
      const seeds = parseInt(t.seeders) || 0;
      if (seeds < MIN_SEEDS_SERIES) continue;
      const nameNorm = normalizeTitle(t.name);
      const matched = tWords.filter(w => nameNorm.includes(w));
      if (matched.length < Math.max(1, Math.floor(tWords.length * 0.5))) continue;

      out.push({
        source: '1337x',
        hash: t.info_hash,
        filename: t.name,
        seeds,
        peers: parseInt(t.leechers) || 0,
        sizeBytes: parseInt(t.size) || 0,
        magnet: buildMagnet(t.info_hash, t.name)
      });
    }
    debug.count = out.length;
    return { items: out, debug };
  } catch (e) {
    debug.error = e?.message || String(e);
    return { items: [], debug };
  }
}

// ============ TMDB LOOKUP ============
async function lookupTmdb(imdbId, isSeries) {
  try {
    const url = 'https://api.themoviedb.org/3/find/' + imdbId +
      '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id';
    const data = await fetch(url).then(r => r.json()).catch(() => null);
    if (!data) return { title: 'Unknown', year: 'N/A', imdbId };
    const item = isSeries
      ? (data.tv_results && data.tv_results[0])
      : (data.movie_results && data.movie_results[0]);
    if (!item) return { title: 'Unknown', year: 'N/A', imdbId };
    return {
      title: item.title || item.name || 'Unknown',
      year: (item.release_date || item.first_air_date || 'N/A').split('-')[0],
      imdbId
    };
  } catch (e) {
    return { title: 'Unknown', year: 'N/A', imdbId };
  }
}

// ============ BUILD STREAMS ============
function buildStreams(items, title, year, isSeries, season, episode) {
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

    const titleLine = isSeries
      ? '🎬 ' + title + ' S' + String(season).padStart(2, '0') + ' E' + String(episode).padStart(2, '0')
      : '🎬 ' + title + ' (' + year + ')';
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
  const imdbId = parts[0];
  let season = null, episode = null;
  if (parts.length >= 3) {
    season = parseInt(String(parts[1]).replace(/^S/i, ''));
    episode = parseInt(String(parts[2]).replace(/^E/i, ''));
  } else if (parts.length === 2) {
    season = parseInt(String(parts[1]).replace(/^S/i, ''));
  }
  return { imdbId, season, episode };
}

// ============ STREAM HANDLER ============
async function handleStream(type, id) {
  const isSeries = type === 'series' || type === 'tv';
  const { imdbId, season, episode } = parseId(id);

  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    return { streams: [], _debug: { error: 'invalid imdb', id } };
  }

  const meta = await lookupTmdb(imdbId, isSeries);
  const allDebug = { type, id, imdbId, season, episode, meta, sources: [] };

  if (meta.title === 'Unknown') {
    return { streams: [], _debug: { ...allDebug, error: 'tmdb unknown title' } };
  }

  const promises = [];
  if (!isSeries) {
    promises.push(fetchYTS(imdbId));
  } else if (season && episode) {
    promises.push(fetchEztv(imdbId, season, episode));
    promises.push(fetch1337x(meta.title, season, episode));
  } else {
    return { streams: [], _debug: { ...allDebug, error: 'missing season/episode' } };
  }

  const settled = await Promise.allSettled(promises);
  const merged = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      merged.push(...s.value.items);
      allDebug.sources.push(s.value.debug);
    } else {
      allDebug.sources.push({ error: s.reason?.message || String(s.reason) });
    }
  }

  const streams = buildStreams(merged, meta.title, meta.year, isSeries, season, episode);
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

    // 🔥 DEBUG endpoint — buksan ito sa browser para makita kung saan nawawala
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
        // huwag isama ang _debug sa normal response
        return new Response(JSON.stringify({ streams: result.streams }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ streams: [], error: e.message }), { headers: CORS });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
  }
};
