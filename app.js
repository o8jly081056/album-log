/* SHeard · 唱片書籤 v2
 * 資料：本機 localStorage 為主，登入後與 Supabase 雙向同步（新的修改勝出）
 * 目錄：iTunes Search API（免金鑰）；Spotify 只用來看「正在播放／最近播放／收藏」，一律手動標記
 */
const CFG = window.HEARD_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

/* ================= 資料層 ================= */
const KEY = 'heard.v2';
const norm = s => (s || '').toLowerCase()
  .replace(/\s*[\(\[](deluxe|remaster|explicit|clean|expanded|anniversary|bonus|special)[^\)\]]*[\)\]]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '').trim();
// 用「歌手名＋專輯名」當作唯一鍵，讓 Apple Music / Spotify / 手動新增的同一張專輯對得起來
const albumKey = a => `${norm(a.artist)}|${norm(a.title)}`;

const db = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.albums) return Object.assign({ deleted: {}, dirty: {} }, d); } catch (e) {}
  const d = { albums: {}, deleted: {}, dirty: {}, settings: { showSingles: false, country: 'TW' } };
  // 從 v1 搬資料過來
  try {
    const old = JSON.parse(localStorage.getItem('heard.v1'));
    if (old?.albums) {
      Object.values(old.albums).forEach(a => {
        const k = albumKey(a);
        d.albums[k] = { ...a, status: 'heard', addedAt: a.heardAt || Date.now(), updatedAt: Date.now() };
        d.dirty[k] = 1;
      });
      if (old.settings) Object.assign(d.settings, old.settings);
    }
  } catch (e) {}
  return d;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('儲存失敗'); } }
const statusOf = k => db.albums[k]?.status || null;

function fromItunes(r) {
  let title = r.collectionName || '', type = 'Album';
  if (/ - EP$/i.test(title)) { type = 'EP'; title = title.replace(/ - EP$/i, ''); }
  else if (/ - Single$/i.test(title)) { type = 'Single'; title = title.replace(/ - Single$/i, ''); }
  else if ((r.trackCount || 0) <= 3) type = 'Single';
  else if ((r.trackCount || 0) <= 6) type = 'EP';
  return {
    id: String(r.collectionId), title, type, artist: r.artistName,
    artistId: r.artistId ? String(r.artistId) : '',
    year: r.releaseDate ? r.releaseDate.slice(0, 4) : '', tracks: r.trackCount || 0,
    cover: (r.artworkUrl100 || '').replace('100x100bb', '600x600bb'), appleUrl: r.collectionViewUrl || ''
  };
}
function fromSpotify(al) {
  const t = al.album_type;
  return {
    id: 'sp:' + al.id, spotifyId: al.id, title: al.name,
    artist: (al.artists || []).map(a => a.name).join(' & '), artistId: '',
    type: t === 'single' ? ((al.total_tracks || 0) >= 4 ? 'EP' : 'Single') : 'Album',
    year: (al.release_date || '').slice(0, 4), tracks: al.total_tracks || 0,
    cover: al.images?.[0]?.url || ''
  };
}

/* 設定狀態：'heard' | 'want' | null(移除) */
function setStatus(k, status) {
  const cur = db.albums[k];
  const now = Date.now();
  if (!status) {
    if (!cur) return;
    if (cur.manual && !confirm('這是手動新增的唱片，移除後資料會刪除，確定？')) return false;
    seen.set(k, cur); delete db.albums[k]; db.deleted[k] = now;
  } else if (cur) {
    cur.status = status; cur.updatedAt = now;
    if (status === 'heard') cur.heardAt = now;
  } else {
    const a = findAlbum(k); if (!a) return;
    const { _tracks, ...clean } = a;
    db.albums[k] = { ...clean, status, addedAt: now, updatedAt: now, heardAt: status === 'heard' ? now : null, rating: 0, note: '' };
    delete db.deleted[k];
  }
  db.dirty[k] = 1; save(); scheduleSync();
  return true;
}
function toggle(k, status) {
  const was = statusOf(k);
  if (setStatus(k, was === status ? null : status) === false) return;
  toast(was === status ? (status === 'heard' ? '已取消「已聽過」' : '已移出想聽') : (status === 'heard' ? '✓ 已聽過' : '🔖 加入想聽'));
  if (state.current) renderSheet();
  render();
}
function touch(k) { db.albums[k].updatedAt = Date.now(); db.dirty[k] = 1; save(); scheduleSync(); }

/* ================= iTunes API ================= */
const cache = new Map();
async function api(path) {
  const ck = path + db.settings.country;
  if (cache.has(ck)) return cache.get(ck);
  const res = await fetch(`https://itunes.apple.com/${path}&country=${db.settings.country || 'TW'}`);
  if (!res.ok) throw new Error(res.status);
  const r = (await res.json()).results || [];
  cache.set(ck, r); return r;
}
const searchAlbums = q => api(`search?term=${encodeURIComponent(q)}&entity=album&limit=60`).then(r => r.filter(x => x.wrapperType === 'collection').map(fromItunes));
const searchArtists = q => api(`search?term=${encodeURIComponent(q)}&entity=musicArtist&limit=25`);
async function artistAlbums(id) {
  const r = await api(`lookup?id=${id}&entity=album&limit=200`);
  const m = new Map();
  r.filter(x => x.wrapperType === 'collection').map(fromItunes).forEach(a => { const k = albumKey(a); if (!m.has(k)) m.set(k, a); });
  return [...m.values()].sort((a, b) => (b.year || '').localeCompare(a.year || ''));
}
async function resolveArtistId(name) {
  const r = await searchArtists(name);
  const hit = r.find(x => norm(x.artistName) === norm(name)) || r.find(x => norm(name).startsWith(norm(x.artistName)));
  return hit ? String(hit.artistId) : '';
}

/* ================= Spotify（PKCE，免後端） ================= */
const SP_KEY = 'heard.spotify';
const SP_SCOPES = 'user-read-currently-playing user-read-recently-played user-library-read';
let spTok = (() => { try { return JSON.parse(localStorage.getItem(SP_KEY)); } catch (e) { return null; } })();
const spOn = () => !!(CFG.SPOTIFY_CLIENT_ID && spTok?.refresh);
const spRedirect = () => location.origin + location.pathname.replace(/index\.html$/, '');
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function spotifyLogin() {
  if (location.hostname === 'localhost') { // Spotify 不接受 localhost，要用 127.0.0.1
    location.href = location.href.replace('//localhost', '//127.0.0.1'); return;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(12)));
  localStorage.setItem('heard.pkce', JSON.stringify({ verifier, st }));
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: CFG.SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: spRedirect(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SP_SCOPES, state: st
  });
}
async function spTokenReq(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.SPOTIFY_CLIENT_ID, ...body })
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || res.status);
  spTok = { access: j.access_token, refresh: j.refresh_token || spTok?.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
  localStorage.setItem(SP_KEY, JSON.stringify(spTok));
}
async function spotifyCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', spRedirect());
  if (p.get('error')) return toast('Spotify 連結已取消');
  const saved = JSON.parse(localStorage.getItem('heard.pkce') || '{}');
  localStorage.removeItem('heard.pkce');
  if (saved.st !== p.get('state')) return toast('Spotify 驗證失敗，請再試一次');
  try { await spTokenReq({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: spRedirect(), code_verifier: saved.verifier }); toast('✓ 已連結 Spotify'); }
  catch (e) { toast('Spotify 連結失敗：' + e.message); }
}
function spotifyLogout() { spTok = null; localStorage.removeItem(SP_KEY); state.sp = {}; }
async function sp(path, retry = true) {
  if (!spTok) throw new Error('not connected');
  if (!spTok.access || Date.now() > spTok.exp) {
    try { await spTokenReq({ grant_type: 'refresh_token', refresh_token: spTok.refresh }); }
    catch (e) { spotifyLogout(); render(); throw new Error('Spotify 登入已過期，請重新連結'); }
  }
  const res = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + spTok.access } });
  if (res.status === 204) return null;
  if (res.status === 401 && retry) { spTok.exp = 0; return sp(path, false); }
  if (res.status === 403) throw new Error('Spotify 拒絕存取：請確認你的帳號已加入開發者後台的 User Management，且 App 擁有者有 Premium');
  if (res.status === 429) throw new Error('Spotify 請求太頻繁，稍後再試');
  if (!res.ok) throw new Error('Spotify 錯誤 ' + res.status);
  return res.json();
}
async function spNowPlaying() {
  const j = await sp('/me/player/currently-playing');
  if (!j?.item?.album) return null;
  return { album: remember([fromSpotify(j.item.album)])[0], track: j.item.name, playing: j.is_playing };
}
async function spRecent() {
  const j = await sp('/me/player/recently-played?limit=50');
  const m = new Map();
  (j?.items || []).forEach(it => { const a = fromSpotify(it.track.album); const k = albumKey(a); if (!m.has(k)) m.set(k, a); });
  return remember([...m.values()]);
}
async function spSaved(offset = 0) {
  const j = await sp(`/me/albums?limit=20&offset=${offset}`);
  return { list: remember((j?.items || []).map(x => fromSpotify(x.album))), next: j?.next ? offset + 20 : null, total: j?.total || 0 };
}

/* ================= 雲端同步（Supabase） ================= */
let sb = null, sbUser = null, syncing = false, syncT = null;
const syncOn = () => !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
async function initSync() {
  if (!syncOn()) return;
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js');
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, storageKey: 'heard.sb' } });
    const { data } = await sb.auth.getSession();
    sbUser = data.session?.user || null;
    sb.auth.onAuthStateChange((_e, s) => { sbUser = s?.user || null; });
    render();
    if (sbUser) syncNow();
  } catch (e) { console.warn('sync init failed', e); }
}
function scheduleSync() { if (!sbUser) return; clearTimeout(syncT); syncT = setTimeout(syncNow, 1500); }
async function syncNow(manual) {
  if (!sb || !sbUser || syncing) return;
  syncing = true; state.syncErr = ''; updateDot();
  try {
    // 1. 拉下雲端全部資料，時間較新的覆蓋本機
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('albums').select('key,data,deleted,updated_at').range(from, from + 999);
      if (error) throw error;
      data.forEach(r => {
        const k = r.key, localTs = db.albums[k]?.updatedAt ?? db.deleted[k] ?? 0, ts = Number(r.updated_at);
        if (ts > localTs) {
          if (r.deleted) { delete db.albums[k]; db.deleted[k] = ts; } else { db.albums[k] = r.data; delete db.deleted[k]; }
          delete db.dirty[k];
        } else if (ts === localTs) delete db.dirty[k];
      });
      if (data.length < 1000) break;
    }
    // 2. 推上本機有改過的
    const rows = Object.keys(db.dirty).map(k => db.albums[k]
      ? { user_id: sbUser.id, key: k, data: db.albums[k], deleted: false, updated_at: db.albums[k].updatedAt || Date.now() }
      : { user_id: sbUser.id, key: k, data: {}, deleted: true, updated_at: db.deleted[k] || Date.now() });
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('albums').upsert(chunk, { onConflict: 'user_id,key' });
      if (error) throw error;
      chunk.forEach(r => delete db.dirty[r.key]);
    }
    db.lastSync = Date.now(); save();
    if (manual) toast('✓ 已同步');
  } catch (e) { state.syncErr = e.message || String(e); if (manual) toast('同步失敗'); console.warn(e); }
  syncing = false;
  if (!state.current) render(); else updateDot();
}
function updateDot() {
  const d = $('#syncDot'); if (!d) return;
  d.className = 'dot ' + (syncing ? 'busy' : (sbUser && !state.syncErr ? '' : 'off'));
}

/* ================= 狀態 ================= */
const state = {
  tab: 'search', view: null, q: '', mode: 'album', results: null, loading: false,
  libFilter: 'all', libSort: 'recent', libQ: '', current: null, sp: {}, syncErr: '', login: {}
};
const seen = new Map();
function remember(list) { list.forEach(a => { const k = albumKey(a); const old = seen.get(k); seen.set(k, old ? { ...old, ...a, _tracks: old._tracks } : a); }); return list; }
const findAlbum = k => db.albums[k] || seen.get(k);
const filterTypes = list => db.settings.showSingles ? list : list.filter(a => a.type !== 'Single');
const typeLabel = t => ({ Album: '專輯', EP: 'EP', Single: '單曲' })[t] || t;

const I = {
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  markOn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m15 5-7 7 7 7"/></svg>'
};
const gearBtn = () => `<button class="icon-btn" data-act="menu" aria-label="設定">${I.gear}${syncOn() ? `<span id="syncDot" class="dot ${syncing ? 'busy' : (sbUser && !state.syncErr ? '' : 'off')}"></span>` : ''}</button>`;

/* ================= 畫面 ================= */
function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab && !state.view));
  const app = $('#app');
  if (state.view?.type === 'artist') return renderArtist(app);
  ({ search: renderSearch, heard: renderLib, want: renderLib, artists: renderArtists })[state.tab](app);
}

function albumCard(a) {
  const k = albumKey(a), s = statusOf(k);
  return `<div class="card" data-open="${esc(k)}">
    <div class="cover">
      ${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : '<div class="ph">♪</div>'}
      ${a.type !== 'Album' ? `<span class="badge">${typeLabel(a.type)}</span>` : ''}
      <div class="acts">
        ${s !== 'heard' ? `<button class="mini ${s === 'want' ? 'want' : ''}" data-want="${esc(k)}" aria-label="想聽">${s === 'want' ? I.markOn : I.mark}</button>` : ''}
        <button class="mini ${s === 'heard' ? 'heard' : ''}" data-heard="${esc(k)}" aria-label="已聽過">${s === 'heard' ? I.check : I.plus}</button>
      </div>
    </div>
    <div class="t">${esc(a.title)}</div>
    <div class="a">${s === 'heard' ? '<span class="lbl heard">✓ 已聽過</span> · ' : s === 'want' ? '<span class="lbl want">想聽</span> · ' : ''}${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
  </div>`;
}

/* ---------- 探索（搜尋＋Spotify） ---------- */
function renderSearch(app) {
  const r = state.results;
  let body;
  if (state.loading) body = '<div class="spinner"></div>';
  else if (!r) body = homeHTML();
  else if (state.mode === 'album') {
    const list = remember(filterTypes(r));
    body = list.length ? `<div class="grid">${list.map(albumCard).join('')}</div>` : '<div class="empty">找不到結果</div>';
  } else {
    body = r.length ? `<div class="list">${r.map(x => {
      const n = Object.values(db.albums).filter(a => a.status === 'heard' && norm(a.artist) === norm(x.artistName)).length;
      return `<button class="li" data-artist="${x.artistId}" data-name="${esc(x.artistName)}">
        <div class="av">${esc(x.artistName[0])}</div>
        <div class="grow"><div class="name">${esc(x.artistName)}</div><div class="muted small">${esc(x.primaryGenreName || '')}${n ? ` · 已聽 ${n} 張` : ''}</div></div>
      </button>`;
    }).join('')}</div>` : '<div class="empty">找不到歌手</div>';
  }
  app.innerHTML = `
    <header class="top"><h1>探索</h1>${gearBtn()}</header>
    <form class="search" id="sform">${I.search}<input id="q" type="search" enterkeyhint="search" placeholder="歌手、專輯、EP…" value="${esc(state.q)}" autocomplete="off"></form>
    <div class="row-between" style="margin-bottom:12px">
      <div class="chips" style="margin:0;padding:0">
        <button class="chip ${state.mode === 'album' ? 'on' : ''}" data-mode="album">專輯 / EP</button>
        <button class="chip ${state.mode === 'artist' ? 'on' : ''}" data-mode="artist">歌手</button>
        ${r ? '<button class="chip" data-act="clear">✕ 清除</button>' : ''}
      </div>
      <label class="toggle"><input type="checkbox" id="singles" ${db.settings.showSingles ? 'checked' : ''}>單曲</label>
    </div>
    ${body}`;
  $('#sform').onsubmit = e => { e.preventDefault(); $('#q').blur(); doSearch($('#q').value.trim()); };
  if (!r && !state.loading && spOn()) loadSpotifyHome();
}

function homeHTML() {
  if (!CFG.SPOTIFY_CLIENT_ID) return `<div class="empty"><b>找一張你聽過的唱片</b>輸入歌手或專輯名稱<br>點 ＋ 標記「已聽過」，點 🔖 加入「想聽」</div>`;
  if (!spOn()) return `<div class="panel" style="text-align:center;margin-top:8px">
      <b>連結 Spotify</b><div class="muted small" style="margin:4px 0 12px">看到「正在播放」和「最近聽的專輯」，一鍵手動標記</div>
      <button class="btn primary" data-act="spLogin">連結 Spotify</button></div>
    <div class="empty small">也可以直接在上面搜尋任何專輯</div>`;
  const s = state.sp;
  const sec = (title, inner, extra = '') => `<div class="section-h"><span>${title}</span>${extra}</div>${inner}`;
  const np = s.np === undefined ? '<div class="spinner sm"></div>'
    : !s.np ? '<div class="panel muted small">Spotify 目前沒有在播放</div>'
    : (() => { const a = s.np.album, k = albumKey(a), st = statusOf(k); return `<div class="panel"><div class="np" data-open="${esc(k)}">
        <div class="c">${a.cover ? `<img src="${esc(a.cover)}" alt="">` : ''}</div>
        <div class="grow"><div class="small muted">${s.np.playing ? '<span class="eq"><i></i><i></i><i></i></span>' : '⏸ '}${esc(s.np.track)}</div>
          <div style="font-weight:700">${esc(a.title)}</div><div class="muted small">${esc(a.artist)} · ${typeLabel(a.type)}</div></div></div>
        <div class="two" style="margin-top:12px">
          <button class="big-btn ${st === 'want' ? 'want' : ''}" style="height:42px;font-size:14px" data-want="${esc(k)}">${st === 'want' ? I.markOn + ' 想聽' : I.mark + ' 想聽'}</button>
          <button class="big-btn ${st === 'heard' ? 'heard' : 'solid'}" style="height:42px;font-size:14px" data-heard="${esc(k)}">${st === 'heard' ? I.check + ' 已聽過' : I.plus + ' 標記已聽過'}</button>
        </div></div>`; })();
  const recent = s.recent === undefined ? '<div class="spinner sm"></div>'
    : s.recent.length ? `<div class="hscroll">${filterTypes(s.recent).map(albumCard).join('')}</div>` : '<div class="muted small">沒有最近播放紀錄</div>';
  const saved = s.saved === undefined ? '<div class="spinner sm"></div>'
    : s.saved.length ? `<div class="grid">${s.saved.map(albumCard).join('')}</div>${s.savedNext != null ? '<div style="text-align:center;margin-top:14px"><button class="btn sm" data-act="spMore">載入更多</button></div>' : ''}` : '<div class="muted small">你在 Spotify 沒有收藏專輯</div>';
  const unheard = s.saved ? s.saved.filter(a => statusOf(albumKey(a)) !== 'heard').length : 0;
  return `${s.err ? `<div class="panel err">${esc(s.err)}</div>` : ''}
    ${sec('正在播放', np, '<button class="btn sm" data-act="spRefresh">重新整理</button>')}
    ${sec('最近播放的專輯', recent)}
    ${sec(`你在 Spotify 收藏的專輯${s.savedTotal ? ` · ${s.savedTotal}` : ''}`, saved, s.saved ? `<span class="small">${unheard} 張還沒標記</span>` : '')}`;
}

let spLoading = false;
async function loadSpotifyHome(force) {
  if (spLoading) return;
  const s = state.sp;
  if (!force && s.loadedAt && Date.now() - s.loadedAt < 60000) return;
  spLoading = true; s.loadedAt = Date.now(); s.err = '';
  const tasks = [
    spNowPlaying().then(v => s.np = v),
    spRecent().then(v => s.recent = v),
    (s.saved && !force) ? null : spSaved(0).then(v => { s.saved = v.list; s.savedNext = v.next; s.savedTotal = v.total; })
  ].filter(Boolean);
  const res = await Promise.allSettled(tasks);
  const fail = res.find(x => x.status === 'rejected');
  if (fail) { s.err = fail.reason.message; s.np ??= null; s.recent ??= []; s.saved ??= []; }
  spLoading = false;
  if (state.tab === 'search' && !state.view && !state.results && !state.current) render();
}
// 每 20 秒更新正在播放（只在探索頁、App 在前景時）
setInterval(async () => {
  if (!spOn() || document.hidden || state.tab !== 'search' || state.view || state.results || state.current) return;
  try {
    const v = await spNowPlaying();
    const changed = albumKey(v?.album || {}) !== albumKey(state.sp.np?.album || {}) || v?.track !== state.sp.np?.track || v?.playing !== state.sp.np?.playing;
    state.sp.np = v; if (changed && !state.current && state.tab === 'search' && !state.results) render();
  } catch (e) {}
}, 20000);

async function doSearch(q) {
  if (!q) return;
  state.q = q; state.loading = true; render();
  try { state.results = state.mode === 'album' ? await searchAlbums(q) : await searchArtists(q); }
  catch (e) { state.results = []; toast('連線失敗，請稍後再試'); }
  state.loading = false; render();
}

/* ---------- 已聽過 / 想聽 ---------- */
function renderLib(app) {
  const status = state.tab;
  let list = Object.values(db.albums).filter(a => a.status === status);
  const total = list.length, artists = new Set(list.map(a => norm(a.artist))).size;
  if (state.libFilter !== 'all') list = list.filter(a => a.type === state.libFilter);
  if (state.libQ) { const q = state.libQ.toLowerCase(); list = list.filter(a => (a.title + ' ' + a.artist).toLowerCase().includes(q)); }
  const sorters = {
    recent: (a, b) => ((status === 'heard' ? b.heardAt : b.addedAt) || 0) - ((status === 'heard' ? a.heardAt : a.addedAt) || 0),
    artist: (a, b) => a.artist.localeCompare(b.artist, 'zh-Hant') || (a.year || '').localeCompare(b.year || ''),
    year: (a, b) => (b.year || '').localeCompare(a.year || ''),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0)
  };
  list.sort(sorters[state.libSort] || sorters.recent);
  remember(list);
  const isH = status === 'heard';
  app.innerHTML = `
    <header class="top"><div><h1>${isH ? '已聽過' : '想聽'}</h1><div class="sub">${total} 張唱片 · ${artists} 位歌手</div></div>${gearBtn()}</header>
    ${total ? `<div class="search">${I.search}<input id="lq" type="search" placeholder="在${isH ? '已聽過' : '想聽'}裡搜尋" value="${esc(state.libQ)}"></div>
    <div class="chips">
      ${[['all', '全部'], ['Album', '專輯'], ['EP', 'EP'], ['Single', '單曲']].map(([k, l]) => `<button class="chip ${state.libFilter === k ? 'on' : ''}" data-lf="${k}">${l}</button>`).join('')}
      <span style="flex:1"></span>
      ${[['recent', '最近'], ['artist', '歌手'], ['year', '年份'], ...(isH ? [['rating', '評分']] : [])].map(([k, l]) => `<button class="chip ${state.libSort === k ? 'on' : ''}" data-ls="${k}">${l}</button>`).join('')}
    </div>
    ${list.length ? `<div class="grid">${list.map(albumCard).join('')}</div>` : '<div class="empty">沒有符合的唱片</div>'}`
    : `<div class="empty"><b>${isH ? '還沒有已聽過的唱片' : '想聽清單是空的'}</b>到「探索」找專輯，點 ${isH ? '＋ 標記已聽過' : '🔖 加入想聽'}</div>`}`;
  const lq = $('#lq'); if (lq) lq.oninput = e => { state.libQ = e.target.value; const pos = e.target.selectionStart; render(); const n = $('#lq'); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ---------- 歌手 ---------- */
function renderArtists(app) {
  const map = new Map();
  Object.values(db.albums).forEach(a => {
    const k = norm(a.artist);
    if (!map.has(k)) map.set(k, { id: '', name: a.artist, heard: [], want: [] });
    const g = map.get(k); if (a.artistId) g.id = a.artistId;
    g[a.status === 'want' ? 'want' : 'heard'].push(a);
  });
  const list = [...map.values()].sort((a, b) => b.heard.length - a.heard.length || a.name.localeCompare(b.name, 'zh-Hant'));
  app.innerHTML = `
    <header class="top"><div><h1>歌手</h1><div class="sub">點進去看完整作品，哪些聽過一目了然</div></div>${gearBtn()}</header>
    ${list.length ? `<div class="list">${list.map(x => {
      const c = (x.heard[0] || x.want[0]).cover;
      return `<button class="li" data-artist="${x.id}" data-name="${esc(x.name)}">
        <div class="av">${c ? `<img src="${esc(c)}" alt="">` : esc(x.name[0])}</div>
        <div class="grow"><div class="name">${esc(x.name)}</div>
          <div class="muted small">已聽 ${x.heard.length} 張${x.want.length ? ` · 想聽 ${x.want.length} 張` : ''}</div></div>
        <span class="muted">›</span></button>`;
    }).join('')}</div>`
    : `<div class="empty"><b>還沒有歌手</b>標記第一張專輯後，歌手會出現在這裡</div>`}`;
}

async function renderArtist(app) {
  const v = state.view;
  const head = `<button class="back" data-act="back">${I.back}返回</button>`;
  const local = Object.values(db.albums).filter(a => norm(a.artist) === norm(v.name));
  if (!v.albums) {
    app.innerHTML = `${head}<h2 style="margin:4px 0">${esc(v.name)}</h2><div class="spinner"></div>`;
    try {
      if (!v.id) v.id = await resolveArtistId(v.name);
      v.albums = v.id ? await artistAlbums(v.id) : [];
    } catch (e) { v.albums = []; toast('載入失敗'); }
    if (state.view !== v) return;
  }
  const keys = new Set(v.albums.map(albumKey));
  const all = remember([...v.albums, ...local.filter(a => !keys.has(albumKey(a)))]);
  const groups = [['Album', '專輯'], ['EP', 'EP'], ...(db.settings.showSingles ? [['Single', '單曲']] : [])];
  const counted = all.filter(a => db.settings.showSingles || a.type !== 'Single');
  const heard = counted.filter(a => statusOf(albumKey(a)) === 'heard').length;
  const want = counted.filter(a => statusOf(albumKey(a)) === 'want').length;
  const pct = counted.length ? Math.round(heard / counted.length * 100) : 0;
  const cover = all.find(a => a.cover)?.cover;
  app.innerHTML = `${head}
    <div class="artist-hero">
      <div class="av">${cover ? `<img src="${esc(cover)}" alt="">` : ''}</div>
      <div style="flex:1;min-width:0"><h2>${esc(v.name)}</h2>
        <div class="row-between"><span class="muted small">聽過 ${heard} / ${counted.length} 張${want ? ` · 想聽 ${want}` : ''}</span><b style="font-size:18px">${pct}%</b></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
    </div>
    ${groups.map(([t, l]) => {
      const g = all.filter(a => a.type === t);
      if (!g.length) return '';
      const h = g.filter(a => statusOf(albumKey(a)) === 'heard').length;
      return `<div class="section-h"><span>${l} · ${h}/${g.length}</span></div><div class="grid">${g.map(albumCard).join('')}</div>`;
    }).join('')}
    ${!all.length ? '<div class="empty">找不到這位歌手的作品</div>' : '<div class="empty small">專輯 / EP 分類依 Apple Music 資料自動判斷，可能不完全準確</div>'}`;
}

/* ================= 專輯詳情 ================= */
function showSheet() { $('#scrim').classList.add('show'); $('#sheet').classList.add('show'); }
function hideSheet() { $('#scrim').classList.remove('show'); $('#sheet').classList.remove('show'); state.current = null; }
function closeSheet() { hideSheet(); render(); }

async function loadTracks(k) {
  const a = findAlbum(k); if (!a || a._tracks || a.manual) return;
  try {
    let t = [];
    if (a.spotifyId && spOn()) {
      const j = await sp('/albums/' + a.spotifyId);
      t = (j?.tracks?.items || []).map(x => ({ n: x.track_number, name: x.name, ms: x.duration_ms }));
    } else if (/^\d+$/.test(a.id)) {
      const r = await api(`lookup?id=${a.id}&entity=song`);
      t = r.filter(x => x.wrapperType === 'track').map(x => ({ n: x.trackNumber, name: x.trackName, ms: x.trackTimeMillis }));
    }
    const s = seen.get(k); if (s) s._tracks = t; else seen.set(k, { ...a, _tracks: t });
    if (state.current === k) renderSheet();
  } catch (e) {}
}
function openAlbum(k) {
  if (!findAlbum(k)) return;
  state.current = k; renderSheet(); showSheet(); loadTracks(k);
}
function renderSheet() {
  const k = state.current; const saved = db.albums[k]; const a = saved || seen.get(k); if (!a) return;
  const st = saved?.status || null;
  const tracks = seen.get(k)?._tracks;
  const spotify = a.spotifyId ? `https://open.spotify.com/album/${a.spotifyId}` : `https://open.spotify.com/search/${encodeURIComponent(a.artist + ' ' + a.title)}`;
  const fmt = ms => ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '';
  $('#sheet').innerHTML = `<div class="grab"></div><div class="detail">
    <div class="detail-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="">` : '<div class="ph" style="font-size:60px">♪</div>'}</div>
    <h2>${esc(a.title)}</h2>
    <div class="by"><button data-artist="${a.artistId || ''}" data-name="${esc(a.artist)}" style="color:inherit;font-weight:inherit">${esc(a.artist)} ›</button></div>
    <div class="meta">${typeLabel(a.type)}${a.year ? ' · ' + a.year : ''}${a.tracks ? ' · ' + a.tracks + ' 首' : ''}</div>
    <div class="two">
      <button class="big-btn ${st === 'want' ? 'want' : ''}" style="flex:0 0 38%" data-want="${esc(k)}">${st === 'want' ? I.markOn : I.mark} 想聽</button>
      <button class="big-btn ${st === 'heard' ? 'heard' : 'solid'}" data-heard="${esc(k)}">${st === 'heard' ? I.check + ' 已聽過' : I.plus + ' 標記已聽過'}</button>
    </div>
    ${st === 'heard' ? `
      <div class="stars">${[1, 2, 3, 4, 5].map(n => `<button class="${(a.rating || 0) >= n ? 'on' : ''}" data-star="${n}" aria-label="${n} 星">★</button>`).join('')}</div>
      <div class="field"><label>聽過日期</label><input type="date" id="heardDate" value="${new Date(a.heardAt || Date.now()).toISOString().slice(0, 10)}"></div>` : ''}
    ${st ? `<div class="field"><label>筆記</label><textarea id="note" rows="3" placeholder="${st === 'heard' ? '喜歡哪幾首？什麼時候聽的？' : '誰推薦的？為什麼想聽？'}">${esc(a.note || '')}</textarea></div>` : ''}
    <div class="btn-row">
      <a class="btn primary" href="${spotify}" target="_blank" rel="noopener">在 Spotify 開啟</a>
      ${a.appleUrl ? `<a class="btn" href="${esc(a.appleUrl)}" target="_blank" rel="noopener">Apple Music</a>` : ''}
    </div>
    ${tracks?.length ? `<div class="tracks">${tracks.map(t => `<div><span>${t.n}</span><b style="flex:1;font-weight:400">${esc(t.name)}</b><em class="muted small" style="font-style:normal">${fmt(t.ms)}</em></div>`).join('')}</div>` : ''}
  </div>`;
  const note = $('#note'); if (note) note.onchange = e => { db.albums[k].note = e.target.value; touch(k); toast('已儲存筆記'); };
  const d = $('#heardDate'); if (d) d.onchange = e => { db.albums[k].heardAt = new Date(e.target.value).getTime() || Date.now(); touch(k); };
}

/* ================= 設定選單 ================= */
function openMenu() {
  state.current = null;
  const L = state.login;
  const syncBlock = !syncOn() ? '<div class="muted small">尚未設定雲端同步（見 SETUP.md）</div>'
    : !sb ? '<div class="spinner sm"></div>'
    : sbUser ? `<div class="panel"><div class="row-between"><div><b>${esc(sbUser.email)}</b>
        <div class="muted small">${syncing ? '同步中…' : state.syncErr ? '同步失敗：' + esc(state.syncErr) : db.lastSync ? '上次同步 ' + new Date(db.lastSync).toLocaleString('zh-TW', { hour12: false }) : '尚未同步'}</div></div>
        <button class="btn sm" data-act="syncNow">立即同步</button></div>
        <div style="margin-top:10px"><button class="btn sm" data-act="logout">登出</button></div></div>`
    : `<div class="panel"><div class="small muted">登入後，手機和電腦會自動同步。第一次使用請按「註冊」，之後每台裝置都用同一組帳密登入。</div>
        <form id="loginForm" style="margin-top:8px">
          <input id="email" type="email" autocomplete="email" placeholder="Email" value="${esc(L.email || '')}" required>
          <input id="pw" type="password" autocomplete="current-password" placeholder="密碼（至少 6 個字）" minlength="6" required style="margin-top:8px">
          <div class="btn-row"><button class="btn" type="submit" name="signup">註冊</button><button class="btn primary" type="submit">登入</button></div>
        </form>
        ${L.err ? `<div class="err">${esc(L.err)}</div>` : ''}</div>`;
  const spBlock = !CFG.SPOTIFY_CLIENT_ID ? '<div class="muted small">尚未設定 Spotify（見 SETUP.md）</div>'
    : spOn() ? `<div class="panel row-between"><span>✓ 已連結 Spotify</span><button class="btn sm" data-act="spLogout">中斷連結</button></div>`
    : `<button class="btn primary" data-act="spLogin">連結 Spotify</button>`;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin:0">設定</h2>
    <div class="menu-h">雲端同步</div>${syncBlock}
    <div class="menu-h">SPOTIFY</div>${spBlock}
    <div class="menu-h">資料</div>
    <div class="list">
      <button class="li" data-act="manual"><div class="grow"><div class="name">手動新增唱片</div><div class="muted small">搜不到的獨立發行或實體 CD</div></div></button>
      <button class="li" data-act="export"><div class="grow"><div class="name">匯出備份</div><div class="muted small">下載 JSON 檔</div></div></button>
      <button class="li" data-act="import"><div class="grow"><div class="name">匯入備份</div><div class="muted small">合併到目前的資料</div></div></button>
    </div>
    <div class="field"><label>搜尋地區（影響可搜到的唱片）</label>
      <select id="country">${[['TW', '台灣'], ['US', '美國'], ['JP', '日本'], ['KR', '韓國'], ['HK', '香港'], ['GB', '英國']].map(([c, l]) => `<option value="${c}" ${db.settings.country === c ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  showSheet();
  $('#country').onchange = e => { db.settings.country = e.target.value; cache.clear(); save(); toast('已切換地區'); };
  const lf = $('#loginForm'); if (lf) lf.onsubmit = async e => {
    e.preventDefault(); L.err = '';
    const signup = e.submitter?.name === 'signup';
    L.email = $('#email').value.trim();
    const cred = { email: L.email, password: $('#pw').value };
    e.submitter && (e.submitter.disabled = true);
    const { data, error } = signup ? await sb.auth.signUp(cred) : await sb.auth.signInWithPassword(cred);
    if (error) {
      L.err = /invalid login/i.test(error.message) ? 'Email 或密碼錯誤（還沒註冊的話請先按「註冊」）'
        : /already registered/i.test(error.message) ? '這個 Email 已經註冊過了，請直接按「登入」' : error.message;
      return openMenu();
    }
    if (!data.session) { L.err = '註冊成功，但需要先到信箱點確認信。若不想收信，請到 Supabase 關閉 Confirm email。'; return openMenu(); }
    sbUser = data.user; state.login = {};
    Object.keys(db.albums).forEach(k => db.dirty[k] = 1); // 第一次登入：把本機全部推上去
    Object.keys(db.deleted).forEach(k => db.dirty[k] = 1);
    save(); toast('✓ 已登入，開始同步'); openMenu(); await syncNow(); if ($('#sheet').classList.contains('show')) openMenu();
  };
}
function openManual() {
  state.current = null;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin:0 0 4px">手動新增</h2><div class="muted small">搜不到的唱片（獨立發行、實體 CD…）可以自己加</div>
    <form id="mform">
      <div class="field"><label>歌手 *</label><input name="artist" required></div>
      <div class="field"><label>專輯名稱 *</label><input name="title" required></div>
      <div class="field" style="display:flex;gap:10px">
        <div style="flex:1"><label>類型</label><select name="type"><option value="Album">專輯</option><option value="EP">EP</option><option value="Single">單曲</option></select></div>
        <div style="flex:1"><label>年份</label><input name="year" inputmode="numeric" maxlength="4"></div>
      </div>
      <div class="field"><label>加到</label><select name="status"><option value="heard">已聽過</option><option value="want">想聽</option></select></div>
      <div class="field"><label>封面圖片網址（選填）</label><input name="cover" type="url"></div>
      <div class="two"><button class="big-btn solid" type="submit">${I.plus} 加入</button></div>
    </form>`;
  showSheet();
  $('#mform').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const a = { id: 'm' + Date.now(), title: f.title.trim(), artist: f.artist.trim(), artistId: '', type: f.type, year: f.year, cover: f.cover, tracks: 0, manual: true };
    const k = albumKey(a);
    if (db.albums[k]) return toast('這張已經在清單裡了');
    seen.set(k, a); setStatus(k, f.status); closeSheet(); toast('✓ 已加入');
  };
}
function exportData() {
  const blob = new Blob([JSON.stringify({ albums: db.albums, settings: db.settings }, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = u; a.download = `heard-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text()); let n = 0;
    Object.values(d.albums || {}).forEach(a => {
      const k = albumKey(a); if (db.albums[k]) return;
      db.albums[k] = { status: 'heard', ...a, updatedAt: Date.now() }; db.dirty[k] = 1; n++;
    });
    save(); scheduleSync(); closeSheet(); toast(`匯入 ${n} 張新唱片`);
  } catch (err) { toast('檔案格式不正確'); }
  e.target.value = '';
};

/* ================= 事件 ================= */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-heard],[data-want],[data-open],[data-name],[data-tab],[data-mode],[data-lf],[data-ls],[data-star],[data-act]');
  if (!t) return;
  const d = t.dataset;
  if (d.heard !== undefined) { e.stopPropagation(); return toggle(d.heard, 'heard'); }
  if (d.want !== undefined) { e.stopPropagation(); return toggle(d.want, 'want'); }
  if (d.open !== undefined) return openAlbum(d.open);
  if (d.name !== undefined) {
    if ($('#sheet').classList.contains('show')) hideSheet();
    state.view = { type: 'artist', id: d.artist || '', name: d.name }; window.scrollTo(0, 0); return render();
  }
  if (d.tab) {
    if (d.tab !== state.tab) { state.libFilter = 'all'; state.libSort = 'recent'; state.libQ = ''; }
    else if (d.tab === 'search' && !state.view) { state.results = null; state.q = ''; }
    state.tab = d.tab; state.view = null; window.scrollTo(0, 0); return render();
  }
  if (d.mode) { state.mode = d.mode; state.results = null; render(); if (state.q) doSearch(state.q); return; }
  if (d.lf) { state.libFilter = d.lf; return render(); }
  if (d.ls) { state.libSort = d.ls; return render(); }
  if (d.star) { const a = db.albums[state.current]; a.rating = a.rating == +d.star ? 0 : +d.star; touch(state.current); return renderSheet(); }
  switch (d.act) {
    case 'back': state.view = null; return render();
    case 'clear': state.results = null; state.q = ''; return render();
    case 'menu': return openMenu();
    case 'manual': return openManual();
    case 'export': return exportData();
    case 'import': return $('#importFile').click();
    case 'spLogin': return spotifyLogin();
    case 'spLogout': spotifyLogout(); toast('已中斷 Spotify'); return openMenu();
    case 'spRefresh': state.sp.np = undefined; render(); return loadSpotifyHome(true);
    case 'spMore': {
      t.disabled = true; t.textContent = '載入中…';
      try { const v = await spSaved(state.sp.savedNext); state.sp.saved.push(...v.list); state.sp.savedNext = v.next; } catch (err) { toast(err.message); }
      return render();
    }
    case 'syncNow': await syncNow(true); return openMenu();
    case 'logout': await sb.auth.signOut(); sbUser = null; toast('已登出（本機資料保留）'); return openMenu();
    case 'loginReset': state.login = {}; return openMenu();
  }
});
document.addEventListener('change', e => { if (e.target.id === 'singles') { db.settings.showSingles = e.target.checked; save(); render(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNow(); if (state.tab === 'search' && !state.results) loadSpotifyHome(); } });
$('#scrim').onclick = closeSheet;
(() => { // 下滑關閉
  let y0 = null; const s = $('#sheet');
  s.addEventListener('touchstart', e => { y0 = s.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  s.addEventListener('touchmove', e => { if (y0 === null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) s.style.transform = `translateY(${dy}px)`; }, { passive: true });
  s.addEventListener('touchend', e => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0; s.style.transform = ''; if (dy > 110) closeSheet(); y0 = null; });
})();

/* ================= 啟動 ================= */
(async () => {
  save();
  await spotifyCallback();
  render();
  initSync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
