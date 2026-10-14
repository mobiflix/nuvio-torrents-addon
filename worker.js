// ============================================================
// NUVIO TORRENTS — Cloudflare Worker Addon (v2.0.0)
// Movies:  YTS (1080p, min 15 seeds)
// Series:  Torrentio (aggregated, 1080p, min 3 seeds)
// ============================================================

const TMDB_API_KEY = '1865f43a0549ca50d341dd9ab8b29f49';
const YTS_API_BASE = 'https://movies-api.accel.li/api/v2';
const TORRENTIO_API = 'https://torrentio.strem.fun';
const MIN_SEEDS_MOVIE = 15;
const MIN_SEEDS_SERIES = 3;
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
  version: '2.0.0',
  name: 'MobiFlix',
  description: '1080p torrent magnet links — YTS (movies) + Torrentio (series).',
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

function is1080p(filename) {
  return /\b1080p\b|\bFHD\b/i.test(filename);
}

function parseSizeBytes(sizeStr) {
  if (!sizeStr) return 0;
  const m = String(sizeStr).match(/([0-9.]+)\s*([GMK]B?)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = (m[2] || 'GB').toUpperCase();
  if (unit.startsWith('T')) return Math.floor(val * 1099511627776);
  if (unit.startsWith('G')) return Math.floor(val * 1073741824);
  if (unit.startsWith('M')) return Math.floor(val * 1048576);
  if (unit.startsWith('K')) return Math.floor(val * 1024);
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
          sizeBytes: parseSizeBytes(t.size),
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

// ============ SOURCE: Torrentio (SERIES ONLY) ============
async function fetchTorrentio(type, imdbId, season, episode) {
  const debug = { source: 'Torrentio', url: '', count: 0, error: null, totalFetched: 0, reasonCount: {} };
  try {
    const id = season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
    const url = TORRENTIO_API + '/stream/' + type + '/' + id + '.json';
    debug.url = url;

    const data = await fetch(url, { headers: HEADERS }).then(r => r.json()).catch(() => null);
    if (!data?.streams || !Array.isArray(data.streams)) {
      debug.error = 'no streams array';
      return { items: [], debug };
    }
    debug.totalFetched = data.streams.length;

    const out = [];
    const reasonCount = { noFilename: 0, not1080p: 0, lowSeeds: 0, noHash: 0 };

    for (const s of data.streams) {
      // Torrentio returns: name, title, infoHash, fileIdx, behaviorHints.bingeGroup, sources
      const infoHash = s.infoHash || (s.url && s.url.match(/btih:([a-f0-9]{40})/i)?.[1]);
      if (!infoHash) { reasonCount.noHash++; continue; }

      // Extract filename/title from Torrentio's "title" field
      const filename = s.title || s.name || '';
      if (!filename) { reasonCount.noFilename++; continue; }

      // Check 1080p
      if (!is1080p(filename)) { reasonCount.not1080p++; continue; }

      // Extract seeders — Torrentio uses "seeders" field kung minsan, o nasa title
      let seeds = parseInt(s.seeders) || 0;
      if (!seeds) {
        // Try to extract from title (hal. "👤 123")
        const seedMatch = filename.match(/👤\s*(\d+)/);
        if (seedMatch) seeds = parseInt(seedMatch[1]) || 0;
      }
      if (seeds < MIN_SEEDS_SERIES) { reasonCount.lowSeeds++; continue; }

      // Extract size — Torrentio sometimes has "size" field, o nasa title (💾 1.23 GB)
      let sizeBytes = 0;
      if (s.size) sizeBytes = parseInt(s.size) || 0;
      if (!sizeBytes) {
        const sizeMatch = filename.match(/💾\s*([0-9.]+\s*[GMKT]B?)/i);
        if (sizeMatch) sizeBytes = parseSizeBytes(sizeMatch[1]);
      }

      // Build magnet — gamitin ang Torrentio sources kung meron
      let magnet;
      if (s.infoHash) {
        magnet = buildMagnet(s.infoHash, filename.replace(/^.*?\n/, '').trim());
      } else if (s.url && s.url.startsWith('magnet:')) {
        magnet = s.url;
      } else {
        magnet = buildMagnet(infoHash, filename);
      }

      // Extract clean filename from title (Torrentio includes emoji decorations)
      const cleanName = filename.replace(/[^\w\s.\-\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();

      out.push({
        source: 'Torrentio',
        hash: infoHash.toLowerCase(),
        filename: cleanName || filename,
        seeds,
        peers: 0,
        sizeBytes,
        magnet,
        bingeGroup: s.behaviorHints?.bingeGroup || null
      });
    }

    debug.reasonCount = reasonCount;
    debug.count = out.length;
    return { items: out, debug };
  } catch (e) {
    debug.error = e?.message || String(e);
    return { items: [], debug };
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

    // Source label — mas maikli para sa Torrentio
    const sourceLabel = item.source === 'Torrentio' ? 'Torrentio' : item.source;

    return {
      name: sourceLabel + ' | ' + QUALITY_LABEL.toUpperCase() + ' | 🌱 ' + item.seeds,
      title: description,
      description: description,
      url: item.magnet,
      behaviorHints: {
        bingeGroup: item.bingeGroup || ('nuvio-torrents-' + item.source + '-1080p')
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

  const allDebug = { type, id, imdbId, season, episode, sources: [] };

  // 🎬 MOVIES → YTS lang
  if (!isSeries) {
    const ytsResult = await fetchYTS(imdbId);
    allDebug.sources.push(ytsResult.debug);
    const streams = buildStreams(ytsResult.items, 'Movie', 'N/A', false, null, null);
    return { streams, _debug: allDebug };
  }

  // 📺 SERIES → Torrentio lang
  if (!season || !episode) {
    return { streams: [], _debug: { ...allDebug, error: 'missing season/episode' } };
  }

  const tioResult = await fetchTorrentio('series', imdbId, season, episode);
  allDebug.sources.push(tioResult.debug);
  const streams = buildStreams(tioResult.items, 'Series', 'N/A', true, season, episode);
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
