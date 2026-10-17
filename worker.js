// ============================================================
// NUVIO TORRENTS — Cloudflare Worker Addon (v3.2.0)
// Movies: YTS (1080p, min 15 seeds) + TPB (1080p, min 15 seeds)
// Series: TPB only (S01E01 packs/episodes, 1080p, min 15 seeds)
// ============================================================

const YTS_API_BASE = 'https://movies-api.accel.li/api/v2';
const TPB_API_BASE = 'https://apibay.org';
const TMDB_API_KEY = 'e0a7266a5d0e95c36475f349d8bc0a5a';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const MIN_SEEDS_MOVIE = 15;
const MIN_SEEDS_SERIES = 15;
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
  version: '3.2.0',
  name: 'MobiFlix',
  description: 'YTS + The Pirate Bay torrents — 1080p, minimum 15 seeders. Movies & series.',
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

function parseImdbFromId(id) {
  const parts = String(id).split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1]) : null,
    episode: parts[2] ? parseInt(parts[2]) : null
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  return res.json();
}

// ============ TMDB (for TPB search titles) ============
async function getTmdbInfo(imdbId, type) {
  // type: 'movie' | 'tv'
  const findUrl = TMDB_BASE + '/find/' + imdbId +
    '?api_key=' + TMDB_API_KEY + '&language=en-US&external_source=imdb_id';
  const data = await fetchJson(findUrl);
  if (type === 'tv') {
    const show = data?.tv_results?.[0];
    if (!show) return { title: '', year: '' };
    return {
      title: show.name || '',
      year: (show.first_air_date || '').split('-')[0] || ''
    };
  }
  const movie = data?.movie_results?.[0];
  if (!movie) return { title: '', year: '' };
  return {
    title: movie.title || '',
    year: (movie.release_date || '').split('-')[0] || ''
  };
}

// ============ SOURCE: YTS (MOVIES ONLY) ============
async function fetchYTS(imdbId) {
  const debug = { source: 'YTS', url: '', count: 0, error: null };
  try {
    const url = YTS_API_BASE + '/list_movies.json?query_term=' + encodeURIComponent(imdbId);
    debug.url = url;
    const data = await fetchJson(url).catch(() => null);
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

// ============ SOURCE: THE PIRATE BAY (MOVIES + SERIES) ============
async function fetchTPB(imdbId, mediaType, season, episode) {
  const debug = { source: 'TPB', mediaType, url: '', count: 0, error: null };
  try {
    const info = await getTmdbInfo(imdbId, mediaType).catch(() => ({ title: '', year: '' }));
    if (!info.title) {
      debug.error = 'no tmdb title';
      return { items: [], debug };
    }

    // Build query
    let query = info.title;
    if (mediaType === 'tv' && season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      query += ' S' + s + 'E' + e;
    } else if (mediaType === 'movie' && info.year) {
      query += ' ' + info.year;
    }
    const url = TPB_API_BASE + '/q.php?q=' + encodeURIComponent(query);
    debug.url = url;

    const results = await fetchJson(url).catch(() => null);
    if (!Array.isArray(results) || !results.length) {
      debug.error = 'no results';
      return { items: [], debug };
    }
    if (results[0]?.name === 'No results returned') {
      debug.error = 'no results returned';
      return { items: [], debug };
    }

    const out = [];
    for (const item of results) {
      const hash = item.info_hash;
      if (!hash || hash === '0000000000000000000000000000000000000000') continue;

      const name = item.name || '';
      if (!/1080[pP]/.test(name)) continue;

      const seeds = parseInt(item.seeders || '0', 10) || 0;
      const minSeeds = mediaType === 'tv' ? MIN_SEEDS_SERIES : MIN_SEEDS_MOVIE;
      if (seeds < minSeeds) continue;

      const sizeBytes = parseInt(item.size || '0', 10) || 0;

      out.push({
        source: 'TPB',
        hash,
        filename: name.replace(/\.torrent$/i, ''),
        seeds,
        peers: parseInt(item.leechers || '0', 10) || 0,
        sizeBytes,
        magnet: buildMagnet(hash, name)
      });
    }
    debug.count = out.length;
    return { items: out, debug };
  } catch (e) {
    debug.error = e?.message || String(e);
    return { items: [], debug };
  }
}

// ============ BUILD STREAMS (UNIFIED) ============
function buildStreams(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item.hash || seen.has(item.hash)) continue;
    seen.add(item.hash);
    unique.push(item);
  }
  if (!unique.length) return [];

  // Mataas na seeds muna; pag pantay, mas maliit na size muna
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

    const srcEmoji = item.source === 'TPB' ? '☠️' : '🎬';
    const titleLine = srcEmoji + ' ' + item.filename;
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

// ============ STREAM HANDLER ============
async function handleStream(type, id) {
  if (type !== 'movie' && type !== 'series') {
    return { streams: [], _debug: { error: 'unsupported type', type, id } };
  }

  const { imdbId, season, episode } = parseImdbFromId(id);
  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    return { streams: [], _debug: { error: 'invalid imdb', id } };
  }

  const isMovie = type === 'movie';
  const mediaType = isMovie ? 'movie' : 'tv';

  const allDebug = { type, id, imdbId, season, episode, sources: [] };

  // YTS lang para sa movies. TPB para sa movies at series.
  const tasks = [
    fetchTPB(imdbId, mediaType, season, episode)
  ];
  if (isMovie) tasks.unshift(fetchYTS(imdbId));

  const results = await Promise.all(tasks);
  for (const r of results) allDebug.sources.push(r.debug);

  const merged = results.flatMap(r => r.items);
  const streams = buildStreams(merged);
  allDebug.total = streams.length;

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
