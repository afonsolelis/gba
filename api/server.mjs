// gba-api: login por PIN e ponte entre o site (GitHub Pages) e o bucket `gba`
// do RustFS. Só a biblioteca padrão do Node (>= 22): sem npm install.
//
// Layout do bucket:
//   roms/<id>.<gba|gb|gbc>                  ROMs
//   saves/<id>.sav                          SRAM (save do jogo), sincronizado sozinho
//   saves-history/<id>/<iso>.sav            cópia de segurança, no máximo 1 a cada 15 min
//   states/<id>.state + states/<id>.png     savestate manual + print da tela
//
// Variáveis: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION,
// PIN_SCRYPT ("<salt hex>:<hash hex>"), SESSION_SECRET, ALLOWED_ORIGINS (vírgula).
//
// Sessão: o login devolve um token assinado (HMAC) que o site manda em
// `Authorization: Bearer`. Não dá para usar cookie: o site fica em github.io e a
// API em afonsolelis.tech, e os navegadores bloqueiam cookie entre sites diferentes.

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const env = process.env;
const PORT = Number(env.PORT || 8080);
const S3 = new URL(env.S3_ENDPOINT || 'https://s3.afonsolelis.tech');
const BUCKET = env.S3_BUCKET || 'gba';
const REGION = env.S3_REGION || 'us-east-1';
const AK = env.S3_ACCESS_KEY;
const SK = env.S3_SECRET_KEY;
const SESSION_SECRET = env.SESSION_SECRET;
const [PIN_SALT, PIN_HASH] = (env.PIN_SCRYPT || ':').split(':');
const ORIGINS = new Set((env.ALLOWED_ORIGINS || 'https://afonsolelis.github.io').split(',').map(s => s.trim()));
const SESSION_DAYS = 30;

for (const [k, v] of Object.entries({ S3_ACCESS_KEY: AK, S3_SECRET_KEY: SK, SESSION_SECRET, PIN_SCRYPT: PIN_HASH })) {
  if (!v) { console.error(`faltando ${k}`); process.exit(1); }
}

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ROM = /^([a-z0-9][a-z0-9-]{0,79})\.(gba|gb|gbc)$/;
const LIMITS = { rom: 64 << 20, save: 1 << 20, state: 8 << 20, shot: 1 << 20 };

// ---------------------------------------------------------------- S3 (SigV4)

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function s3(method, key = '', { query = {}, body, contentType } = {}) {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const path = '/' + BUCKET + (key ? '/' + key.split('/').map(enc).join('/') : '');
  const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const payloadHash = sha256(body || '');
  const headers = { host: S3.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).sort();
  const canonical = [method, path, qs, names.map(n => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + SK, day), REGION), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(kSign, toSign).toString('hex')}`;
  delete headers.host;
  // Sem isso o Traefik responde em gzip e o content-length deixa de bater com o corpo.
  headers['accept-encoding'] = 'identity';
  return fetch(`${S3.origin}${path}${qs ? '?' + qs : ''}`, { method, headers, body });
}

async function list(prefix) {
  const out = [];
  let token;
  do {
    const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await s3('GET', '', { query });
    if (!res.ok) throw new Error(`list ${prefix}: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (t) => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
      out.push({ key: tag('Key'), size: Number(tag('Size')), modified: tag('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]*)</) || [])[1] : null;
  } while (token);
  return out;
}

// ---------------------------------------------------------------- sessão e PIN

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${hmac(SESSION_SECRET, payload).toString('base64url')}`;
}

function validSession(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return false;
  const want = hmac(SESSION_SECRET, payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url')).exp > Date.now(); } catch { return false; }
}

function pinOk(pin) {
  if (typeof pin !== 'string' || pin.length > 64) return false;
  const got = crypto.scryptSync(pin, Buffer.from(PIN_SALT, 'hex'), 32);
  const want = Buffer.from(PIN_HASH, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// PIN curto = força bruta barata. Por IP: 5 erros → 15 min bloqueado.
// Global: 20 erros em 1 h → login fechado por 1 h para todo mundo.
const fails = new Map();
let globalFails = [];
let globalLockUntil = 0;

function clientIp(req) {
  // O Traefik acrescenta o IP real no fim do X-Forwarded-For; o começo pode ser forjado.
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket.remoteAddress;
}

function lockedFor(ip) {
  const now = Date.now();
  if (globalLockUntil > now) return globalLockUntil - now;
  const f = fails.get(ip);
  return f && f.until > now ? f.until - now : 0;
}

function registerFail(ip) {
  const now = Date.now();
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = now + 15 * 60e3; f.count = 0; }
  fails.set(ip, f);
  globalFails = globalFails.filter(t => t > now - 3600e3).concat(now);
  if (globalFails.length >= 20) { globalLockUntil = now + 3600e3; globalFails = []; console.warn('login global bloqueado por 1 h'); }
}

// ---------------------------------------------------------------- HTTP

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string';
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limit) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > limit) throw Object.assign(new Error('grande demais'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('grande demais'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function proxyGet(res, key, type, cache) {
  const r = await s3('GET', key);
  if (r.status === 404) return send(res, 404, 'não existe');
  if (!r.ok) throw new Error(`get ${key}: ${r.status}`);
  res.writeHead(200, {
    'content-type': type,
    'content-length': r.headers.get('content-length'),
    'last-modified': r.headers.get('last-modified') || '',
    'cache-control': cache,
  });
  Readable.fromWeb(r.body).pipe(res);
}

async function put(key, body, type = 'application/octet-stream') {
  const r = await s3('PUT', key, { body, contentType: type });
  if (!r.ok) throw new Error(`put ${key}: ${r.status} ${await r.text()}`);
}

const lastHistory = new Map();

const routes = {
  'GET /health': async (req, res) => send(res, 200, { ok: true }),

  'POST /login': async (req, res) => {
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait) return send(res, 429, { erro: 'bloqueado', segundos: Math.ceil(wait / 1000) });
    let pin;
    try { pin = JSON.parse(await readBody(req, 1024)).pin; } catch { return send(res, 400, { erro: 'json' }); }
    if (!pinOk(String(pin ?? ''))) {
      registerFail(ip);
      await new Promise(r => setTimeout(r, 800));
      return send(res, 401, { erro: 'pin' });
    }
    fails.delete(ip);
    send(res, 200, { ok: true, token: makeSession(), dias: SESSION_DAYS });
  },

  'GET /me': async (req, res) => send(res, 200, { ok: true }),

  'GET /games': async (req, res) => {
    const [roms, saves, states] = await Promise.all([list('roms/'), list('saves/'), list('states/')]);
    const byKey = (arr) => Object.fromEntries(arr.map(o => [o.key, o]));
    const s = byKey(saves), st = byKey(states);
    const games = roms.map(o => {
      const m = o.key.slice(5).match(ROM);
      if (!m) return null;
      const [, id, ext] = m;
      const save = s[`saves/${id}.sav`], state = st[`states/${id}.state`], shot = st[`states/${id}.png`];
      return {
        id, ext, file: `${id}.${ext}`, size: o.size, modified: o.modified,
        save: save ? { size: save.size, modified: save.modified } : null,
        state: state ? { modified: state.modified } : null,
        shot: shot ? shot.modified : null,
      };
    }).filter(Boolean);
    send(res, 200, { games });
  },

  'GET /rom': async (req, res, arg) => {
    if (!ROM.test(arg)) return send(res, 400, 'nome inválido');
    await proxyGet(res, `roms/${arg}`, 'application/octet-stream', 'private, max-age=604800');
  },
  'PUT /rom': async (req, res, arg) => {
    if (!ROM.test(arg)) return send(res, 400, 'nome inválido (use letras minúsculas, números e hífen; .gba/.gb/.gbc)');
    await put(`roms/${arg}`, await readBody(req, LIMITS.rom));
    send(res, 200, { ok: true });
  },

  'GET /save': async (req, res, id) => {
    if (!ID.test(id)) return send(res, 400, 'id inválido');
    await proxyGet(res, `saves/${id}.sav`, 'application/octet-stream', 'no-store');
  },
  'PUT /save': async (req, res, id) => {
    if (!ID.test(id)) return send(res, 400, 'id inválido');
    const body = await readBody(req, LIMITS.save);
    if (!body.length) return send(res, 400, 'vazio');
    await put(`saves/${id}.sav`, body);
    const now = Date.now();
    if ((lastHistory.get(id) || 0) < now - 15 * 60e3) {
      lastHistory.set(id, now);
      await put(`saves-history/${id}/${new Date(now).toISOString().replace(/[:.]/g, '-')}.sav`, body);
    }
    send(res, 200, { ok: true, modified: new Date(now).toISOString() });
  },

  'GET /state': async (req, res, id) => {
    if (!ID.test(id)) return send(res, 400, 'id inválido');
    await proxyGet(res, `states/${id}.state`, 'application/octet-stream', 'no-store');
  },
  'PUT /state': async (req, res, id) => {
    if (!ID.test(id)) return send(res, 400, 'id inválido');
    const body = await readBody(req, LIMITS.state);
    if (!body.length) return send(res, 400, 'vazio');
    await put(`states/${id}.state`, body);
    send(res, 200, { ok: true });
  },

  'GET /shot': async (req, res, id) => {
    if (!ID.test(id)) return send(res, 400, 'id inválido');
    await proxyGet(res, `states/${id}.png`, 'image/png', 'no-cache');
  },
  'PUT /shot': async (req, res, id) => {
    if (!ID.test(id)) return send(res, 400, 'id inválido');
    await put(`states/${id}.png`, await readBody(req, LIMITS.shot), 'image/png');
    send(res, 200, { ok: true });
  },
};

const PUBLIC = new Set(['GET /health', 'POST /login']);

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (!origin || !ORIGINS.has(origin)) return send(res, 403, 'origem');
    return send(res, 204, '', {
      'access-control-allow-methods': 'GET, PUT, POST',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
  }
  // Pedido de navegador vindo de outra origem: recusa.
  if (origin && !ORIGINS.has(origin)) return send(res, 403, 'origem');

  const url = new URL(req.url, 'http://x');
  const [, first = '', arg = ''] = url.pathname.split('/');
  const route = `${req.method} /${first}`;
  const handler = routes[route];
  if (!handler) return send(res, 404, 'rota');
  if (!PUBLIC.has(route) && !validSession(req)) return send(res, 401, { erro: 'login' });
  try {
    await handler(req, res, decodeURIComponent(arg));
  } catch (e) {
    console.error(route, arg, e.message);
    if (!res.headersSent) send(res, e.status || 502, { erro: e.status ? e.message : 'lake indisponível' });
    else res.destroy();
  }
}).listen(PORT, () => console.log(`gba-api na porta ${PORT}, bucket ${BUCKET} em ${S3.origin}`));
