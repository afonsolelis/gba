// Front do GBA: login por PIN, biblioteca e o emulador (EmulatorJS + mGBA).
// Tudo que é seu (ROMs, saves, savestates) fica no bucket `gba` do RustFS,
// atrás da gba-api; este site é estático e público.

const API = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? `http://${location.hostname}:8787`
  : 'https://gba-api.afonsolelis.tech';
const EJS_DATA = 'https://cdn.emulatorjs.org/4.2.3/data/';
const PIN_LEN = 6;
const SAVE_EVERY_MS = 10_000;
// Velocidades do botão (o EmulatorJS aceita ff-ratio até 10.0); no teclado, 1–9 e 0 = 10x.
const SPEEDS = [1, 2, 3, 4, 5, 10];

// ---- Multiplicador de EXP (Pokémon de GBA)
// Patch na ROM, aplicado na memória ao abrir o jogo (a ROM no lake não muda).
// Em Cmd_getexp a EXP base é `expYield * level / 7` (movs r1,#7; bl __divsi3).
// O bl passa a chamar uma "caverna" escrita sobre uma função de debug que o jogo
// nunca chama (Debug_PrintStatus / UnusedPrintDecimalNum, endereços do pret):
//   r0 = min(expYield * level * M / 7, 9700)
// O teto existe porque o controlador da batalha trata a EXP como s16: 9700 × 1,5³
// (troca, treinador, Lucky Egg) = 32737 < 32767. Antes de aplicar, confere os bytes
// originais dos dois trechos; se não baterem (outra versão/hack), não aplica.
// Gerado e testado (Unicorn, com o __divsi3 da própria ROM) por tools/exp_patch.py.
const EXP_PATCHES = {
  BPEE: { // Emerald
    site: 0x04a4ae, siteOrig: '9df247f8', sitePatch: 'c7f7f5fe',
    cave: 0x01229c, litM: 0x0122b4,
    caveOrig: 'f0b5474680b4f8f755f90006000e1c2113220223fcf7a6f92d4c206880781421',
    cavePatch: '00b5054a5043d5f24df90449884200d9084602bc084700bfe8030000e4250000' },
  BPRE: { // FireRed (e hacks com os mesmos bytes)
    site: 0x021bea, siteOrig: 'c2f115fa', sitePatch: 'daf01dfb',
    cave: 0x0fc228, litM: 0x0fc240,
    caveOrig: 'f0b5474680b40ef75df90006000e1c2113220223fcf7daf92d4c206880781421',
    cavePatch: '00b5054a5043e7f0f3fe0449884200d9084602bc084700bfe8030000e4250000' },
  BPGE: { // LeafGreen
    site: 0x021bea, siteOrig: 'c2f103fa', sitePatch: 'daf009fb',
    cave: 0x0fc200, litM: 0x0fc218,
    caveOrig: 'f0b5474680b40ef771f90006000e1c2113220223fcf7daf92d4c206880781421',
    cavePatch: '00b5054a5043e7f0f5fe0449884200d9084602bc084700bfe8030000e4250000' },
  AXVE: { // Ruby
    site: 0x020192, siteOrig: 'c0f169fb', sitePatch: '71f007f9',
    cave: 0x0913a4, litM: 0x0913bc,
    caveOrig: 'f0b582b00004040c09060f0e1206160e0025fa218900201c4ff168fd0006000e',
    cavePatch: '00b5054a50434ff15dfa0449884200d9084602bc084700bfe8030000e4250000' },
  AXPE: { // Sapphire
    site: 0x020192, siteOrig: 'c0f131fb', sitePatch: '71f007f9',
    cave: 0x0913a4, litM: 0x0913bc,
    caveOrig: 'f0b582b00004040c09060f0e1206160e0025fa218900201c4ff130fd0006000e',
    cavePatch: '00b5054a50434ff125fa0449884200d9084602bc084700bfe8030000e4250000' },
};
const EXP_OPTIONS = [1, 10, 100, 1000];
const expKey = (id) => `gba-exp-${id}`;
const getExpMult = (id) => { try { return Number(localStorage.getItem(expKey(id))) || 1; } catch { return 1; } };
const setExpMult = (id, n) => { try { n > 1 ? localStorage.setItem(expKey(id), String(n)) : localStorage.removeItem(expKey(id)); } catch { /* sem storage */ } };

const hexBytes = (h) => Uint8Array.from(h.match(/../g), b => parseInt(b, 16));
const sameBytes = (rom, off, hex) => hexBytes(hex).every((b, i) => rom[off + i] === b);

// Devolve { rom, available }: available = o patch serve para esta ROM.
async function applyExpPatch(blob, mult) {
  const rom = new Uint8Array(await blob.arrayBuffer());
  const code = String.fromCharCode(...rom.subarray(0xac, 0xb0));
  const p = EXP_PATCHES[code];
  const available = !!p && sameBytes(rom, p.site, p.siteOrig) && sameBytes(rom, p.cave, p.caveOrig);
  if (!available || mult <= 1) return { rom: blob, available };
  rom.set(hexBytes(p.sitePatch), p.site);
  rom.set(hexBytes(p.cavePatch), p.cave);
  new DataView(rom.buffer).setUint32(p.litM, mult, true);
  return { rom: new Blob([rom]), available };
}

// Nome, prateleira e cor de cada jogo (o resto cai em "Outros" com nome gerado do arquivo).
const META = {
  'pokemon-ruby':                  ['Pokémon Ruby', 'poke-gba', '#b8302a'],
  'pokemon-sapphire':              ['Pokémon Sapphire', 'poke-gba', '#2554b8'],
  'pokemon-emerald':               ['Pokémon Emerald', 'poke-gba', '#16865a'],
  'pokemon-firered':               ['Pokémon FireRed', 'poke-gba', '#d9542b'],
  'pokemon-leafgreen':             ['Pokémon LeafGreen', 'poke-gba', '#4d9e2f'],
  'pokemon-pinball-ruby-sapphire': ['Pokémon Pinball: Ruby & Sapphire', 'poke-gba', '#7a3db0'],
  'pokemon-chaos-black':           ['Pokémon Chaos Black (hack)', 'poke-gba', '#2b2b33'],
  'zelda-the-minish-cap':          ['Zelda: The Minish Cap', 'zelda', '#2d7d4a'],
  'zelda-a-link-to-the-past':      ['Zelda: A Link to the Past & Four Swords', 'zelda', '#a77a22'],
  'pokemon-red':                   ['Pokémon Red', 'poke-gb', '#c8352b'],
  'pokemon-blue':                  ['Pokémon Blue', 'poke-gb', '#3462c9'],
  'pokemon-green':                 ['Pokémon Green', 'poke-gb', '#3b8f4a'],
  'pokemon-yellow':                ['Pokémon Yellow', 'poke-gb', '#d9a514'],
  'pokemon-gold':                  ['Pokémon Gold', 'poke-gb', '#b48d1e'],
  'pokemon-silver':                ['Pokémon Silver', 'poke-gb', '#7f8a96'],
  'pokemon-crystal':               ['Pokémon Crystal', 'poke-gb', '#3a9cb3'],
  // 4º campo (opcional): nome curto na capa
  'castlevania-circle-of-the-moon':    ['Castlevania: Circle of the Moon', 'castlevania', '#5b1a2e', 'Circle of the Moon'],
  'castlevania-harmony-of-dissonance': ['Castlevania: Harmony of Dissonance', 'castlevania', '#3b2a6b', 'Harmony of Dissonance'],
  'castlevania-aria-of-sorrow':        ['Castlevania: Aria of Sorrow', 'castlevania', '#7a1f1f', 'Aria of Sorrow'],
  'final-fantasy-1-2-dawn-of-souls':   ['Final Fantasy I & II: Dawn of Souls', 'ff', '#1d4f8f', 'I & II'],
  'final-fantasy-4':                   ['Final Fantasy IV', 'ff', '#2b3f73', 'IV'],
  'final-fantasy-tactics-advance':     ['Final Fantasy Tactics Advance', 'ff', '#8a5a1c', 'Tactics Advance'],
  'sonic-advance':                     ['Sonic Advance', 'sonic', '#1f5fd1', 'Sonic Advance'],
  'sonic-advance-3':                   ['Sonic Advance 3', 'sonic', '#1747a6', 'Sonic Advance 3'],
  'teenage-mutant-ninja-turtles':      ['Teenage Mutant Ninja Turtles', 'acao', '#2f7d32', 'TMNT'],
};
const SHELVES = [
  ['poke-gba', 'Pokémon · Game Boy Advance'],
  ['zelda', 'Zelda · Game Boy Advance'],
  ['poke-gb', 'Pokémon · Game Boy / Color'],
  ['castlevania', 'Castlevania · Game Boy Advance'],
  ['ff', 'Final Fantasy · Game Boy Advance'],
  ['sonic', 'Sonic · Game Boy Advance'],
  ['acao', 'Ação · Game Boy Advance'],
  ['outros', 'Outros'],
];
const SYS = { gba: 'GBA', gb: 'GB', gbc: 'GBC' };

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};

function meta(id) {
  if (META[id]) return { name: META[id][0], shelf: META[id][1], color: META[id][2], short: META[id][3] };
  const name = id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { name, shelf: 'outros', color: `hsl(${h} 45% 38%)` };
}

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `há ${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

// Token da sessão (30 dias). Vai no header Authorization: o site (github.io) e a API
// (afonsolelis.tech) são sites diferentes, e cookie entre sites é bloqueado.
const TOKEN_KEY = 'gba-token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* modo privado */ } };

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401 && !path.startsWith('/login')) {
    setToken('');
    throw Object.assign(new Error('login'), { login: true });
  }
  return res;
}

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== view;
}

// ------------------------------------------------------------------ login

function askPin() {
  show('login');
  return new Promise((resolve) => {
    let pin = '';
    let busy = false;
    const dots = $('#dots');
    const msg = $('#login-msg');
    const pad = $('#keypad');
    dots.replaceChildren(...Array.from({ length: PIN_LEN }, () => el('span')));
    const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < pin.length));

    const submit = async () => {
      busy = true;
      msg.className = 'hint'; msg.textContent = 'Entrando…';
      try {
        const r = await api('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
        if (r.ok) { setToken((await r.json()).token); cleanup(); return resolve(); }
        const j = await r.json().catch(() => ({}));
        msg.className = 'hint err';
        msg.textContent = r.status === 429 ? `Muitas tentativas. Espere ${Math.ceil((j.segundos || 900) / 60)} min.` : 'PIN errado';
        dots.classList.add('shake'); setTimeout(() => dots.classList.remove('shake'), 400);
      } catch {
        msg.className = 'hint err'; msg.textContent = 'Sem conexão com o servidor';
      }
      pin = ''; paint(); busy = false;
    };
    const press = (k) => {
      if (busy) return;
      if (k === '⌫') pin = pin.slice(0, -1);
      else if (/^\d$/.test(k) && pin.length < PIN_LEN) pin += k;
      paint();
      if (pin.length === PIN_LEN) submit();
    };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    pad.replaceChildren(...keys.map(k => k
      ? el('button', { type: 'button', textContent: k, className: k === '⌫' ? 'fn' : '', onclick: () => press(k) })
      : el('span')));
    const onKey = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('⌫'); };
    const cleanup = () => removeEventListener('keydown', onKey);
    addEventListener('keydown', onKey);
    msg.className = 'hint'; msg.textContent = 'Digite o PIN';
    paint();
  });
}

async function ensureLogin() {
  if (getToken()) {
    try {
      const r = await api('/me');
      if (r.ok) return;
    } catch (e) {
      if (!e.login) throw e;
    }
  }
  await askPin();
}

// ------------------------------------------------------------------ biblioteca

async function library() {
  show('library');
  const status = $('#lib-status');
  status.textContent = 'Carregando…';
  let games;
  try {
    games = (await (await api('/games')).json()).games;
  } catch (e) {
    if (e.login) { await askPin(); return library(); }
    status.textContent = 'Não consegui falar com o servidor.';
    return;
  }
  status.textContent = '';
  const shelves = $('#shelves');
  shelves.replaceChildren();
  for (const [key, title] of SHELVES) {
    const list = games.filter(g => meta(g.id).shelf === key)
      .sort((a, b) => (b.save?.modified || '').localeCompare(a.save?.modified || '') || meta(a.id).name.localeCompare(meta(b.id).name));
    if (!list.length) continue;
    shelves.append(el('section', { className: 'shelf' },
      el('h2', { textContent: title }),
      el('div', { className: 'grid' }, ...list.map(card))));
  }
  if (!games.length) status.textContent = 'Nenhuma ROM ainda. Use “+ ROM”.';
}

function card(g) {
  const m = meta(g.id);
  const short = m.short || m.name.replace(/^Pokémon (Pinball: )?|^Zelda: /, (x, p) => p ? 'Pinball ' : '').replace(/ & Four Swords| \(hack\)/, '');
  const cover = el('div', { className: 'cover' }, el('span', { className: 'sys', textContent: SYS[g.ext] }));
  cover.style.setProperty('--c', m.color);
  if (g.shot) {
    // <img> não manda o header Authorization: busca a capa com fetch e usa um blob.
    const img = el('img', { alt: '' });
    const fallback = () => img.replaceWith(el('span', { className: 'mono', textContent: short }));
    api(`/shot/${g.id}?v=${encodeURIComponent(g.shot)}`)
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(b => { img.src = URL.createObjectURL(b); })
      .catch(fallback);
    cover.append(img);
  } else {
    cover.append(el('span', { className: 'mono', textContent: short }));
  }
  const last = [g.save?.modified, g.state?.modified].filter(Boolean).sort().at(-1);
  const href = `?jogo=${encodeURIComponent(g.file)}&v=${encodeURIComponent(g.modified || g.size)}`;
  return el('a', { className: 'card', href },
    cover,
    el('div', { className: 'meta' },
      el('div', { className: 'name', textContent: m.name }),
      el('div', { className: 'save' + (last ? ' has' : ''), textContent: last ? `● salvo ${ago(last)}` : 'sem save' })));
}

$('#logout').onclick = () => {
  setToken('');
  location.href = './';
};

$('#upload').onchange = async (e) => {
  const status = $('#lib-status');
  for (const f of e.target.files) {
    const m = f.name.toLowerCase().match(/^(.*)\.(gba|gb|gbc)$/);
    if (!m) { status.textContent = `${f.name}: só .gba, .gb ou .gbc`; continue; }
    const id = m[1].normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'rom';
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${API}/rom/${id}.${m[2]}`);
      xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
      xhr.upload.onprogress = (p) => { status.textContent = `Enviando ${f.name}… ${Math.round(100 * p.loaded / p.total)}%`; };
      xhr.onload = () => { status.textContent = xhr.status === 200 ? `${f.name} enviado.` : `${f.name}: erro ${xhr.status}`; resolve(); };
      xhr.onerror = () => { status.textContent = `${f.name}: falhou`; resolve(); };
      xhr.send(f);
    });
  }
  e.target.value = '';
  library();
};

// ------------------------------------------------------------------ jogo

const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

function setSync(text, cls = '') {
  const p = $('#sync');
  p.textContent = text;
  p.className = 'pill ' + cls;
}

async function fetchRom(file, version) {
  const url = `${API}/rom/${file}?v=${encodeURIComponent(version)}`;
  let cache;
  try { cache = await caches.open('gba-roms-v1'); } catch { /* sem Cache API */ }
  const hit = cache && await cache.match(url);
  if (hit) return hit.blob();

  const res = await api(`/rom/${file}?v=${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`ROM: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) $('#progress').style.width = `${(100 * got / total).toFixed(1)}%`;
    $('#loading-msg').textContent = `Baixando ROM… ${(got / 2 ** 20).toFixed(1)} MB`;
  }
  const blob = new Blob(parts);
  if (cache) {
    // Uma versão por jogo: tira as antigas antes de guardar a nova.
    for (const k of await cache.keys()) if (k.url.includes(`/rom/${file}?`)) await cache.delete(k);
    await cache.put(url, new Response(blob)).catch(() => {});
  }
  return blob;
}

async function play(file, version) {
  const m0 = file.match(/^([a-z0-9-]+)\.(gba|gb|gbc)$/);
  if (!m0) { location.href = './'; return; }
  const [, id, ext] = m0;
  const m = meta(id);
  document.title = m.name;
  show('play');
  $('#play-title').textContent = m.name;
  setSync('…');

  let rom;
  try {
    rom = await fetchRom(file, version);
  } catch (e) {
    if (e.login) { await askPin(); show('play'); return play(file, version); }
    $('#loading-msg').textContent = 'Não consegui baixar a ROM.';
    return;
  }
  // ---- multiplicador de EXP (só nos Pokémon de GBA onde o patch confere)
  const expMult = getExpMult(id);
  const patched = await applyExpPatch(rom, expMult);
  rom = patched.rom;
  const expSel = $('#exp');
  if (patched.available) {
    expSel.replaceChildren(...EXP_OPTIONS.map(n => el('option', { value: n, textContent: `EXP ${n}x`, selected: n === expMult })));
    expSel.classList.toggle('fast', expMult > 1);
    expSel.hidden = false;
    expSel.onchange = async () => {
      // O patch entra quando a ROM carrega: salva no lake e reabre o jogo.
      expSel.disabled = true;
      setExpMult(id, Number(expSel.value));
      await pushSave();
      location.reload();
    };
  }

  $('#loading-msg').textContent = 'Iniciando emulador…';
  $('#progress').style.width = '100%';

  // ---- sincronização do save (SRAM) com o lake
  let lastHash = null;
  let uploading = false;
  let started = false;
  // Só envia depois de ler o save do lake: se a leitura falhar (rede), um save
  // vazio do navegador não pode sobrescrever o seu progresso lá.
  let pulled = false;

  const gm = () => window.EJS_emulator?.gameManager;

  async function pullSave() {
    const r = await api(`/save/${id}`);
    if (r.status === 404) { pulled = true; setSync('sem save no lake', ''); return; }
    if (!r.ok) throw new Error(`save ${r.status}`);
    const data = new Uint8Array(await r.arrayBuffer());
    lastHash = await hex(data);
    const g = gm();
    const local = g.getSaveFile(false);
    pulled = true;
    if (local && await hex(local) === lastHash) { setSync('☁ save em dia', 'ok'); return; }
    // Mesmo esquema do botão "carregar save" do EmulatorJS, depois reinicia
    // para o jogo ler o save novo desde o boot.
    const path = g.getSaveFilePath();
    let cur = '';
    for (const part of path.split('/').slice(0, -1)) {
      if (!part) continue;
      cur += '/' + part;
      if (!g.FS.analyzePath(cur).exists) g.FS.mkdir(cur);
    }
    if (g.FS.analyzePath(path).exists) g.FS.unlink(path);
    g.FS.writeFile(path, data);
    g.loadSaveFiles();
    g.restart();
    setSync('☁ save carregado', 'ok');
  }

  async function pushSave() {
    const g = gm();
    if (!started || !pulled || !g || uploading) return;
    uploading = true;
    try {
      g.saveSaveFiles();
      const data = g.getSaveFile(false);
      if (!data || !data.length) return;
      const h = await hex(data);
      if (h === lastHash) return;
      setSync('☁ salvando…', 'busy');
      const r = await api(`/save/${id}`, { method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } });
      if (!r.ok) throw new Error(r.status);
      lastHash = h;
      setSync(`☁ salvo ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    } catch (e) {
      setSync(e.login ? 'faça login de novo' : '⚠ save não enviado', 'err');
    } finally {
      uploading = false;
    }
  }

  // ---- EmulatorJS
  Object.assign(window, {
    EJS_player: '#game',
    EJS_core: ext === 'gba' ? 'gba' : 'gb',
    EJS_gameUrl: URL.createObjectURL(rom),
    EJS_gameName: id,
    EJS_pathtodata: EJS_DATA,
    EJS_startOnLoaded: true,
    EJS_color: '#8b7cff',
    EJS_backgroundColor: '#14121f',
    EJS_language: 'pt-BR',
    EJS_disableDatabases: true,
    // Teclado padrão do EmulatorJS, sem os atalhos 1/2/3 (quick save/quick load/slot):
    // eles gravam só no navegador e brigavam com as teclas 0–9 da velocidade
    // (apertar 2 para 2x carregava um estado antigo).
    EJS_defaultControls: {
      0: {
        0: { value: 'x', value2: 'BUTTON_2' },        // B
        1: { value: 's', value2: 'BUTTON_4' },
        2: { value: 'v', value2: 'SELECT' },          // Select
        3: { value: 'enter', value2: 'START' },       // Start
        4: { value: 'up arrow', value2: 'DPAD_UP' },
        5: { value: 'down arrow', value2: 'DPAD_DOWN' },
        6: { value: 'left arrow', value2: 'DPAD_LEFT' },
        7: { value: 'right arrow', value2: 'DPAD_RIGHT' },
        8: { value: 'z', value2: 'BUTTON_1' },        // A
        9: { value: 'a', value2: 'BUTTON_3' },
        10: { value: 'q', value2: 'LEFT_TOP_SHOULDER' },   // L
        11: { value: 'e', value2: 'RIGHT_TOP_SHOULDER' },  // R
        12: { value: 'tab', value2: 'LEFT_BOTTOM_SHOULDER' },
        13: { value: 'r', value2: 'RIGHT_BOTTOM_SHOULDER' },
        14: { value: '', value2: 'LEFT_STICK' },
        15: { value: '', value2: 'RIGHT_STICK' },
        16: { value: 'h', value2: 'LEFT_STICK_X:+1' },
        17: { value: 'f', value2: 'LEFT_STICK_X:-1' },
        18: { value: 'g', value2: 'LEFT_STICK_Y:+1' },
        19: { value: 't', value2: 'LEFT_STICK_Y:-1' },
        20: { value: 'l', value2: 'RIGHT_STICK_X:+1' },
        21: { value: 'j', value2: 'RIGHT_STICK_X:-1' },
        22: { value: 'k', value2: 'RIGHT_STICK_Y:+1' },
        23: { value: 'i', value2: 'RIGHT_STICK_Y:-1' },
        24: {}, 25: {}, 26: {}, 27: {}, 28: {}, 29: {},
      },
      1: {}, 2: {}, 3: {},
    },
    EJS_Buttons: {
      netplay: false,
      cacheManager: false,
      saveSavFiles: false,
      loadSavFiles: false,
      screenRecord: false,
      exitEmulation: false,
      quickSave: false,
      quickLoad: false,
    },
    EJS_onGameStart: async () => {
      $('#loading').hidden = true;
      try { await pullSave(); } catch (e) { setSync(e.login ? 'faça login de novo' : '⚠ lake fora do ar: save não sincroniza', 'err'); }
      // Controles salvos de antes ainda trazem os atalhos 1/2/3 (quick save/load/slot): limpa.
      const ctl = window.EJS_emulator.controls?.[0];
      if (ctl && [24, 25, 26].some(k => ctl[k]?.value)) {
        for (const k of [24, 25, 26]) ctl[k] = {};
        window.EJS_emulator.saveSettings();
      }
      started = true;
      setInterval(pushSave, SAVE_EVERY_MS);
      // Sempre abre em 1x (o EmulatorJS lembraria o fast-forward da última vez).
      setSpeed(1);
      speedBtn.disabled = false;
    },
    // Savestate: vai para o lake junto com o print da tela (vira a capa na biblioteca).
    EJS_onSaveState: async ({ screenshot, state }) => {
      setSync('☁ salvando estado…', 'busy');
      try {
        const r = await api(`/state/${id}`, { method: 'PUT', body: state });
        if (!r.ok) throw new Error(r.status);
        // No 4.2.3 o `screenshot` do evento chega undefined (bug do EmulatorJS): pede o PNG ao núcleo.
        const png = screenshot || await Promise.race([gm().screenshot(), new Promise(r => setTimeout(r, 3000))]);
        if (png) await api(`/shot/${id}`, { method: 'PUT', body: png, headers: { 'content-type': 'image/png' } });
        window.EJS_emulator.displayMessage('ESTADO SALVO NO LAKE');
        setSync('☁ estado salvo', 'ok');
      } catch {
        setSync('⚠ estado não salvo', 'err');
      }
    },
    EJS_onLoadState: async () => {
      try {
        const r = await api(`/state/${id}`);
        if (r.status === 404) { window.EJS_emulator.displayMessage('NENHUM ESTADO SALVO'); return; }
        gm().loadState(new Uint8Array(await r.arrayBuffer()));
        window.EJS_emulator.displayMessage('ESTADO CARREGADO');
      } catch {
        setSync('⚠ não carregou o estado', 'err');
      }
    },
  });

  // ---- velocidade: 1x → 2x → 3x → 4x → 5x → 10x (usa o fast-forward do próprio EmulatorJS,
  // então o botão "Rápido" do gamepad virtual também passa a usar a velocidade escolhida)
  const speedBtn = $('#speed');
  let speed = 1;
  const setSpeed = (n) => {
    const emu = window.EJS_emulator;
    if (!emu?.gameManager) return;
    speed = n;
    if (n > 1) {
      emu.changeSettingOption('ff-ratio', `${n}.0`);
      emu.changeSettingOption('fastForward', 'enabled');
    } else {
      emu.changeSettingOption('fastForward', 'disabled');
    }
    speedBtn.textContent = `${n}x`;
    speedBtn.classList.toggle('fast', n > 1);
  };
  speedBtn.onclick = () => setSpeed(SPEEDS.find(n => n > speed) ?? 1);
  addEventListener('keydown', (e) => {
    // Teclas 1–9 escolhem a velocidade direto; 0 = 10x.
    if (started && /^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) setSpeed(Number(e.key) || 10);
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) pushSave(); });
  addEventListener('pagehide', pushSave);
  $('#back').onclick = async () => {
    $('#back').disabled = true;
    await pushSave();
    location.href = './';
  };

  const s = el('script', { src: EJS_DATA + 'loader.js' });
  s.onerror = () => { $('#loading-msg').textContent = 'Não carregou o EmulatorJS (CDN).'; };
  document.body.append(s);
}

// ------------------------------------------------------------------ início

(async () => {
  const q = new URLSearchParams(location.search);
  try {
    await ensureLogin();
  } catch {
    show('library');
    $('#lib-status').textContent = 'Servidor fora do ar. Tente de novo em instantes.';
    return;
  }
  if (q.get('jogo')) play(q.get('jogo'), q.get('v') || '0');
  else library();
})();
