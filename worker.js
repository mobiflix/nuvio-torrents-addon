// ============================================================
// NUVIO TORRENTS — Cloudflare Worker Addon (v3.3.1)
// Movies: VIDY (direct) + YTS (1080p, min 15 seeds) + TPB (1080p, min 15 seeds)
// Series: VIDY (direct) + TPB only (S01E01, 1080p, min 15 seeds)
// Sorting: VIDY muna, tapos YTS, tapos TPB. Within each: seeds desc, size asc.
// ============================================================

const YTS_API_BASE = 'https://movies-api.accel.li/api/v2';
const TPB_API_BASE = 'https://apibay.org';
const TMDB_API_KEY = 'e0a7266a5d0e95c36475f349d8bc0a5a';
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Vidy constants
const VIDY_BASE_URL = 'https://www.vidy.st/';
const VIDY_API_BASE = 'https://api.wecollege.net';
const VIDY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const MIN_SEEDS_MOVIE = 15;
const MIN_SEEDS_SERIES = 15;
const QUALITY_LABEL = '1080p';

// Source priority: mas maliit = mauuna
const SOURCE_RANK = { VIDY: 0, YTS: 1, TPB: 2 };

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
  version: '3.3.1',
  name: 'MobiFlix',
  description: 'Vidy + YTS + The Pirate Bay — 1080p, minimum 15 seeders. Movies & series.',
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

// ============ TMDB ============
async function getTmdbInfo(imdbId, type) {
  const findUrl = TMDB_BASE + '/find/' + imdbId +
    '?api_key=' + TMDB_API_KEY + '&language=en-US&external_source=imdb_id';
  const data = await fetchJson(findUrl);
  if (type === 'tv') {
    const show = data?.tv_results?.[0];
    if (!show) return { title: '', year: '', tmdbId: null };
    return {
      title: show.name || '',
      year: (show.first_air_date || '').split('-')[0] || '',
      tmdbId: show.id || null
    };
  }
  const movie = data?.movie_results?.[0];
  if (!movie) return { title: '', year: '', tmdbId: null };
  return {
    title: movie.title || '',
    year: (movie.release_date || '').split('-')[0] || '',
    tmdbId: movie.id || null
  };
}

// ============ VIDY HELPERS (ported from vidy.js) ============
function vWithTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timerId); resolve(value); },
      (error) => { clearTimeout(timerId); reject(error); }
    );
  });
}

async function vFetchText(url, timeoutMs) {
  const response = await vWithTimeout(
    fetch(url, { headers: { 'User-Agent': VIDY_UA, 'Accept': '*/*' } }),
    timeoutMs
  );
  if (response.status !== 200) throw new Error('http_' + response.status);
  return vWithTimeout(response.text(), timeoutMs);
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:/.test(value);
}

function decodeBase64Url(encoded) {
  const lookup = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < alphabet.length; index++) {
    lookup[alphabet.charCodeAt(index)] = index;
  }
  lookup['-'.charCodeAt(0)] = 62;
  lookup['_'.charCodeAt(0)] = 63;

  const bytes = new Uint8Array(((encoded.length * 6) >> 3) + 1);
  let byteCount = 0;
  let bitCount = 0;
  let accumulator = 0;

  for (let index = 0; index < encoded.length; index++) {
    const charCode = encoded.charCodeAt(index);
    const sextet = charCode < 128 ? lookup[charCode] : -1;
    if (sextet < 0) continue;

    accumulator = ((accumulator << 6) | sextet) & 0xFFFFFF;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteCount++] = (accumulator >> bitCount) & 0xFF;
    }
  }
  return bytes.subarray(0, byteCount);
}

function multiplyUint32(a, b) {
  return Math.imul(a, b) >>> 0;
}

function rotateLeft32(value, shift) {
  const amount = shift & 31;
  if (amount === 0) return value >>> 0;
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function avalanche32(input) {
  let value = input >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = multiplyUint32(value, 0x85EBCA6B);
  value = (value ^ (value >>> 13)) >>> 0;
  value = multiplyUint32(value, 0xC2B2AE35);
  return (value ^ (value >>> 16)) >>> 0;
}

function hashFnv1a(text) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811C9DC5;
  for (let index = 0; index < bytes.length; index++) {
    hash = multiplyUint32((hash ^ bytes[index]) >>> 0, 0x01000193);
  }
  return avalanche32(hash);
}

function generateKeystream(seed, tmdbId, length) {
  const cells = new Uint32Array(61);
  const isCellInitialized = new Uint8Array(61);

  let seedState = avalanche32((hashFnv1a(seed) ^ avalanche32((tmdbId >>> 0) ^ 0x9E3779B9)) >>> 0);

  for (let round = 0; round < 8; round++) {
    const cellIndex = seedState % 61;
    const rotated = rotateLeft32((seedState + 0x9E3779B9) >>> 0, 7 + (7 & round));
    cells[cellIndex] = (rotated ^ avalanche32(rotated)) >>> 0;
    isCellInitialized[cellIndex] = 1;
    seedState = avalanche32((rotated + cellIndex) >>> 0);
  }

  let word = avalanche32(0xA5A5A5A5 ^ seedState);
  const keystream = new Uint8Array(length);
  let counter = 0;
  let offset = 0;

  while (offset < length) {
    const cellIndex = word % 61;
    const inner = (cells[cellIndex] ^ multiplyUint32(0x9E3779B9, counter + 1)) >>> 0;
    const initializedMask = isCellInitialized[cellIndex] ? -1 : 0;
    const combined = ((word ^ inner) | (word & inner & initializedMask)) >>> 0;
    const scrambled = (
      rotateLeft32((combined + word) >>> 0, 31 & cellIndex) ^
      rotateLeft32(word, 31 & ((cellIndex * 7) & 31))
    ) >>> 0;

    word = avalanche32((scrambled + 0x9E3779B9) >>> 0);
    cells[cellIndex] = word;
    isCellInitialized[cellIndex] = 1;

    keystream[offset++] = word & 0xFF;
    if (offset < length) keystream[offset++] = (word >>> 8) & 0xFF;
    if (offset < length) keystream[offset++] = (word >>> 16) & 0xFF;
    if (offset < length) keystream[offset++] = (word >>> 24) & 0xFF;
    counter++;
  }
  return keystream;
}

function hasPayloadMagic(bytes) {
  return [0x6D, 0x76, 0x6D, 0x31].every((expected, index) => bytes[index] === expected);
}

function decryptPayload(encodedCiphertext, seed, tmdbId) {
  const bytes = decodeBase64Url(encodedCiphertext);
  if (bytes.length < 4) throw new Error('payload too short');

  const keystream = generateKeystream(seed, tmdbId, bytes.length);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] ^= keystream[index];
  }
  if (!hasPayloadMagic(bytes)) throw new Error('bad seed or tampered payload');

  return new TextDecoder('utf-8').decode(bytes.subarray(4));
}

function parseHeight(rawQuality) {
  const match = /^(\d+)p?$/i.exec(String(rawQuality || '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

function normalizeSubtitles(rawSubtitles) {
  return (rawSubtitles || [])
    .slice(0, 40)
    .map((subtitle) => ({
      language: String(subtitle.label || subtitle.lang || subtitle.language || 'Subtitle'),
      url: subtitle.url || subtitle.file
    }))
    .filter((subtitle) => isHttpUrl(subtitle.url));
}

function collectWantedSources(rawSources) {
  const seenUrls = new Set();
  const wantedSources = [];
  for (const source of rawSources || []) {
    if (!source || !isHttpUrl(source.url) || seenUrls.has(source.url)) continue;
    const height = parseHeight(source.quality);
    if (height !== 1080) continue;
    seenUrls.add(source.url);
    wantedSources.push({ url: source.url, height });
  }
  return wantedSources;
}

async function fetchVidySeed(tmdbId) {
  const body = await vFetchText(VIDY_API_BASE + '/seed?mediaId=' + tmdbId, 8000);
  const { seed } = JSON.parse(body);
  if (!seed) throw new Error('empty_seed');
  return seed;
}

function buildVidySourcesUrl(region, mediaType, tmdbId, seed, season, episode) {
  let query = 'mediaType=' + mediaType + '&tmdbId=' + tmdbId + '&enc=2&seed=' + encodeURIComponent(seed);
  if (mediaType === 'tv') query += '&seasonId=' + season + '&episodeId=' + episode;
  return VIDY_API_BASE + '/' + region + '/sources?' + query;
}

// ============ SOURCE: VIDY (MOVIES + SERIES) ============
async function fetchVidy(tmdbId, mediaType, season, episode, tmdbInfo) {
  const debug = { source: 'VIDY', tmdbId, mediaType, regions: [], count: 0, error: null };
  try {
    if (!tmdbId) {
      debug.error = 'no tmdb id';
      return { items: [], debug };
    }
    if (mediaType === 'tv' && (season == null || episode == null)) {
      debug.error = 'missing season/episode';
      return { items: [], debug };
    }

    const title = tmdbInfo?.title || '';
    const year = tmdbInfo?.year || '';
    const regions = ['miami', 'boise'];
    const out = [];
    const seen = new Set();

    for (const region of regions) {
      const regionDebug = { region, status: 'pending', sourcesFound: 0, wanted1080p: 0, error: null };
      try {
        const seed = await fetchVidySeed(tmdbId);
        const url = buildVidySourcesUrl(region, mediaType, tmdbId, seed, season, episode);
        const encryptedBody = await vFetchText(url, 12000);
        
        let payload;
        try {
          payload = JSON.parse(decryptPayload(encryptedBody, seed, tmdbId));
        } catch (decErr) {
          regionDebug.error = 'decrypt failed: ' + decErr.message;
          debug.regions.push(regionDebug);
          continue;
        }

        regionDebug.status = 'decrypted';
        regionDebug.sourcesFound = (payload.sources || []).length;

        const sources = collectWantedSources(payload.sources || []);
        regionDebug.wanted1080p = sources.length;
        const subtitles = normalizeSubtitles(payload.subtitles || []);
        const providerName = region.toUpperCase();

        sources.forEach(({ url: srcUrl, height }, index) => {
          if (seen.has(srcUrl)) return;
          seen.add(srcUrl);

          const fakeSeeders = 100 + ((index * 13) % 800);
          const sizeBytes = Math.floor((1.2 + (index * 0.4)) * 1073741824);
          const displayTitle = title ? (year ? title + ' (' + year + ')' : title) : providerName;

          out.push({
            source: 'VIDY',
            sourceRank: SOURCE_RANK.VIDY,
            hash: null,
            directUrl: srcUrl,
            filename: displayTitle + ' ' + height + 'p',
            displayTitle,
            seeds: fakeSeeders,
            peers: 0,
            sizeBytes,
            magnet: null,
            headers: { 'User-Agent': VIDY_UA, 'Referer': VIDY_BASE_URL },
            subtitles
          });
        });
      } catch (e) {
        regionDebug.error = e?.message || String(e);
      }
      debug.regions.push(regionDebug);
    }

    debug.count = out.length;
    return { items: out, debug };
  } catch (e) {
    debug.error = e?.message || String(e);
    return { items: [], debug };
  }
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
          sourceRank: SOURCE_RANK.YTS,
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

// ============ SOURCE: TPB (MOVIES + SERIES) ============
async function fetchTPB(imdbId, mediaType, season, episode, preInfo) {
  const debug = { source: 'TPB', mediaType, url: '', count: 0, error: null };
  try {
    const info = preInfo || await getTmdbInfo(imdbId, mediaType).catch(() => ({ title: '', year: '' }));
    if (!info.title) {
      debug.error = 'no tmdb title';
      return { items: [], debug };
    }

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
        sourceRank: SOURCE_RANK.TPB,
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
    const dedupeKey = item.hash || item.directUrl;
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(item);
  }
  if (!unique.length) return [];

  unique.sort((a, b) =>
    (a.sourceRank - b.sourceRank) ||
    (b.seeds - a.seeds) ||
    (a.sizeBytes - b.sizeBytes)
  );

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

    const srcEmoji = item.source === 'TPB' ? '☠️' : item.source === 'VIDY' ? '📡' : '🎬';
    const titleLine = srcEmoji + ' ' + item.filename;
    const qualityLine = '🔥 ' + QUALITY_LABEL + (extras.length ? ' | ' + extras.join(' | ') : '');
    const statsLine = '🌱 ' + item.seeds + ' | 💾 ' + sizeGB + ' GB | 🔗 ' + item.source;
    const description = titleLine + '\n' + qualityLine + '\n' + statsLine;

    const stream = {
      name: item.source + ' | ' + QUALITY_LABEL.toUpperCase() + ' | 🌱 ' + item.seeds,
      title: description,
      description: description,
      url: item.directUrl || item.magnet,
      behaviorHints: {
        bingeGroup: 'nuvio-torrents-' + item.source + '-1080p'
      }
    };

    if (item.headers) stream.headers = item.headers;
    if (item.subtitles?.length) stream.subtitles = item.subtitles;

    return stream;
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

  const tmdbInfo = await getTmdbInfo(imdbId, mediaType)
    .catch(() => ({ title: '', year: '', tmdbId: null }));

  const tasks = [
    fetchVidy(tmdbInfo.tmdbId, mediaType, season, episode, tmdbInfo),
    fetchTPB(imdbId, mediaType, season, episode, tmdbInfo)
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
