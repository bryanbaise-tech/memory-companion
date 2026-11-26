'use strict';
/*
 * Memory Companion — prototype
 * Everything is stored on this device (IndexedDB). No server, no accounts yet.
 *   - Companion mode: the screens the person uses every day.
 *   - Family mode (#care, PIN protected): caregivers manage tasks, medicines,
 *     appointments, messages, photos, music, people and "about me" details.
 */

// ================================================================ storage (online, shared with the family)
// Everything lives in Supabase. The public key below is meant to be visible:
// row-level security on the server makes sure only circle members see anything.
const SUPABASE_URL = 'https://hekxmgammddlkdxtjvfd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhla3htZ2FtbWRkbGtkeHRqdmZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU2NDg2MzIsImV4cCI6MjExMTIyNDYzMn0.-GDna6mfCUxD8TW5H2HE-RHNl2EXLc9fBJxCZPs_epY';
const VOICE_FN = `${SUPABASE_URL}/functions/v1/speak`;
let sb = null;          // Supabase client
let me = null;          // signed-in user
let circleId = null;    // the loved one's care circle
let myRole = null;      // 'family' (signed in with email) or 'device' (the loved one's paired phone)
let myName = '';
const mem = new Map();  // store -> Map(id -> record): the whole circle, kept in sync live

// A visible, friendly message instead of a blank screen.
function showProblem(text) {
  const el = document.getElementById('app');
  if (!el) return;
  el.innerHTML = `<div class="paper problem"><h2>One moment</h2><p>${String(text).replace(/</g, '&lt;')}</p>
    <button class="btn primary" onclick="location.reload()">Try again</button></div>`;
}
window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  if (!document.getElementById('app')?.innerHTML.trim()) showProblem(`Something went wrong while loading: ${e.message}`);
});

const storeOf = (s) => { if (!mem.has(s)) mem.set(s, new Map()); return mem.get(s); };
const copy = (o) => (o == null ? o : structuredClone(o));
async function all(s) { return [...storeOf(s).values()].map(copy); }
async function get(s, id) { return copy(storeOf(s).get(id)); }
async function put(s, obj) {
  const rec = copy(obj);
  storeOf(s).set(rec.id, rec);
  const { error } = await sb.from('items').upsert({ circle_id: circleId, store: s, id: rec.id, data: rec, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return rec.id;
}
async function del(s, id) {
  const rec = storeOf(s).get(id);
  storeOf(s).delete(id);
  const { error } = await sb.from('items').delete().match({ circle_id: circleId, store: s, id });
  if (error) throw new Error(error.message);
  if (s === 'media' && rec && rec.path) sb.storage.from('media').remove([rec.path]).catch(() => {});
}

async function loadCircle() {
  mem.clear();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('items').select('store,id,data').eq('circle_id', circleId).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data) storeOf(row.store).set(row.id, row.data);
    if (data.length < 1000) break;
  }
}

// Live updates: a message sent from a family phone appears on the loved one's screen right away.
let liveChannel = null;
function listenLive() {
  if (liveChannel) sb.removeChannel(liveChannel);
  const apply = (p) => {
    if (p.eventType === 'DELETE') {
      const o = p.old || {};
      if (o.circle_id && o.circle_id !== circleId) return;
      if (o.store) storeOf(o.store).delete(o.id);
    } else {
      const n = p.new;
      if (!n || n.circle_id !== circleId) return;
      storeOf(n.store).set(n.id, n.data);
      if (n.store === 'settings' && n.id === 'main') { settings = mergeSettings(n.data); applySettings(); }
    }
    softRender();
  };
  liveChannel = sb.channel('circle-' + circleId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'items', filter: `circle_id=eq.${circleId}` }, apply)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'items', filter: `circle_id=eq.${circleId}` }, apply)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'items' }, apply)
    .subscribe();
}

// Re-render for live changes, but never while someone is typing in a form.
let pendingRender = false;
function softRender() {
  if ($app.querySelector('.player iframe')) { pendingRender = true; return; } // a song is playing
  if (typeof rec !== 'undefined' && (rec.recorder || rec.blob)) { pendingRender = true; return; } // recording in progress
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('#app')) { pendingRender = true; return; }
  clearTimeout(softRender.t);
  softRender.t = setTimeout(render, 150);
}
document.addEventListener('focusout', () => {
  if (!pendingRender) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    pendingRender = false;
    render();
  }, 250);
});

// ================================================================ helpers
const $app = document.getElementById('app');
const $overlay = document.getElementById('overlay');
const $toast = document.getElementById('toast');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowHM = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtClock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function hmToDate(hm, base = new Date()) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(base); d.setHours(h, m, 0, 0);
  return d;
}
const fmtHM = (hm) => fmtClock(hmToDate(hm));
function hmAdd(hm, mins) {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.max(0, Math.min(1439, h * 60 + m + mins));
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDay(key) {
  const today = dayKey();
  const t = new Date(); t.setDate(t.getDate() + 1);
  const label = parseDay(key).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (key === today) return `Today · ${label}`;
  if (key === dayKey(t)) return `Tomorrow · ${label}`;
  return label;
}
function fmtWhen(ts) {
  const d = new Date(ts);
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (dayKey(d) === dayKey()) return `Today at ${fmtClock(d)}`;
  if (dayKey(d) === dayKey(y)) return `Yesterday at ${fmtClock(d)}`;
  return `${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} at ${fmtClock(d)}`;
}
function partOfDay(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}
function season(d = new Date()) {
  const m = d.getMonth();
  if (m >= 2 && m <= 4) return 'Spring';
  if (m >= 5 && m <= 7) return 'Summer';
  if (m >= 8 && m <= 10) return 'Autumn';
  return 'Winter';
}
function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
  } catch { /* storage blocked */ }
  return null;
}
function local(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked */ }
  return null;
}
const route = () => location.hash.slice(1).split('/')[0] || 'home';

let toastTimer;
function toast(text) {
  $toast.textContent = text;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
}

// ================================================================ icons (ink line style)
const ICON = {
  day: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3.5h6v3H9z"/><path d="M8.5 12l2 2 4-4"/><path d="M8.5 17h7"/>',
  msg: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="16" cy="9" r="2"/><path d="M3 17l5-5 4 4 3-3 6 6"/>',
  family: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.3"/><path d="M15.5 14.2c2.4-.3 4.3 1.2 5 4.3"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.2"/>',
  med: '<path d="M10.5 3.5a5 5 0 017 7l-7 7a5 5 0 01-7-7z"/><path d="M7 7l7 7"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  about: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c1-4 4-6.5 7.5-6.5s6.5 2.5 7.5 6.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
  speak: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;

// ================================================================ sound & voice
// iPhones only allow sound after the person has touched the screen, and the
// silent switch mutes web audio. We "unlock" both on the first tap.
let audioCtx;
let audioUnlocked = false;
// One shared <audio> player for the warm (ElevenLabs) voice.
const voicePlayer = new Audio();
voicePlayer.preload = 'auto';
const SILENCE = (() => {
  // 0.1 s of silent WAV, made in code so nothing has to be downloaded.
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();
// Warm voice status, filled in at start-up.
const eleven = { enabled: false, voices: null, failedOnce: false };
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older Safari */ }

function unlockAudio(e) {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination);
    src.start(0);
  } catch { /* no audio */ }
  // Let the shared voice player play later without another tap (iPhone rule).
  try { voicePlayer.src = SILENCE; voicePlayer.play().catch(() => {}); } catch { /* ignore */ }
  // Prime speech with a silent utterance — unless this tap is itself a "read aloud" tap.
  if ('speechSynthesis' in window && !(e && e.target.closest && e.target.closest('[data-action="speak"]'))) {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }
}
['touchend', 'click', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));

// ---- Choosing a calm, natural voice ----
// Apple's free "Premium"/"Enhanced" voices (and Edge's "Natural" voices) sound
// close to a real person. Novelty and old robotic voices are filtered out.
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|wobble|eddy|flo\b|fred|good news|grandma|grandpa|jester|junior|organ|superstar|ralph|reed|rocko|sandy|shelley|trinoids|whisper|zarvox|kathy|deranged|hysterical|pipe|princess/i;
const CALM_NAMES = /ava|zoe|allison|susan|serena|kate|moira|karen|evan|nathan|tom|joelle|noelle|nicky|samantha|aria|jenny|libby|sonia|natasha/i;
let allVoices = [];
let voice = null;

function voiceQuality(v) {
  const n = v.name;
  if (/premium|natural|neural/i.test(n)) return 3;
  if (/enhanced/i.test(n)) return 2;
  if (/google/i.test(n)) return 1;
  return 0;
}
function voiceScore(v) {
  const lang = (navigator.language || 'en-US').toLowerCase();
  const vl = v.lang.toLowerCase().replace('_', '-');
  let s = voiceQuality(v) * 100;
  if (vl === lang) s += 40; else if (vl.startsWith(lang.slice(0, 2))) s += 20;
  if (CALM_NAMES.test(v.name)) s += 15;
  if (v.localService) s += 5; // works offline
  return s;
}
function goodVoices() {
  return allVoices
    .filter((v) => v.lang.toLowerCase().startsWith((navigator.language || 'en').slice(0, 2).toLowerCase()) && !NOVELTY.test(v.name))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  allVoices = speechSynthesis.getVoices();
  const list = goodVoices();
  voice = list.find((v) => v.name === settings.voiceName) || list[0] || null;
  if (route() === 'care' && location.hash.includes('settings') && $app.querySelector('#voice-pick')) render();
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

// Speak sentence by sentence: the short gaps between them make it slower and calmer.
let speakToken = 0;
async function authHeaders() {
  const { data } = await sb.auth.getSession();
  return { Authorization: `Bearer ${data.session ? data.session.access_token : SUPABASE_KEY}`, apikey: SUPABASE_KEY };
}
const elevenSpeed = () => ({ 0.75: 0.8, 0.85: 0.9, 0.95: 1.0 }[Number(settings.rate)] || 0.9);
function useEleven() {
  return eleven.enabled && settings.voiceEngine !== 'device' && settings.elevenVoiceId;
}
function stopSpeaking() {
  speakToken++;
  try { voicePlayer.pause(); } catch { /* ignore */ }
  if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
}

function speak(text, opts = {}) {
  if (!settings.voice || !text) return;
  if (!opts.device && (opts.elevenVoiceId || useEleven())) return speakEleven(text, opts);
  speakDevice(text, opts);
}

// Who reads what: "day", "reminder", "message", "other". A voice can be the warm narrator,
// a recorded family voice, or "rotate" (family voices take turns, a different one each day).
function voiceFor(purpose = 'other', opts = {}) {
  const n = settings.narration || {};
  const familyVoices = [...storeOf('voices').keys()];
  const known = (v) => v && (v === settings.elevenVoiceId || storeOf('voices').has(v));
  if (opts.senderVoice && known(opts.senderVoice)) return opts.senderVoice;
  let v = n[purpose] || n.other || settings.elevenVoiceId;
  if (v === 'rotate') {
    if (!familyVoices.length) return settings.elevenVoiceId;
    const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
    v = familyVoices.sort()[day % familyVoices.length];
  }
  return known(v) ? v : settings.elevenVoiceId;
}

async function speakEleven(text, opts = {}) {
  stopSpeaking();
  const token = speakToken;
  // Keep the player "awake" inside this tap so iPhone allows playing once the audio arrives.
  try { voicePlayer.src = SILENCE; voicePlayer.play().catch(() => {}); } catch { /* ignore */ }
  try {
    const r = await fetch(VOICE_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ text, voiceId: opts.elevenVoiceId || voiceFor(opts.purpose, opts), speed: opts.speed || elevenSpeed() }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Voice server said ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    if (token !== speakToken) { URL.revokeObjectURL(url); return; }
    voicePlayer.src = url;
    voicePlayer.onended = () => URL.revokeObjectURL(url);
    await voicePlayer.play();
  } catch (err) {
    console.warn('Warm voice unavailable, using device voice:', err);
    if (!eleven.failedOnce && session('care') === '1') toast(`Warm voice problem: ${err.message}`);
    eleven.failedOnce = true;
    if (token === speakToken) speakDevice(text, opts);
  }
}

function speakDevice(text, opts = {}) {
  if (!('speechSynthesis' in window)) return;
  const token = ++speakToken;
  try { voicePlayer.pause(); } catch { /* ignore */ }
  // Safari can drop an utterance that follows cancel(), so only cancel when needed.
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  speechSynthesis.resume();
  const v = opts.voice || voice;
  const sentences = String(text).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || [text];
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (token !== speakToken) break;
    const u = new SpeechSynthesisUtterance(s);
    u.lang = v ? v.lang : (navigator.language || 'en-US');
    if (v) u.voice = v;
    u.rate = opts.rate || Number(settings.rate) || 0.85;
    u.pitch = 0.95;
    speechSynthesis.speak(u); // queued: each sentence waits for the one before
  }
}

// Times and dates written the way a person would say them.
function spokenTime(d) {
  const h = d.getHours(), m = d.getMinutes();
  const h12 = h % 12 || 12;
  const when = h < 5 ? 'at night' : h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : h < 21 ? 'in the evening' : 'at night';
  if (h === 12 && m === 0) return "It's twelve noon";
  return `It's ${h12}${m ? ':' + pad(m) : " o'clock"} ${when}`;
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function spokenDate(d) {
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })}, ${d.toLocaleDateString('en-US', { month: 'long' })} ${ordinal(d.getDate())}`;
}

// Soft wind-chime for reminders (pentatonic notes).
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    [784, 659, 988].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.4;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.start(t); o.stop(t + 1.5);
    });
  } catch { /* audio unavailable */ }
}

// ================================================================ media (stored privately in Supabase Storage)
const urlCache = new Map(); // id -> { url, until }
async function mediaUrl(id) {
  if (!id) return '';
  const hit = urlCache.get(id);
  if (hit && hit.until > Date.now()) return hit.url;
  const m = storeOf('media').get(id);
  if (!m || !m.path) return '';
  const { data, error } = await sb.storage.from('media').createSignedUrl(m.path, 6 * 3600);
  if (error) { console.warn(error); return ''; }
  urlCache.set(id, { url: data.signedUrl, until: Date.now() + 5 * 3600 * 1000 });
  return data.signedUrl;
}
function forgetUrl(id) { urlCache.delete(id); }
async function saveMedia(file, caption = '', hidden = false, from = shortName(myName)) {
  const id = uid();
  const ext = String(file.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const path = `${circleId}/${id}${ext ? '.' + ext : ''}`;
  toast('Uploading…');
  const { error } = await sb.storage.from('media').upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(/exceed|too large|size/i.test(error.message) ? 'That file is too big (50 MB max).' : error.message);
  await put('media', { id, path, type: file.type || '', caption, hidden, from: shortName(from), at: Date.now() });
  return id;
}
const isVideo = (m) => (m.type || '').startsWith('video/');
// "Sarah (your daughter)" -> "Sarah"
const shortName = (s) => String(s || '').split(' (')[0].trim();
// Find the sender's face in Family (People) so the loved one recognizes who sent it.
async function faceFor(from) {
  const n = shortName(from).toLowerCase();
  if (!n) return '';
  const first = n.split(/\s+/)[0];
  const p = (await all('people')).find((x) => {
    const pn = String(x.name || '').toLowerCase();
    return pn === n || pn.split(/[\s(]/)[0] === first;
  });
  return p && p.photoId ? await mediaUrl(p.photoId) : '';
}
const joinNames = (names) => names.length <= 1 ? (names[0] || '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
// Photos added since this device last opened Photos.
function photosSeen() {
  let seen = local('photosSeen');
  if (typeof seen !== 'number') { seen = Date.now(); local('photosSeen', seen); }
  return seen;
}
const isAudio = (m) => (m.type || '').startsWith('audio/');
async function galleryItems() {
  return (await all('media')).filter((m) => !m.hidden && !isAudio(m)).sort((a, b) => b.at - a.at);
}
async function songs() {
  return (await all('media')).filter(isAudio).sort((a, b) => (a.caption || '').localeCompare(b.caption || ''));
}

// ================================================================ settings & seed
const DEFAULTS = {
  id: 'main', name: '', pin: '1234', scale: 1, voice: true, voiceName: '', rate: 0.85, voiceEngine: 'eleven', elevenVoiceId: '',
  city: '', lat: null, lon: null, place: '', units: 'fahrenheit', helpPersonId: '',
  about: { fullName: '', address: '', birthday: '', phone: '', facts: '' },
};
let settings = structuredClone(DEFAULTS);

function applySettings() {
  document.documentElement.style.setProperty('--scale', settings.scale || 1);
}

async function seedExamples(includeBasics) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (includeBasics) {
    const tasks = [
      ['08:00', '🍳', 'Eat breakfast'],
      ['10:00', '🚶', 'Go for a short walk'],
      ['12:30', '🥪', 'Eat lunch'],
      ['15:00', '💧', 'Drink a glass of water'],
      ['18:00', '🍽️', 'Eat dinner'],
      ['21:30', '🛏️', 'Get ready for bed'],
    ];
    for (const [time, ic, title] of tasks) await put('tasks', { id: uid(), time, icon: ic, title });
    await put('messages', {
      id: uid(), from: 'Your family', at: Date.now(), read: false, replies: [],
      text: 'Hello! This is your new companion. We will send you messages, photos and videos here.\n\nWe love you!',
    });
    await put('people', { id: uid(), name: 'Emma (example)', relation: 'Your granddaughter', phone: '' });
  }
  await put('meds', { id: uid(), name: 'Vitamin D (example)', dose: '1 small yellow tablet', purpose: 'For strong bones', times: ['08:30'] });
  await put('events', {
    id: uid(), title: 'Doctor visit (example)', date: dayKey(tomorrow), time: '10:30',
    place: 'Main Street Clinic', with: 'Sarah will drive you', note: 'Bring your glasses.',
  });
}

function mergeSettings(s) {
  return { ...structuredClone(DEFAULTS), ...(s || {}), about: { ...DEFAULTS.about, ...((s && s.about) || {}) } };
}
async function loadSettings() {
  const s = storeOf('settings').get('main');
  if (s) { settings = mergeSettings(s); return; }
  settings = mergeSettings({});
  await put('settings', settings);
  await seedExamples(true);
}

// ================================================================ the day's schedule
// Tasks, medicine doses and today's appointments, merged into one timeline.
async function todayItems() {
  const [tasks, meds, events, comps] = await Promise.all([all('tasks'), all('meds'), all('events'), all('completions')]);
  const today = dayKey();
  const doneMap = new Map(comps.filter((c) => c.date === today).map((c) => [c.taskId, c]));
  const items = [
    ...tasks.map((t) => ({ key: t.id, time: t.time, remindAt: t.time, icon: t.icon, title: t.title, kind: 'task' })),
    ...meds.flatMap((m) => (m.times || []).map((time) => ({
      key: `med:${m.id}:${time}`, time, remindAt: time, icon: '💊',
      title: `Take ${m.name}`, sub: m.dose, kind: 'med',
    }))),
    ...events.filter((e) => e.date === today).map((e) => ({
      key: `event:${e.id}`, time: e.time || '09:00', remindAt: hmAdd(e.time || '09:00', -60), icon: '📅',
      title: e.title, sub: [e.place, e.with].filter(Boolean).join(' · '), kind: 'event',
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  return { items, doneMap };
}

// ================================================================ the growing flower
// Today's flower grows with each finished task and blooms when everything is done.
// It never wilts: a bloom is added to the garden for good, and missed days just add nothing.
const FLOWER_COLORS = ['#e48aa0', '#f2a46b', '#e9c74f', '#b48ad6', '#ef8a7a', '#7fb0d9'];
const flowerColor = (day = dayKey()) => FLOWER_COLORS[Math.floor(parseDay(day).getTime() / 86400000) % FLOWER_COLORS.length];
function growthStage(done, total) {
  if (!total) return 0;
  if (done >= total) return 6;
  if (!done) return 0;
  return Math.min(5, Math.ceil((done / total) * 5)); // first task always shows a sprout
}
function plantSVG(stage, color = flowerColor()) {
  const h = [4, 16, 28, 40, 50, 56, 58][stage];
  const top = 90 - h;
  const leaf = (y, a, sc = 1) => `<path class="leaf" d="M0 0 C6 -7 17 -7 22 0 C17 7 6 7 0 0Z" transform="translate(50 ${y}) rotate(${a}) scale(${sc})"/>`;
  const leaves = stage === 0 ? '' : stage === 1 ? leaf(top + 3, -35, .55) + leaf(top + 3, -145, .55)
    : stage === 2 ? leaf(top + 8, -30, .8) + leaf(top + 12, -150, .8)
    : leaf(top + 14, -28) + leaf(top + 20, -152) + leaf(top + 32, -20, .85) + leaf(top + 38, -160, .85);
  let head = '';
  if (stage === 4) head = `<path d="M50 ${top - 12} C57 ${top - 6} 57 ${top + 2} 50 ${top + 3} C43 ${top + 2} 43 ${top - 6} 50 ${top - 12}Z" fill="${color}"/>`;
  if (stage === 5) head = [-30, 0, 30].map((a) => `<ellipse cx="50" cy="${top - 8}" rx="6" ry="11" fill="${color}" transform="rotate(${a} 50 ${top})"/>`).join('');
  if (stage === 6) head = `<g class="petals">${[0, 60, 120, 180, 240, 300].map((a) => `<ellipse cx="50" cy="${top - 11}" rx="7.5" ry="12" fill="${color}" transform="rotate(${a} 50 ${top})"/>`).join('')}
    <circle cx="50" cy="${top}" r="7" fill="#f6d36b"/><circle cx="50" cy="${top}" r="3.2" fill="#d99a2b"/></g>
    <g class="sparkle" fill="#e9b949"><path d="M18 30 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z"/><path d="M80 22 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5z"/></g>`;
  return `<svg class="plant stage-${stage}" viewBox="0 0 100 124" aria-hidden="true">
    <g class="sway">${stage ? `<path d="M50 90 Q${stage > 2 ? 47 : 49} ${90 - h / 2} 50 ${top}" stroke="#5e8a4c" stroke-width="3.2" fill="none" stroke-linecap="round"/>` : `<ellipse cx="50" cy="86" rx="4" ry="3" fill="#7aa35f"/>`}
    <g fill="#6f9a5b">${leaves}</g>${head}</g>
    <ellipse cx="50" cy="91" rx="27" ry="5" fill="#7a5340"/>
    <path d="M22 92 H78 L72 120 H28 Z" fill="#d98a64"/><rect x="19" y="88" width="62" height="9" rx="4" fill="#c9774f"/>
  </svg>`;
}
const miniFlower = (color) => `<svg class="mini-flower" viewBox="0 0 24 24" aria-hidden="true">${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="12" cy="6.5" rx="3.6" ry="5.5" fill="${color}" transform="rotate(${a} 12 12)"/>`).join('')}<circle cx="12" cy="12" r="3.2" fill="#f6d36b"/></svg>`;
async function gardenHtml(done, total, link = true) {
  if (!total) return '';
  const stage = growthStage(done, total);
  const blooms = (await all('garden')).sort((a, b) => a.date.localeCompare(b.date));
  const title = stage === 6 ? 'Your flower bloomed!' : done ? 'Your flower is growing' : 'Your flower is waiting to grow';
  const sub = stage === 6 ? 'You did everything today. Wonderful.' : `${done} of ${total} done today`;
  // Play the bloom animation on the first view after blooming (and through any quick re-render).
  const shown = local('bloomShown');
  const justBloomed = stage === 6 && (!shown || shown.day !== dayKey() || Date.now() - shown.at < 8000);
  if (stage === 6 && (!shown || shown.day !== dayKey())) local('bloomShown', { day: dayKey(), at: Date.now() });
  const tag = link ? 'a' : 'div';
  return `<${tag} class="paper garden-card${justBloomed ? ' just-bloomed' : ''}"${link ? ' href="#day"' : ''}>
      <div class="garden-row">${plantSVG(stage)}
        <div><div class="garden-title">${title}</div><div class="garden-sub">${sub}</div></div></div>
      ${blooms.length ? `<div class="garden-strip" aria-label="${blooms.length} flowers in your garden">
        ${blooms.slice(-14).map((b) => miniFlower(b.color || flowerColor(b.date))).join('')}
        <span>${blooms.length === 1 ? '1 flower' : blooms.length + ' flowers'} in your garden</span></div>` : ''}
    </${tag}>`;
}

function focusItem(items, doneMap, now = new Date()) {
  const hourAgo = now.getHours() === 0 ? '00:00' : nowHM(new Date(now.getTime() - 60 * 60 * 1000));
  return items.find((t) => !doneMap.has(t.key) && t.time >= hourAgo);
}

// ================================================================ weather (Open-Meteo, no key needed)
let weather = local('weather');
let weatherTried = 0;
const WEATHER = [
  [[0], '☀️', 'Clear and sunny'], [[1, 2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Foggy'], [[51, 53, 55, 56, 57], '🌦️', 'Light rain'],
  [[61, 63, 65, 66, 67, 80, 81, 82], '🌧️', 'Rainy'], [[71, 73, 75, 77, 85, 86], '❄️', 'Snowy'],
  [[95, 96, 99], '⛈️', 'Thunderstorms'],
];
const weatherInfo = (code) => WEATHER.find(([codes]) => codes.includes(code)) || [[], '🌤️', 'Mild'];
function weatherAdvice(w) {
  const f = settings.units === 'celsius' ? w.temp * 9 / 5 + 32 : w.temp;
  const tips = [];
  if (f < 40) tips.push('Wear a warm coat, hat and gloves');
  else if (f < 55) tips.push('Wear a warm jacket');
  else if (f < 68) tips.push('A light sweater is a good idea');
  else if (f < 85) tips.push('Light clothes are fine today');
  else tips.push('It is hot — drink extra water');
  if ([71, 73, 75, 77, 85, 86].includes(w.code)) tips.push('it may be slippery outside');
  else if (w.rain >= 50 || [61, 63, 65, 80, 81, 82, 95].includes(w.code)) tips.push('take an umbrella');
  return tips.join(', and ') + '.';
}
async function refreshWeather() {
  if (settings.lat == null) return;
  const fresh = weather && weather.lat === settings.lat && Date.now() - weather.at < 30 * 60 * 1000;
  if (fresh || Date.now() - weatherTried < 5 * 60 * 1000) return;
  weatherTried = Date.now();
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${settings.lat}&longitude=${settings.lon}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=${settings.units === 'celsius' ? 'celsius' : 'fahrenheit'}&timezone=auto&forecast_days=1`;
    const j = await (await fetch(u)).json();
    weather = {
      at: Date.now(), lat: settings.lat,
      temp: Math.round(j.current.temperature_2m), code: j.current.weather_code,
      hi: Math.round(j.daily.temperature_2m_max[0]), lo: Math.round(j.daily.temperature_2m_min[0]),
      rain: j.daily.precipitation_probability_max?.[0] ?? 0,
    };
    local('weather', weather);
    if (route() === 'home') render();
  } catch (err) { console.warn('Weather unavailable', err); }
}
async function geocode(city) {
  const [name, ...rest] = city.split(',').map((s) => s.trim());
  const region = rest.join(' ').toLowerCase();
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`);
  const j = await r.json();
  const list = j.results || [];
  const match = (region && list.find((p) => [p.admin1, p.country, p.country_code].some((x) => x && x.toLowerCase().startsWith(region)))) || list[0];
  return match ? { lat: match.latitude, lon: match.longitude, place: [match.name, match.admin1].filter(Boolean).join(', ') } : null;
}

// ================================================================ shared UI bits
const topbar = (title, back = '#home', backLabel = 'Home') => `
  <div class="topbar">
    <a class="btn home-btn" href="${back}">${icon(back === '#home' ? 'home' : 'back')} ${esc(backLabel)}</a>
    <h1>${esc(title)}</h1>
  </div>`;
const speakBtn = (text, label = 'Read to me', o = {}) =>
  `<button class="btn" data-action="speak" data-text="${esc(text)}"${o.purpose ? ` data-purpose="${esc(o.purpose)}"` : ''}${o.voice ? ` data-voice="${esc(o.voice)}"` : ''}>${icon('speak')} ${esc(label)}</button>`;
const empty = (ic, text, hint = '') =>
  `<div class="empty"><div class="empty-ic">${icon(ic)}</div><p>${esc(text)}</p>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}</div>`;
const avatar = (url, name) => `<div class="avatar">${url ? `<img src="${url}" alt="">` : esc((name || '?').trim()[0] || '?')}</div>`;

// ================================================================ companion screens
async function viewHome() {
  const now = new Date();
  const [{ items, doneMap }, messages, events, gallery, people] =
    await Promise.all([todayItems(), all('messages'), all('events'), galleryItems(), all('people')]);
  refreshWeather();

  const part = partOfDay(now);
  const dayText = now.toLocaleDateString([], { weekday: 'long' });
  const dateText = now.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  const greet = `Good ${part}${settings.name ? `, ${settings.name}` : ''}`;
  const open = items.filter((t) => !doneMap.has(t.key));
  const focus = focusItem(items, doneMap, now);
  const unread = messages.filter((m) => !m.read).length;
  const latest = messages.sort((a, b) => b.at - a.at)[0];
  const today = dayKey();
  const nowStr = nowHM(now);
  const upcoming = events
    .filter((e) => e.date > today || (e.date === today && (e.time || '23:59') >= nowStr))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .slice(0, 2);
  const photos = gallery.filter((m) => !isVideo(m));
  const seen = photosSeen();
  const fresh = gallery.filter((m) => m.at > seen);
  const freshFrom = [...new Set(fresh.map((m) => shortName(m.from)).filter(Boolean))];
  const freshWho = freshFrom.length ? joinNames(freshFrom) : 'your family';
  const memory = photos.length ? photos[Math.floor(now.getTime() / 86400000) % photos.length] : null;
  const w = weather && weather.lat === settings.lat && settings.lat != null ? weather : null;
  const [, wIcon, wText] = w ? weatherInfo(w.code) : [];

  const sayDay = [
    `${greet}.`,
    `Today is ${spokenDate(now)}.`,
    `${spokenTime(now)}.`,
    w ? `Outside, it's ${w.temp} degrees and ${wText.toLowerCase()}. ${weatherAdvice(w)}` : '',
    focus ? (focus.time <= nowStr ? `Right now, it's time to ${focus.title.charAt(0).toLowerCase() + focus.title.slice(1)}.`
                                  : `Next, at ${fmtHM(focus.time)}, you'll ${focus.title.charAt(0).toLowerCase() + focus.title.slice(1)}.`)
          : (items.length && !open.length ? 'You have done everything for today. Well done.' : ''),
    upcoming[0] ? `${upcoming[0].date === today ? 'Later today' : fmtDay(upcoming[0].date).split(' · ')[0]}, you have ${upcoming[0].title}${upcoming[0].time ? ' at ' + fmtHM(upcoming[0].time) : ''}.` : '',
    unread ? `You have ${unread === 1 ? 'a new message' : unread + ' new messages'} from your family.` : '',
    fresh.length ? `${freshFrom.length ? freshWho : 'Your family'} sent you ${fresh.length === 1 ? 'a new photo' : fresh.length + ' new photos'}.` : '',
    'Have a lovely day.',
  ].filter(Boolean).join(' ');

  const focusHtml = focus
    ? `<a class="now-card" href="#day">
         <span class="now-ic">${esc(focus.icon)}</span>
         <span class="now-body"><span class="kicker">${focus.time <= nowStr ? 'Right now' : 'Next · ' + fmtHM(focus.time)}</span>
         <span class="now-title">${esc(focus.title)}</span></span><span class="chev">›</span></a>`
    : open.length
      ? `<a class="now-card calm" href="#day"><span class="now-ic">${open.length ? '🍵' : '🌸'}</span>
           <span class="now-body"><span class="kicker">${open.length ? 'Nothing right now' : 'All done'}</span>
           <span class="now-title">${open.length ? 'Time to rest and relax' : 'You finished everything today'}</span></span></a>`
      : '';

  // Photo hero: the newest photo from family, otherwise today's memory.
  const heroPic = fresh[0] || memory;
  let heroHtml = '';
  if (heroPic) {
    const url = await mediaUrl(heroPic.id);
    const from = shortName(heroPic.from);
    const who = fresh.length ? freshFrom : (from ? [from] : []);
    const face = who.length === 1 ? avatar(await faceFor(who[0]), who[0]).replace('class="avatar"', 'class="avatar sm"') : '';
    const title = fresh.length ? `From ${freshWho}` : (heroPic.caption || (from ? `From ${from}` : 'A memory for today'));
    const sub = fresh.length ? `${fresh.length === 1 ? 'A new photo' : fresh.length + ' new photos'} · tap to see`
      : (heroPic.caption && from ? `From ${from}` : 'A memory for today');
    heroHtml = `
      ${isVideo(heroPic) ? `<video class="hero-img" src="${url}#t=0.5" muted playsinline preload="metadata"></video>` : `<img class="hero-img" src="${url}" alt="">`}
      <a class="hero-from" href="${fresh.length ? '#photos' : '#photo/' + heroPic.id}">${face}
        <span><span class="hf-title">${esc(title)}</span><span class="hf-sub">${esc(sub)}</span></span>
        ${fresh.length ? `<span class="new-pill">New</span>` : ''}</a>`;
  }

  const faces = people.filter((p) => p.name).sort((x, y) => x.name.localeCompare(y.name)).slice(0, 8);
  const facesHtml = faces.length ? `
    <nav class="faces" aria-label="Family">${(await Promise.all(faces.map(async (p) => `
      <a class="face" href="#people">${avatar(await mediaUrl(p.photoId), p.name).replace('class="avatar"', 'class="avatar md"')}
        <span class="face-name">${esc(shortName(p.name).split(' ')[0])}</span></a>`))).join('')}
    </nav>` : '';

  const latestHtml = latest ? `
    <a class="paper latest ${latest.read ? '' : 'unread'}" href="#message/${latest.id}">
      <div class="section-label">${latest.read ? 'Latest message' : 'New message'}</div>
      <div class="latest-row">
        ${latest.mediaId ? `<img class="latest-thumb" src="${await mediaUrl(latest.mediaId)}" alt="">` : `<span class="latest-ic">${icon('msg')}</span>`}
        <div><div class="latest-from">${esc(latest.from)}</div><div class="latest-text">${esc(latest.text)}</div></div>
      </div>
    </a>` : '';

  const upcomingHtml = upcoming.length ? `
    <a class="paper" href="#calendar">
      <div class="section-label">Coming up</div>
      ${upcoming.map((e) => `
        <div class="up-row"><span class="up-date"><b>${parseDay(e.date).getDate()}</b>${parseDay(e.date).toLocaleDateString([], { month: 'short' })}</span>
        <span><span class="up-title">${esc(e.title)}</span><span class="up-when">${esc(fmtDay(e.date))}${e.time ? ' · ' + fmtHM(e.time) : ''}</span></span></div>`).join('')}
    </a>` : '';

  const tile = (href, ic, name, sub, cls, badge = 0) => `
    <a class="tile ${cls}" href="${href}">${badge ? `<span class="badge">${badge}</span>` : ''}
      <span class="tile-ic">${icon(ic)}</span><span class="tile-name">${name}</span><span class="tile-sub">${sub}</span></a>`;

  const familyStrip = myRole === 'family'
    ? `<a class="family-strip" href="#care">${icon('gear')} You're seeing ${esc(settings.name || 'their')}${settings.name ? "'s" : ''} screen · <b>Family tools</b></a>` : '';
  return `${familyStrip}
    <header class="hero ${heroPic ? 'has-photo' : 'sky-' + part}">
      ${heroHtml}
      <div class="hero-top">
        <div><div class="day">${esc(dayText)}</div><div class="date">${esc(dateText)}</div></div>
        <div class="clock" data-clock>${fmtClock(now)}</div>
      </div>
      ${heroPic ? '' : `<div class="greet">${esc(greet)}</div>`}
    </header>

    ${facesHtml}

    <button class="say-day" data-action="speak" data-purpose="day" data-text="${esc(sayDay)}">${icon('speak')} Read me the day</button>

    ${await gardenHtml(items.length - open.length, items.length)}

    ${w ? `<div class="weather"><span class="w-ic">${wIcon}</span>
      <span><span class="w-temp">${w.temp}°</span> <span class="w-text">${esc(wText)}</span>
      <span class="w-tip">${esc(weatherAdvice(w))}</span></span>
      <span class="w-hilo">H ${w.hi}°<br>L ${w.lo}°</span></div>` : ''}

    ${focusHtml}

    <nav class="tiles" aria-label="Main menu">
      ${tile('#day', 'day', 'My Day', `${items.length - open.length} of ${items.length} done`, 't-ai')}
      ${tile('#messages', 'msg', 'Messages', unread ? `${unread} new` : 'From family', 't-shu', unread)}
      ${tile('#photos', 'photo', 'Photos', fresh.length ? `${fresh.length} new` : '&amp; videos', 't-kin', fresh.length)}
      ${tile('#people', 'family', 'Family', 'Call or see', 't-fuji')}
      ${tile('#meds', 'med', 'Medicines', 'What to take', 't-matcha')}
      ${tile('#calendar', 'cal', 'Calendar', upcoming[0] ? esc(fmtDay(upcoming[0].date).split(' · ')[0]) : 'Appointments', 't-sora')}
      ${tile('#music', 'music', 'Music', 'Favorite songs', 't-sakura')}
      ${tile('#about', 'about', 'About Me', 'My details', 't-cha')}
    </nav>

    <a class="help-btn" href="#help">${icon('phone')} I need help</a>

    ${upcomingHtml}
    ${latestHtml}

    <div class="care-entry"><a class="btn small ghost" href="#care">${icon('gear')} Family settings</a></div>`;
}

async function viewDay() {
  const { items, doneMap } = await todayItems();
  if (!items.length) return topbar('My Day') + empty('day', 'Nothing planned today.');
  const now = nowHM();
  const focus = focusItem(items, doneMap);
  const open = items.filter((t) => !doneMap.has(t.key));
  const later = open.filter((t) => t !== focus && t.time > now);
  const earlier = open.filter((t) => t !== focus && t.time <= now);
  const finished = items.filter((t) => doneMap.has(t.key));
  const done = finished.length;

  const row = (t, kind) => {
    const c = doneMap.get(t.key);
    return `
      <div class="task-row ${kind}">
        <span class="t-ic">${esc(t.icon)}</span>
        <span class="t-body"><span class="t-time">${c ? `Done at ${fmtClock(new Date(c.at))}` : fmtHM(t.time)}</span>
          <span class="t-title">${esc(t.title)}</span>${t.sub && !c ? `<span class="t-sub">${esc(t.sub)}</span>` : ''}</span>
        ${c
          ? `<button class="check on" data-action="undo" data-id="${esc(t.key)}" aria-label="Undo ${esc(t.title)}">${icon('check')}</button>`
          : `<button class="check" data-action="done" data-id="${esc(t.key)}" aria-label="Mark ${esc(t.title)} as done"></button>`}
      </div>`;
  };
  const section = (title, list, kind) => list.length
    ? `<div class="section-label">${title}</div><div class="paper list">${list.map((t) => row(t, kind)).join('')}</div>` : '';

  const focusHtml = focus ? `
    <div class="focus">
      <div class="kicker">${focus.time <= now ? 'Right now' : 'Next · ' + fmtHM(focus.time)}</div>
      <div class="focus-ic">${esc(focus.icon)}</div>
      <div class="focus-title">${esc(focus.title)}</div>
      ${focus.sub ? `<div class="focus-sub">${esc(focus.sub)}</div>` : ''}
      <button class="btn good big" data-action="done" data-id="${esc(focus.key)}">${icon('check')} I did it</button>
    </div>` : `
    <div class="focus calm"><div class="focus-ic">${open.length ? '🍵' : '🌸'}</div>
      <div class="focus-title">${open.length ? 'Nothing to do right now' : 'All done for today'}</div></div>`;

  return topbar('My Day') + `
    ${await gardenHtml(done, items.length, false)}
    ${focusHtml}
    ${section('Later today', later, 'later')}
    ${section('Earlier — not checked off', earlier, 'earlier')}
    ${section('Done', finished, 'done')}`;
}

async function viewMessages() {
  const msgs = (await all('messages')).sort((a, b) => b.at - a.at);
  if (!msgs.length) return topbar('Messages') + empty('msg', 'No messages yet.');
  const rows = await Promise.all(msgs.map(async (m) => `
    <a class="paper msg ${m.read ? '' : 'unread'}" href="#message/${m.id}">
      ${m.mediaId ? `<img class="latest-thumb" src="${await mediaUrl(m.mediaId)}" alt="">` : `<span class="latest-ic">${icon('msg')}</span>`}
      <span class="msg-body">
        <span class="msg-from">${esc(m.from)}${m.read ? '' : '<span class="new-pill">New</span>'}</span>
        <span class="msg-when">${fmtWhen(m.at)}</span>
        <span class="msg-preview">${esc(m.text)}</span>
      </span>
    </a>`));
  return topbar('Messages') + rows.join('');
}

const QUICK_REPLIES = ['I love you ❤️', 'Thank you! 😊', 'Please call me 📞', 'Okay 👍'];

async function viewMessage(id) {
  const m = await get('messages', id);
  if (!m) return viewMessages();
  if (!m.read) { m.read = true; await put('messages', m); }
  let mediaHtml = '';
  if (m.mediaId) {
    const media = await get('media', m.mediaId);
    const url = await mediaUrl(m.mediaId);
    if (media && url) {
      mediaHtml = `<div class="media">${isVideo(media)
        ? `<video src="${url}" controls playsinline></video>`
        : `<img src="${url}" alt="${esc(media.caption || 'Photo from ' + m.from)}">`}</div>`;
    }
  }
  const replies = (m.replies || []).map((r) => `<div class="reply">You replied: <strong>${esc(r.text)}</strong> · ${fmtWhen(r.at)}</div>`).join('');
  return topbar('', '#messages', 'Messages') + `
    <article class="paper letter">
      <div class="kicker">From</div>
      <h2>${esc(m.from)}</h2>
      <div class="msg-when">${fmtWhen(m.at)}</div>
      <div class="letter-text">${esc(m.text)}</div>
      ${mediaHtml}
      <div class="btn-row">${speakBtn(m.voiceId && storeOf('voices').has(m.voiceId) ? m.text : `Message from ${m.from}. ${m.text}`, 'Read to me', { purpose: 'message', voice: m.voiceId })}</div>
    </article>
    <div class="paper">
      <div class="section-label">Send a reply</div>
      <div class="reply-grid">${QUICK_REPLIES.map((r) =>
        `<button class="btn big" data-action="reply" data-id="${m.id}" data-text="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      <div class="replies">${replies}</div>
    </div>`;
}

async function viewPhotos() {
  const items = await galleryItems();
  if (!items.length) return topbar('Photos') + empty('photo', 'No photos yet.', 'Your family can add photos and videos in Family settings.');
  const seen = photosSeen();
  local('photosSeen', Date.now());
  const cards = await Promise.all(items.map(async (m) => {
    const url = await mediaUrl(m.id);
    return `<a class="thumb" href="#photo/${m.id}"><div class="frame">${isVideo(m)
      ? `<video src="${url}#t=0.5" muted playsinline preload="metadata"></video><span class="play">${icon('play')}</span>`
      : `<img src="${url}" alt="${esc(m.caption)}" loading="lazy">`}</div>
      ${m.at > seen ? '<span class="new-pill on-photo">New</span>' : ''}
      <div class="cap">${esc(m.caption || ' ')}${m.from ? `<span class="cap-from">From ${esc(shortName(m.from))}</span>` : ''}</div></a>`;
  }));
  return topbar('Photos') + `<div class="gallery">${cards.join('')}</div>`;
}

async function viewPhoto(id) {
  const items = await galleryItems();
  const i = items.findIndex((m) => m.id === id);
  if (i < 0) return viewPhotos();
  const m = items[i];
  const url = await mediaUrl(m.id);
  const prev = items[i - 1], next = items[i + 1];
  return topbar('', '#photos', 'All photos') + `
    <div class="viewer">
      <div class="frame">${isVideo(m)
        ? `<video src="${url}" controls playsinline autoplay></video>`
        : `<img src="${url}" alt="${esc(m.caption)}">`}</div>
      ${m.from ? `<div class="from-row">${avatar(await faceFor(m.from), m.from).replace('class="avatar"', 'class="avatar sm"')}
        <div><div class="from-name">From ${esc(shortName(m.from))}</div><div class="msg-when">${fmtWhen(m.at)}</div></div></div>` : ''}
      ${m.caption ? `<div class="caption">${esc(m.caption)}</div>` : ''}
      ${m.from ? '' : `<div class="msg-when">Added ${fmtWhen(m.at)}</div>`}
      ${m.caption || m.from ? `<div class="btn-row">${speakBtn([m.from ? `${shortName(m.from)} sent you this.` : '', m.caption].filter(Boolean).join(' '))}</div>` : ''}
      <div class="nav">
        ${prev ? `<a class="btn big" href="#photo/${prev.id}">‹ Newer</a>` : '<span></span>'}
        ${next ? `<a class="btn big" href="#photo/${next.id}">Older ›</a>` : '<span></span>'}
      </div>
    </div>`;
}

const telOf = (p) => (p.phone || '').replace(/[^\d+]/g, '');

async function viewPeople() {
  const people = (await all('people')).sort((a, b) => a.name.localeCompare(b.name));
  if (!people.length) return topbar('Family') + empty('family', 'No people added yet.');
  const cards = await Promise.all(people.map(async (p) => {
    const url = await mediaUrl(p.photoId);
    const phone = telOf(p);
    return `
      <div class="paper">
        <div class="person">${avatar(url, p.name)}
          <div><div class="p-name">${esc(p.name)}</div><div class="p-rel">${esc(p.relation)}</div></div></div>
        <div class="btn-row">
          ${phone ? `<a class="btn primary big" href="tel:${esc(phone)}">${icon('phone')} Call</a>
                     <a class="btn big" href="facetime:${esc(phone)}">${icon('video')} Video</a>` : ''}
          ${speakBtn(`This is ${p.name}. ${p.relation || ''}`, 'Who is this?')}
        </div>
      </div>`;
  }));
  return topbar('Family') + cards.join('');
}

async function viewMeds() {
  const [meds, { doneMap }] = await Promise.all([all('meds'), todayItems()]);
  if (!meds.length) return topbar('Medicines') + empty('med', 'No medicines listed.', 'Your family can add them in Family settings.');
  const now = nowHM();
  meds.sort((a, b) => (a.times[0] || '').localeCompare(b.times[0] || ''));
  const cards = await Promise.all(meds.map(async (m) => {
    const url = await mediaUrl(m.photoId);
    const doses = (m.times || []).map((t) => {
      const key = `med:${m.id}:${t}`;
      const c = doneMap.get(key);
      return `<div class="dose ${c ? 'taken' : t <= now ? 'due' : ''}">
        <span class="dose-time">${fmtHM(t)}</span>
        <span class="dose-status">${c ? `Taken at ${fmtClock(new Date(c.at))}` : t <= now ? 'Not taken yet' : 'Later today'}</span>
        ${c ? `<button class="check on" data-action="undo" data-id="${esc(key)}" aria-label="Undo">${icon('check')}</button>`
            : `<button class="btn good" data-action="done" data-id="${esc(key)}">${icon('check')} Taken</button>`}
      </div>`;
    }).join('');
    return `
      <div class="paper med">
        <div class="med-head">
          <div class="med-pic">${url ? `<img src="${url}" alt="">` : '💊'}</div>
          <div><div class="p-name">${esc(m.name)}</div>
            ${m.dose ? `<div class="p-rel">${esc(m.dose)}</div>` : ''}
            ${m.purpose ? `<div class="med-purpose">${esc(m.purpose)}</div>` : ''}</div>
        </div>
        ${doses}
        <div class="btn-row">${speakBtn(`${m.name}. ${m.dose || ''}. ${m.purpose || ''}. Take it at ${(m.times || []).map(fmtHM).join(' and ')}.`)}</div>
      </div>`;
  }));
  return topbar('Medicines') + cards.join('');
}

async function viewCalendar() {
  const today = dayKey();
  const events = (await all('events')).filter((e) => e.date >= today)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  if (!events.length) return topbar('Calendar') + empty('cal', 'No appointments coming up.');
  let lastDay = '';
  const html = events.map((e) => {
    const head = e.date !== lastDay ? `<div class="section-label">${esc(fmtDay(e.date))}</div>` : '';
    lastDay = e.date;
    const say = `${e.title}, ${fmtDay(e.date).replace(' · ', ', ')}${e.time ? ' at ' + fmtHM(e.time) : ''}. ${e.place ? 'At ' + e.place + '.' : ''} ${e.with || ''} ${e.note || ''}`;
    return head + `
      <div class="paper event">
        <div class="ev-time">${e.time ? fmtHM(e.time) : 'All day'}</div>
        <div class="ev-title">${esc(e.title)}</div>
        ${e.place ? `<div class="ev-line">📍 ${esc(e.place)}</div>` : ''}
        ${e.with ? `<div class="ev-line">👤 ${esc(e.with)}</div>` : ''}
        ${e.note ? `<div class="ev-note">${esc(e.note)}</div>` : ''}
        <div class="btn-row">${speakBtn(say)}</div>
      </div>`;
  }).join('');
  return topbar('Calendar') + html;
}

// ---- Music links from YouTube, Spotify and Apple Music ----
// YouTube plays full songs inside the app. Spotify and Apple Music only allow
// 30-second previews on web pages, so they also get an "open the app" button.
function parseMusicLink(raw) {
  let u;
  const s = String(raw || '').trim();
  const sp = s.match(/^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)/);
  if (sp) return { provider: 'spotify', embed: `https://open.spotify.com/embed/${sp[1]}/${sp[2]}`, open: `https://open.spotify.com/${sp[1]}/${sp[2]}`, url: `https://open.spotify.com/${sp[1]}/${sp[2]}`, tall: sp[1] !== 'track' };
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    let vid = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
    if (m) vid = m[1];
    vid = (vid || '').split('/')[0];
    if (vid && /^[\w-]{6,}$/.test(vid)) return { provider: 'youtube', embed: `https://www.youtube-nocookie.com/embed/${vid}?rel=0&playsinline=1${list ? '&list=' + encodeURIComponent(list) : ''}`, open: `https://www.youtube.com/watch?v=${vid}`, url: u.href };
    if (list) return { provider: 'youtube', embed: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}&rel=0&playsinline=1`, open: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`, url: u.href };
    return null;
  }
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/^\/(?:intl-[\w-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/);
    if (m) return { provider: 'spotify', embed: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, open: `https://open.spotify.com/${m[1]}/${m[2]}`, url: u.href, tall: m[1] !== 'track' };
    return null;
  }
  if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
    if (!/\/(album|playlist|song|station|music-video)\//.test(u.pathname)) return null;
    const isSong = u.searchParams.has('i') || /\/song\//.test(u.pathname);
    return { provider: 'apple', embed: `https://embed.music.apple.com${u.pathname}${u.search}`, open: `https://music.apple.com${u.pathname}${u.search}`, url: u.href, tall: !isSong };
  }
  return null;
}
const SERVICE = { youtube: 'YouTube', spotify: 'Spotify', apple: 'Apple Music' };

let nowPlaying = null; // { id, audio }
function stopMusic() {
  if (nowPlaying) { nowPlaying.audio.pause(); nowPlaying = null; }
}
async function viewMusic(id) {
  const links = (await all('music')).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  if (id) return viewMusicPlayer(links.find((m) => m.id === id));
  const list = await songs();
  if (!list.length && !links.length) return topbar('Music') + empty('music', 'No songs yet.', 'Your family can add favorite songs in Family settings.');
  const linkCards = links.map((m) => `
    <a class="paper song-link" href="#music/${m.id}">
      <span class="cover">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : icon('music')}</span>
      <span class="song-body"><span class="song-title">${esc(m.title || 'Song')}</span>
        ${m.artist ? `<span class="song-artist">${esc(m.artist)}</span>` : ''}
        <span class="svc svc-${m.provider}">${SERVICE[m.provider] || ''}</span></span>
      <span class="play-pill">${icon('play')} Play</span>
    </a>`).join('');
  return topbar('Music') + linkCards + list.map((s) => {
    const playing = nowPlaying && nowPlaying.id === s.id && !nowPlaying.audio.paused;
    return `<div class="paper song">
      <span class="song-ic">${icon('music')}</span>
      <span class="song-title">${esc(s.caption || 'Song')}</span>
      <button class="btn primary big song-btn" data-action="song" data-id="${s.id}">${playing ? `${icon('pause')} Pause` : `${icon('play')} Play`}</button>
    </div>`;
  }).join('');
}

function viewMusicPlayer(m) {
  if (!m) return topbar('Music', '#music', 'Music') + empty('music', 'That song is no longer here.');
  const p = parseMusicLink(m.url) || m;
  const height = p.provider === 'youtube' ? null : p.provider === 'spotify' ? (p.tall ? 452 : 352) : (p.tall ? 450 : 175);
  const appName = SERVICE[p.provider];
  return topbar('', '#music', 'All music') + `
    <div class="player">
      <h1 class="player-title">${esc(m.title || 'Song')}</h1>
      ${m.artist ? `<div class="song-artist big">${esc(m.artist)}</div>` : ''}
      <div class="embed ${p.provider === 'youtube' ? 'embed-video' : ''}" ${height ? `style="height:${height}px"` : ''}>
        <iframe src="${esc(p.embed)}" title="${esc(m.title || 'Music player')}" loading="eager"
          allow="autoplay; encrypted-media; clipboard-write; fullscreen; picture-in-picture" allowfullscreen></iframe>
      </div>
      <p class="player-hint">${p.provider === 'youtube' ? 'Tap the picture to play.' : `Tap play for a short preview, or play the whole song in the ${appName} app.`}</p>
      <div class="btn-row">
        ${p.provider !== 'youtube' ? `<a class="btn primary big" href="${esc(p.open)}" target="_blank" rel="noopener">${icon('play')} Play full song in ${appName}</a>` : ''}
        ${speakBtn(`${m.title || 'This song'}${m.artist ? ', by ' + m.artist : ''}.`, 'What song is this?')}
      </div>
    </div>`;
}

function viewAbout() {
  const a = settings.about;
  const name = a.fullName || settings.name;
  const facts = (a.facts || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const rows = [
    ['Your name', name], ['Your home', a.address], ['Your birthday', a.birthday], ['Your phone number', a.phone],
  ].filter(([, v]) => v);
  if (!rows.length && !facts.length) return topbar('About Me') + empty('about', 'Nothing here yet.', 'Your family can fill this in under Family settings.');
  const say = rows.map(([k, v]) => `${k} is ${v}.`).join(' ') + ' ' + facts.join('. ');
  return topbar('About Me') + `
    <div class="paper about">
      ${rows.map(([k, v]) => `<div class="about-row"><div class="kicker">${esc(k)}</div><div class="about-val">${esc(v)}</div></div>`).join('')}
    </div>
    ${facts.length ? `<div class="section-label">Good to remember</div>
      <div class="paper about">${facts.map((f) => `<div class="fact">${esc(f)}</div>`).join('')}</div>` : ''}
    <div class="btn-row">${speakBtn(say, 'Read it all to me')}</div>`;
}

async function viewHelp() {
  const people = await all('people');
  const helper = people.find((p) => p.id === settings.helpPersonId && telOf(p)) || people.find((p) => telOf(p));
  const others = people.filter((p) => p !== helper && telOf(p));
  const addr = settings.about.address;
  const helperUrl = helper ? await mediaUrl(helper.photoId) : '';
  return topbar('Help') + `
    <div class="help-hero">
      <div class="help-big">It's okay.</div>
      <div>Take a slow breath. Help is one tap away.</div>
    </div>
    ${helper ? `
      <a class="call-card" href="tel:${esc(telOf(helper))}">
        ${avatar(helperUrl, helper.name)}
        <span><span class="kicker">Call</span><span class="call-name">${esc(helper.name)}</span><span class="p-rel">${esc(helper.relation)}</span></span>
        <span class="call-ic">${icon('phone')}</span>
      </a>` : `<div class="paper"><p class="hint">Family can add phone numbers in Family settings so a Call button appears here.</p></div>`}
    ${others.length ? `<div class="btn-row">${others.map((p) =>
      `<a class="btn big" href="tel:${esc(telOf(p))}">${icon('phone')} Call ${esc(p.name)}</a>`).join('')}</div>` : ''}
    ${addr ? `<div class="paper"><div class="kicker">You are at home here</div><div class="about-val">${esc(addr)}</div>
      <div class="btn-row">${speakBtn(`You are safe. Your address is ${addr}.`, 'Read my address')}</div></div>` : ''}
    <a class="btn danger big emergency" href="tel:911">Emergency — call 911</a>`;
}

// ================================================================ family (caregiver) mode
const CARE_TABS = [
  ['activity', 'Today'], ['circle', 'Family & devices'], ['messages', 'Send message'], ['photos', 'Photos & videos'], ['voices', 'Voices'],
  ['tasks', 'Daily tasks'], ['meds', 'Medicines'], ['calendar', 'Calendar'], ['music', 'Music'],
  ['people', 'People'], ['about', 'About & help'], ['settings', 'Settings'],
];

async function viewCare(tab = 'activity') {
  if (myRole !== 'family' && session('care') !== '1') {
    return topbar('Family settings') + `
      <form class="paper pin-box stack" data-form="pin">
        <h2>Enter family PIN</h2>
        <p class="hint">This area is for caregivers and family. The starting PIN is 1234 — change it in Settings.</p>
        <input type="password" name="pin" inputmode="numeric" autocomplete="off" aria-label="PIN" autofocus>
        <button class="btn primary big" type="submit">Open</button>
      </form>`;
  }
  const tabs = `<nav class="tabs">${CARE_TABS.map(([k, l]) =>
    `<a href="#care/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>`;
  const banner = myRole === 'family'
    ? `<div class="care-banner"><strong>Family tools${settings.name ? ` · ${esc(settings.name)}` : ''}</strong>
        <a class="btn small" href="#home">See their screen</a></div>`
    : `<div class="care-banner"><strong>Family mode</strong>
        <button class="btn small" data-action="care-lock">Lock &amp; return</button></div>`;
  const views = {
    activity: careActivity, tasks: careTasks, meds: careMeds, calendar: careCalendar, messages: careMessages,
    photos: carePhotos, voices: careVoices, music: careMusic, people: carePeople, about: careAbout, circle: careCircle, settings: careSettings,
  };
  return banner + tabs + await (views[tab] || careActivity)();
}

let lastCode = null; // { code, role, until }
async function careCircle() {
  const { data: members } = await sb.from('members').select('user_id, role, display_name, created_at').eq('circle_id', circleId).order('created_at');
  const fam = (members || []).filter((m) => m.role === 'family');
  const devices = (members || []).filter((m) => m.role === 'device');
  const appUrl = location.origin + location.pathname;
  const canInvite = myRole === 'family';
  const who = settings.name || 'your loved one';
  const whose = settings.name ? `${esc(settings.name)}'s` : 'their';
  const live = (role) => lastCode && lastCode.role === role && lastCode.until > Date.now() ? lastCode.code : null;
  const pretty = (k) => esc(k.replace(/(\d{3})(\d{3})/, '$1 $2'));
  const sendButtons = (url, text, subject) => `
    <div class="btn-row send-row">
      ${navigator.share ? `<button class="btn primary" data-action="share-link" data-url="${esc(url)}" data-text="${esc(text)}">${icon('msg')} Send…</button>` : ''}
      <a class="btn ${navigator.share ? '' : 'primary'}" href="sms:?&body=${encodeURIComponent(text + ' ' + url)}">${icon('msg')} Text message</a>
      <a class="btn" href="mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text + '\n\n' + url)}">Email</a>
      <button class="btn" data-action="copy-link" data-url="${esc(url)}">Copy link</button>
    </div>`;

  const deviceCode = live('device');
  const deviceCard = !canInvite
    ? `<div class="paper"><h2>Set up ${whose} phone</h2><p class="hint">Only family members signed in with email can set up devices.</p></div>`
    : !deviceCode ? `
    <div class="paper">
      <h2>Set up ${whose} phone or tablet</h2>
      <p>Takes about a minute. Nobody types passwords or web addresses.</p>
      <button class="btn primary big" data-action="make-code" data-id="device">Start</button>
    </div>` : (() => {
      const url = `${appUrl}?pair=${deviceCode}&c=${circleId}`;
      return `
    <div class="paper">
      <h2>Set up ${whose} phone or tablet</h2>
      <p class="hint">Pick whichever is easiest. This works once, for the next 24 hours.</p>
      <div class="way">
        <div class="way-title"><span class="way-num">1</span> Scan it with their phone</div>
        <div class="qr" data-qr="${esc(url)}" aria-label="QR code to set up the phone"></div>
        <p>Open the <b>Camera</b> on ${whose} phone, point it at this square, and tap the link that pops up. Then tap <b>Set up this phone</b>.</p>
      </div>
      <div class="way">
        <div class="way-title"><span class="way-num">2</span> Or send them the link</div>
        <p>Text or email it to ${whose} phone, then tap the link on that phone.</p>
        ${sendButtons(url, `Tap this link on ${who}'s phone to set up Memory Companion:`, 'Set up Memory Companion')}
      </div>
      <div class="way">
        <div class="way-title"><span class="way-num">3</span> Or type the code</div>
        <div class="code-big">${pretty(deviceCode)}</div>
        <p class="hint">On their phone, open the app and choose "This phone is for my loved one".</p>
      </div>
      <p class="hint">Once it opens on their phone, tap Share → <b>Add to Home Screen</b>, so next time it's one tap.</p>
    </div>`;
    })();

  const famCode = live('family');
  const familyCard = !canInvite ? '' : !famCode ? `
    <div class="paper">
      <h2>Invite a relative</h2>
      <p class="hint">They'll be able to send messages and photos, and see what's done each day. Everyone signs in with their own email.</p>
      <button class="btn" data-action="make-code" data-id="family">Invite someone</button>
    </div>` : (() => {
      const url = `${appUrl}?invite=${famCode}&c=${circleId}`;
      return `
    <div class="paper">
      <h2>Invite a relative</h2>
      <p>Send them this link. They tap it, sign in with their email, and they're in.</p>
      ${sendButtons(url, `Join me in caring for ${who} on Memory Companion. Tap to join:`, `Help care for ${who} on Memory Companion`)}
      <p class="hint">Works once, for 24 hours. Their invite code, if they need it: <b>${pretty(famCode)}</b></p>
    </div>`;
    })();

  return `
    ${deviceCard}
    ${familyCard}
    <div class="paper">
      <h2>Who's in the circle</h2>
      ${fam.map((m) => `<div class="list-item"><span>👤 <strong>${esc(m.display_name || 'Family member')}</strong>${m.user_id === me.id ? ' <span class="meta">(you)</span>' : ''}<br><span class="meta">Family · joined ${new Date(m.created_at).toLocaleDateString()}</span></span>
        ${canInvite && m.user_id !== me.id ? `<button class="btn small danger" data-action="member-del" data-id="${m.user_id}">Remove</button>` : ''}</div>`).join('')}
      ${devices.map((m) => `<div class="list-item"><span>📱 <strong>${esc(m.display_name || 'Companion device')}</strong>${m.user_id === me.id ? ' <span class="meta">(this device)</span>' : ''}<br><span class="meta">Their device · paired ${new Date(m.created_at).toLocaleDateString()}</span></span>
        ${canInvite ? `<button class="btn small danger" data-action="member-del" data-id="${m.user_id}">Unpair</button>` : ''}</div>`).join('')}
    </div>
    <div class="paper">
      <h2>This device</h2>
      <p class="hint">${myRole === 'family' ? `Signed in as ${esc(me.email || '')}.` : `This is ${esc(settings.name || 'your loved one')}'s paired device.`}</p>
      <button class="btn small" data-action="sign-out">${myRole === 'family' ? 'Sign out' : 'Unpair this device'}</button>
    </div>`;
}

// ---- Family voices ----
const VOICE_SCRIPT = [
  (r, l) => `My name is ${r}. I'm recording my voice for Memory Companion, so it can read messages and reminders to ${l}. I give my permission for my voice to be used this way.`,
  (r, l) => `Good morning, ${l}. It's Tuesday, the fourteenth of March, and it's a little after eight o'clock. The sun is up, and it looks like a lovely day outside. Take your time getting ready. There's no rush at all.`,
  () => `It's time to take your morning pills. They're in the little white box on the kitchen counter, next to the kettle. Have a glass of water with them, and then you can sit down and enjoy your breakfast.`,
  () => `This afternoon, at two thirty, Sarah is coming to visit. She'll bring the photos from Emma's graduation. Do you remember? Emma wore the blue dress, and everyone was so proud of her.`,
  () => `Here's a message from me. I love you so much, and I'm thinking about you today. I'll call you this evening, around six o'clock. If you need anything at all, just press the big button that says "I need help," and someone will be right there.`,
  () => `Don't forget to drink some water. It's warm today, about seventy-five degrees, so a light sweater is all you need if you go out for a walk. Would you like to listen to some music? Let's put on your favorite song.`,
  () => `Is that you on the phone? Oh, how wonderful! Let's look at the pictures together. One, two, three. Here we go. Look at that big smile!`,
  () => `You did a wonderful job today. You took your medicine, you ate a good lunch, and you went for a walk in the garden. Now it's time to rest. Sleep well, and I'll see you in the morning. Goodnight.`,
];
const rec = { recorder: null, chunks: [], blob: null, url: '', started: 0, timer: null, stream: null };

function shareButtons(url, text, subject) {
  return `
    <div class="btn-row send-row">
      ${navigator.share ? `<button class="btn primary" data-action="share-link" data-url="${esc(url)}" data-text="${esc(text)}">${icon('msg')} Send…</button>` : ''}
      <a class="btn ${navigator.share ? '' : 'primary'}" href="sms:?&body=${encodeURIComponent(text + ' ' + url)}">${icon('msg')} Text message</a>
      <a class="btn" href="mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text + '\n\n' + url)}">Email</a>
      <button class="btn" data-action="copy-link" data-url="${esc(url)}">Copy link</button>
    </div>`;
}

async function careVoices() {
  const voices = [...storeOf('voices').values()].sort((a, b) => a.name.localeCompare(b.name));
  const n = settings.narration || {};
  const loved = settings.name || 'your loved one';
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const scriptUrl = `${base}record.html?for=${encodeURIComponent(settings.name || '')}`;
  const options = (sel, extra = '') => `
    <option value="${esc(settings.elevenVoiceId)}" ${!sel || sel === settings.elevenVoiceId ? 'selected' : ''}>Brady J (warm narrator)</option>
    ${voices.map((v) => `<option value="${esc(v.id)}" ${sel === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
    ${voices.length > 1 ? `<option value="rotate" ${sel === 'rotate' ? 'selected' : ''}>Take turns: a different family voice each day</option>` : ''}${extra}`;
  const canRecord = !!(navigator.mediaDevices && window.MediaRecorder);
  const me1 = myName.split(/[\s(]/)[0] || 'me';
  return `
    <div class="paper">
      <h2>Family voices</h2>
      <p>${esc(loved)} can hear <b>your</b> voice, and your sister's, and anyone else's who records, instead of a stranger's.</p>
      ${voices.length ? voices.map((v) => `
        <div class="list-item"><span>🎙️ <strong>${esc(v.name)}</strong><br><span class="meta">Added ${new Date(v.at).toLocaleDateString()}</span></span>
          <span class="row" style="flex:none;gap:.4rem">
            <button class="btn small" data-action="voice-try" data-id="${esc(v.id)}">${icon('speak')} Listen</button>
            ${myRole === 'family' ? `<button class="btn small danger" data-action="voice-del" data-id="${esc(v.id)}">Remove</button>` : ''}
          </span></div>`).join('') : '<p class="hint">No family voices yet. Add the first one below.</p>'}
    </div>

    <form class="paper stack" data-form="narration-save">
      <h2>Who reads what</h2>
      <label>"Read me the day" <select name="day">${options(n.day)}</select></label>
      <label>Reminders <select name="reminder">${options(n.reminder)}</select></label>
      <label>Messages <span class="hint">(a message can also be set to its sender's voice when it's sent)</span><select name="message">${options(n.message)}</select></label>
      <label>Everything else <select name="other">${options(n.other)}</select></label>
      <button class="btn primary" type="submit">Save</button>
    </form>

    <form class="paper stack" data-form="voice-create">
      <h2>Add a family voice</h2>
      <label>Whose voice is this? <input type="text" name="name" required maxlength="40" value="${esc(myName)}" placeholder="e.g. Sarah (your daughter)"></label>

      ${canRecord ? `
      <div class="way">
        <div class="way-title"><span class="way-num">1</span> Record it here</div>
        <p class="hint">Find a quiet room. Read the script below out loud, warmly and a little slowly, like you're talking to ${esc(loved)}. About two minutes.</p>
        <div class="voice-script">${VOICE_SCRIPT.map((f, i) => `<p><span class="vs-num">${i}</span>${esc(f(myName.split(' (')[0] || '[your name]', loved))}</p>`).join('')}</div>
        <div class="rec-bar">
          <button class="btn primary big" type="button" data-action="rec-toggle" id="rec-btn">${rec.recorder ? '■ Stop' : '● Start recording'}</button>
          <span class="rec-time" id="rec-time">${rec.blob ? 'Recorded ✓' : '0:00'}</span>
        </div>
        <div id="rec-preview">${rec.url ? `<audio controls src="${rec.url}"></audio><button class="btn small ghost" type="button" data-action="rec-discard">Record again</button>` : ''}</div>
      </div>` : ''}

      <div class="way">
        <div class="way-title"><span class="way-num">${canRecord ? '2' : '1'}</span> ${canRecord ? 'Or upload' : 'Upload'} a recording</div>
        <p class="hint">For example, a Voice Memo someone sent you. 1 to 3 minutes of clear speech.</p>
        <input type="file" name="files" accept="audio/*" multiple>
      </div>

      <label class="inline consent-check"><input type="checkbox" name="consent" required>
        This is my voice, or the person agreed to have their voice used for ${esc(loved)}.</label>
      <button class="btn primary big" type="submit">Create this voice</button>
      <p class="hint">Uses ElevenLabs voice cloning (needs their Starter plan or higher). The recording is deleted once the voice is made.</p>
    </form>

    <div class="paper">
      <h2>Ask someone to record</h2>
      <p>Send them the script. They read it into their phone's voice recorder and send you the file. Then upload it above.</p>
      ${shareButtons(scriptUrl, `Could you record your voice for ${loved}'s Memory Companion? It takes about two minutes. Here's the script and how-to:`, `Record your voice for ${loved}`)}
      <p class="hint"><a href="${esc(scriptUrl)}" target="_blank" rel="noopener">Open the script page</a></p>
    </div>`;
}

function stopRecTimer() { clearInterval(rec.timer); rec.timer = null; }
async function toggleRecording() {
  if (rec.recorder) { rec.recorder.stop(); return; }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('Please allow the microphone to record your voice.');
    return;
  }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  rec.chunks = [];
  rec.recorder = new MediaRecorder(rec.stream, type ? { mimeType: type } : undefined);
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = () => {
    stopRecTimer();
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || type || 'audio/webm' });
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.url = URL.createObjectURL(rec.blob);
    const secs = Math.round((Date.now() - rec.started) / 1000);
    rec.recorder = null;
    const btn = document.getElementById('rec-btn'); if (btn) btn.textContent = '● Start recording';
    const t = document.getElementById('rec-time'); if (t) t.textContent = `Recorded ✓ (${Math.floor(secs / 60)}:${pad(secs % 60)})`;
    const pv = document.getElementById('rec-preview');
    if (pv) pv.innerHTML = `<audio controls src="${rec.url}"></audio><button class="btn small ghost" type="button" data-action="rec-discard">Record again</button>`;
    if (secs < 45) toast('That was a bit short. About two minutes works best.');
  };
  rec.recorder.start(1000);
  rec.started = Date.now();
  const btn = document.getElementById('rec-btn'); if (btn) btn.textContent = '■ Stop';
  rec.timer = setInterval(() => {
    const s = Math.round((Date.now() - rec.started) / 1000);
    const t = document.getElementById('rec-time'); if (t) t.textContent = `● ${Math.floor(s / 60)}:${pad(s % 60)}`;
  }, 500);
}
function discardRecording() {
  if (rec.url) URL.revokeObjectURL(rec.url);
  rec.blob = null; rec.url = ''; rec.chunks = [];
  render();
}

async function careActivity() {
  const [{ items, doneMap }, msgs] = await Promise.all([todayItems(), all('messages')]);
  const now = nowHM();
  const done = items.filter((t) => doneMap.has(t.key));
  const missed = items.filter((t) => !doneMap.has(t.key) && t.time <= now && t.kind !== 'event');
  const replies = msgs.flatMap((m) => (m.replies || []).map((r) => ({ ...r, to: m.from })))
    .sort((a, b) => b.at - a.at).slice(0, 10);
  const unread = msgs.filter((m) => !m.read).length;
  let pairPrompt = '';
  if (myRole === 'family') {
    const { count } = await sb.from('members').select('user_id', { count: 'exact', head: true }).eq('circle_id', circleId).eq('role', 'device');
    if (!count) {
      pairPrompt = `
        <a class="pair-prompt" href="#care/circle">
          <span class="pp-ic">${icon('phone')}</span>
          <span><span class="kicker">Next step</span><span class="pp-title">Pair ${esc(settings.name || 'their')}${settings.name ? "'s" : ''} phone</span>
          <span class="pp-sub">Get a 6-digit code to set up their device — no password needed.</span></span>
          <span class="chev">›</span>
        </a>`;
    }
  }
  return `${pairPrompt}
    <div class="stat-row">
      <div class="stat"><div class="n">${done.length}/${items.length}</div><div class="l">done today</div></div>
      <div class="stat"><div class="n" style="color:${missed.length ? 'var(--shu)' : 'inherit'}">${missed.length}</div><div class="l">overdue</div></div>
      <div class="stat"><div class="n">${unread}</div><div class="l">unread messages</div></div>
    </div>
    <div class="paper"><h2>Overdue today</h2>
      ${missed.length ? missed.map((t) => `<div class="list-item"><span>${esc(t.icon)} ${esc(t.title)}</span><span class="meta">due ${fmtHM(t.time)}</span></div>`).join('')
        : '<p class="hint">Nothing overdue.</p>'}
    </div>
    <div class="paper"><h2>Done today</h2>
      ${done.length ? done.map((t) => `<div class="list-item"><span>${esc(t.icon)} ${esc(t.title)}</span><span class="meta">at ${fmtClock(new Date(doneMap.get(t.key).at))}</span></div>`).join('')
        : '<p class="hint">Nothing checked off yet.</p>'}
    </div>
    <div class="paper"><h2>Recent replies</h2>
      ${replies.length ? replies.map((r) => `<div class="list-item"><span>${esc(r.text)} <span class="meta">→ ${esc(r.to)}</span></span><span class="meta">${fmtWhen(r.at)}</span></div>`).join('')
        : '<p class="hint">No replies yet.</p>'}
    </div>`;
}

const ICONS = ['🍳', '🥪', '🍽️', '💧', '🚶', '🛏️', '🚿', '🪥', '👕', '📞', '🩺', '🧩', '📺', '🌱', '🐕', '🗑️', '🍵', '⭐'];

async function careTasks() {
  const tasks = (await all('tasks')).sort((a, b) => a.time.localeCompare(b.time));
  return `
    <form class="paper stack" data-form="task-add">
      <h2>Add a daily task</h2>
      <label>What to do <input type="text" name="title" required maxlength="80" placeholder="e.g. Water the plants"></label>
      <div class="row">
        <label>Time <input type="time" name="time" required value="09:00"></label>
        <label>Picture <select name="icon">${ICONS.map((i) => `<option>${i}</option>`).join('')}</select></label>
      </div>
      <p class="hint">Tasks repeat every day. A reminder appears and is read aloud at this time while the app is open. Medicines go in the Medicines tab.</p>
      <button class="btn primary" type="submit">Add task</button>
    </form>
    <div class="paper"><h2>Daily schedule</h2>
      ${tasks.length ? tasks.map((t) => `
        <div class="list-item"><span>${esc(t.icon)} <strong>${fmtHM(t.time)}</strong> — ${esc(t.title)}</span>
        <button class="btn small danger" data-action="task-del" data-id="${t.id}">Remove</button></div>`).join('')
        : '<p class="hint">No tasks yet.</p>'}
    </div>`;
}

async function careMeds() {
  const meds = await all('meds');
  return `
    <form class="paper stack" data-form="med-add">
      <h2>Add a medicine</h2>
      <label>Name <input type="text" name="name" required maxlength="60" placeholder="e.g. Lisinopril"></label>
      <div class="row">
        <label>How much <input type="text" name="dose" maxlength="60" placeholder="e.g. 1 white pill"></label>
        <label>What it's for <input type="text" name="purpose" maxlength="80" placeholder="e.g. For your blood pressure"></label>
      </div>
      <div class="row">
        <label>Time 1 <input type="time" name="t1" required value="08:00"></label>
        <label>Time 2 <input type="time" name="t2"></label>
        <label>Time 3 <input type="time" name="t3"></label>
      </div>
      <label>Photo of the pill or box <span class="hint">(helps them recognize it)</span><input type="file" name="file" accept="image/*"></label>
      <button class="btn primary" type="submit">Add medicine</button>
    </form>
    <div class="paper"><h2>Medicines</h2>
      ${meds.length ? meds.map((m) => `
        <div class="list-item"><span><strong>${esc(m.name)}</strong> ${esc(m.dose)}<br><span class="meta">${(m.times || []).map(fmtHM).join(', ')} · ${esc(m.purpose)}</span></span>
        <button class="btn small danger" data-action="med-del" data-id="${m.id}">Remove</button></div>`).join('')
        : '<p class="hint">No medicines yet.</p>'}
    </div>`;
}

async function careCalendar() {
  const events = (await all('events')).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  return `
    <form class="paper stack" data-form="event-add">
      <h2>Add an appointment or event</h2>
      <label>What <input type="text" name="title" required maxlength="80" placeholder="e.g. Hair appointment"></label>
      <div class="row">
        <label>Date <input type="date" name="date" required value="${dayKey()}"></label>
        <label>Time <input type="time" name="time" value="10:00"></label>
      </div>
      <label>Where <input type="text" name="place" maxlength="80" placeholder="e.g. Rose Salon on 5th Street"></label>
      <label>Who's going / driving <input type="text" name="with" maxlength="80" placeholder="e.g. Tom will pick you up at 9:30"></label>
      <label>Note <input type="text" name="note" maxlength="120" placeholder="e.g. Bring your insurance card"></label>
      <p class="hint">A reminder appears one hour before.</p>
      <button class="btn primary" type="submit">Add to calendar</button>
    </form>
    <div class="paper"><h2>Calendar</h2>
      ${events.length ? events.map((e) => `
        <div class="list-item"><span><strong>${esc(e.title)}</strong><br><span class="meta">${esc(fmtDay(e.date))}${e.time ? ' · ' + fmtHM(e.time) : ''}${e.place ? ' · ' + esc(e.place) : ''}</span></span>
        <button class="btn small danger" data-action="event-del" data-id="${e.id}">Remove</button></div>`).join('')
        : '<p class="hint">Nothing scheduled.</p>'}
    </div>`;
}

async function careMessages() {
  const msgs = (await all('messages')).sort((a, b) => b.at - a.at);
  return `
    <form class="paper stack" data-form="msg-add">
      <h2>Send a message</h2>
      <label>From <input type="text" name="from" required maxlength="40" value="${esc(myName)}" placeholder="e.g. Sarah (your daughter)"></label>
      <label>Message <textarea name="text" required maxlength="1000" placeholder="Short, warm and simple works best."></textarea></label>
      ${storeOf('voices').size ? `<label>Read it aloud in <select name="voiceId">
        <option value="">The usual voice (see Voices)</option>
        ${[...storeOf('voices').values()].map((v) => `<option value="${esc(v.id)}" ${v.ownerUser === me.id ? 'selected' : ''}>${esc(v.name)}'s voice</option>`).join('')}
      </select></label>` : ''}
      <label>Photo or video <span class="hint">(optional — it also appears in Photos)</span>
        <input type="file" name="file" accept="image/*,video/*"></label>
      <button class="btn primary" type="submit">Send</button>
    </form>
    <div class="paper"><h2>Sent messages</h2>
      ${msgs.length ? msgs.map((m) => `
        <div class="list-item"><span><strong>${esc(m.from)}</strong>: ${esc(m.text.slice(0, 60))}${m.text.length > 60 ? '…' : ''}
          <br><span class="meta">${fmtWhen(m.at)} · ${m.read ? 'Read ✓' : 'Not read yet'}${(m.replies || []).length ? ` · ${m.replies.length} repl${m.replies.length > 1 ? 'ies' : 'y'}` : ''}</span></span>
        <button class="btn small danger" data-action="msg-del" data-id="${m.id}">Delete</button></div>`).join('')
        : '<p class="hint">No messages yet.</p>'}
    </div>`;
}

async function carePhotos() {
  const items = await galleryItems();
  const rows = await Promise.all(items.map(async (m) => {
    const url = await mediaUrl(m.id);
    return `<div class="list-item">
      ${isVideo(m) ? `<video class="mini-thumb" src="${url}#t=0.5" muted preload="metadata"></video>` : `<img class="mini-thumb" src="${url}" alt="">`}
      ${m.from ? `<span class="hint" style="flex:none">from ${esc(shortName(m.from))}</span>` : ''}
      <form class="row" data-form="caption-save" data-id="${m.id}" style="flex:1">
        <input type="text" name="caption" value="${esc(m.caption)}" placeholder="Add a caption" maxlength="120">
        <button class="btn small" type="submit" style="flex:none">Save</button>
      </form>
      <button class="btn small danger" data-action="media-del" data-id="${m.id}">Delete</button></div>`;
  }));
  return `
    <form class="paper stack" data-form="photo-add">
      <h2>Add photos &amp; videos</h2>
      <label>Choose files <input type="file" name="files" accept="image/*,video/*" multiple required></label>
      <label>From <span class="hint">(shown on each photo so they know who sent it)</span>
        <input type="text" name="from" maxlength="40" value="${esc(shortName(myName))}" placeholder="e.g. Sarah"></label>
      <label>Caption <span class="hint">(who, where, when — this is read aloud)</span>
        <input type="text" name="caption" maxlength="120" placeholder="e.g. Emma's graduation, May 2025"></label>
      <button class="btn primary" type="submit">Add to Photos</button>
    </form>
    <div class="paper"><h2>In the gallery (${items.length})</h2>${rows.join('') || '<p class="hint">Nothing yet.</p>'}</div>`;
}

async function careMusic() {
  const list = await songs();
  const links = (await all('music')).sort((a, b) => b.at - a.at);
  return `
    <form class="paper stack" data-form="music-link-add">
      <h2>Add from Spotify, Apple Music or YouTube</h2>
      <label>Paste a link to a song, album or playlist
        <input type="url" name="url" required placeholder="https://open.spotify.com/track/…" inputmode="url"></label>
      <label>Name it <span class="hint">(optional — we'll look up the song name and cover)</span>
        <input type="text" name="title" maxlength="120" placeholder="e.g. Mom's favorite: Moon River"></label>
      <button class="btn primary" type="submit">Add song</button>
      <details class="how"><summary>How do I get a link?</summary>
        <p><b>Spotify:</b> tap ••• on a song → Share → Copy link.</p>
        <p><b>Apple Music:</b> tap ••• → Share → Copy.</p>
        <p><b>YouTube:</b> tap Share under the video → Copy link.</p>
        <p class="hint">YouTube plays the whole song right in the app. Spotify and Apple Music play a 30-second preview in the app, plus a button that opens their app for the full song (needs a subscription on that phone).</p>
      </details>
    </form>
    ${links.length ? `<div class="paper"><h2>Music links (${links.length})</h2>
      ${links.map((m) => `<div class="list-item">
        ${m.thumb ? `<img class="mini-thumb" src="${esc(m.thumb)}" alt="">` : ''}
        <span style="flex:1;min-width:0"><strong>${esc(m.title || 'Song')}</strong><br><span class="meta">${SERVICE[m.provider] || ''}${m.artist ? ' · ' + esc(m.artist) : ''}</span></span>
        <button class="btn small danger" data-action="music-del" data-id="${m.id}">Remove</button></div>`).join('')}
    </div>` : ''}
    <form class="paper stack" data-form="song-add">
      <h2>Or upload song files</h2>
      <label>Audio files <span class="hint">(MP3, M4A…)</span><input type="file" name="files" accept="audio/*" multiple required></label>
      <p class="hint">Music they loved when they were young can be very calming. Song names come from the file names — you can edit them below.</p>
      <button class="btn primary" type="submit">Add songs</button>
    </form>
    <div class="paper"><h2>Songs (${list.length})</h2>
      ${list.map((s) => `<div class="list-item">
        <form class="row" data-form="caption-save" data-id="${s.id}" style="flex:1">
          <input type="text" name="caption" value="${esc(s.caption)}" maxlength="120">
          <button class="btn small" type="submit" style="flex:none">Save</button>
        </form>
        <button class="btn small danger" data-action="media-del" data-id="${s.id}">Delete</button></div>`).join('') || '<p class="hint">No songs yet.</p>'}
    </div>`;
}

async function carePeople() {
  const people = (await all('people')).sort((a, b) => a.name.localeCompare(b.name));
  return `
    <form class="paper stack" data-form="person-add">
      <h2>Add a person</h2>
      <div class="row">
        <label>Name <input type="text" name="name" required maxlength="40" placeholder="e.g. Sarah"></label>
        <label>Who they are <input type="text" name="relation" maxlength="60" placeholder="e.g. Your daughter"></label>
      </div>
      <label>Phone number <span class="hint">(for the Call button)</span> <input type="tel" name="phone" maxlength="20"></label>
      <label>Photo <input type="file" name="file" accept="image/*"></label>
      <button class="btn primary" type="submit">Add person</button>
    </form>
    <div class="paper"><h2>People</h2>
      ${people.length ? people.map((p) => `
        <div class="list-item"><span><strong>${esc(p.name)}</strong> — ${esc(p.relation)}<br><span class="meta">${esc(p.phone) || 'no phone'}</span></span>
        <button class="btn small danger" data-action="person-del" data-id="${p.id}">Remove</button></div>`).join('')
        : '<p class="hint">No people yet.</p>'}
    </div>`;
}

async function careAbout() {
  const a = settings.about;
  const people = await all('people');
  return `
    <form class="paper stack" data-form="about-save">
      <h2>About me</h2>
      <p class="hint">Shown on the "About Me" screen, in their own words where possible.</p>
      <label>Full name <input type="text" name="fullName" value="${esc(a.fullName)}" maxlength="80"></label>
      <label>Home address <input type="text" name="address" value="${esc(a.address)}" maxlength="140"></label>
      <div class="row">
        <label>Birthday <input type="text" name="birthday" value="${esc(a.birthday)}" maxlength="40" placeholder="e.g. March 3, 1941"></label>
        <label>Their phone number <input type="tel" name="phone" value="${esc(a.phone)}" maxlength="20"></label>
      </div>
      <label>Good to remember <span class="hint">(one per line)</span>
        <textarea name="facts" maxlength="1500" placeholder="You live with your husband, Tom.&#10;Your doctor is Dr. Lee.&#10;Your cat is called Miso.">${esc(a.facts)}</textarea></label>
      <h2 style="margin-top:.6rem">Help button</h2>
      <label>Who to call first <select name="helpPersonId">
        <option value="">First person with a phone number</option>
        ${people.map((p) => `<option value="${p.id}" ${p.id === settings.helpPersonId ? 'selected' : ''}>${esc(p.name)}${telOf(p) ? '' : ' (no phone)'}</option>`).join('')}
      </select></label>
      <h2 style="margin-top:.6rem">Weather</h2>
      <div class="row">
        <label>Town or city <input type="text" name="city" value="${esc(settings.city)}" maxlength="80" placeholder="e.g. Louisville, Kentucky">
          ${settings.place ? `<span class="hint">Found: ${esc(settings.place)}</span>` : ''}</label>
        <label>Units <select name="units">
          <option value="fahrenheit" ${settings.units !== 'celsius' ? 'selected' : ''}>°F</option>
          <option value="celsius" ${settings.units === 'celsius' ? 'selected' : ''}>°C</option></select></label>
      </div>
      <button class="btn primary" type="submit">Save</button>
    </form>`;
}

async function loadElevenVoices() {
  if (!eleven.enabled) return [];
  if (eleven.voices) return eleven.voices;
  try {
    const r = await fetch(`${VOICE_FN}?list=1`, { headers: await authHeaders() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    eleven.voices = j.voices || [];
  } catch (err) {
    console.warn(err);
    eleven.voices = [];
    eleven.error = String(err.message || err);
  }
  return eleven.voices;
}

// Voices whose descriptions sound calm and warm float to the top.
function calmRank(v) {
  const t = `${v.name} ${v.description} ${Object.values(v.labels || {}).join(' ')}`.toLowerCase();
  let s = 0;
  if (/calm|sooth|warm|gentle|soft|comfort|relax|kind|mature|grandm|narrat/.test(t)) s += 10;
  if (/matilda|lily|alice|sarah|rachel|george|brian|charlotte|dorothy/.test(t)) s += 3;
  if (/aggressive|intense|hyped|energetic|excited|deep villain|whisper/.test(t)) s -= 10;
  return s;
}

async function careEleven() {
  if (!eleven.enabled) {
    return `
      <div class="paper">
        <h2>Warm voice (ElevenLabs)</h2>
        <p class="hint">Not connected yet. Once an ElevenLabs key is saved on the computer that runs the app, a list of warm, human-sounding voices appears here.</p>
      </div>`;
  }
  const voices = (await loadElevenVoices()).slice()
    .sort((a, b) => (b.id === DEFAULT_ELEVEN_VOICE) - (a.id === DEFAULT_ELEVEN_VOICE) || calmRank(b) - calmRank(a));
  const describe = (v) => {
    const l = v.labels || {};
    return [l.gender, l.age, l.accent, l.description || l.descriptive, l.use_case].filter(Boolean).join(', ');
  };
  return `
    <form class="paper stack" data-form="eleven-save">
      <h2>Warm voice <span class="pill-ok">ElevenLabs connected</span></h2>
      <label>Which voice reads aloud <select name="voiceEngine">
        <option value="eleven" ${settings.voiceEngine !== 'device' ? 'selected' : ''}>Warm voice (ElevenLabs)</option>
        <option value="device" ${settings.voiceEngine === 'device' ? 'selected' : ''}>This device's built-in voice</option>
      </select></label>
      ${voices.length ? `
      <label>Voice <select name="elevenVoiceId" id="eleven-pick">
        ${voices.map((v) => `<option value="${esc(v.id)}" data-preview="${esc(v.preview)}" ${v.id === settings.elevenVoiceId ? 'selected' : ''}>${esc(v.name)}${describe(v) ? ' — ' + esc(describe(v)) : ''}</option>`).join('')}
      </select></label>
      <div class="btn-row" style="margin-top:0">
        <button class="btn small" type="button" data-action="eleven-sample">${icon('speak')} Quick sample</button>
        <button class="btn small" type="button" data-action="eleven-try">${icon('speak')} Hear it read the day</button>
        <button class="btn primary small" type="submit">Use this voice</button>
      </div>
      <p class="hint">"Quick sample" is free. "Hear it read the day" uses a little of your ElevenLabs allowance. Phrases that repeat are saved, so they cost nothing the second time.</p>`
      : `<p class="hint">Couldn't load voices: ${esc(eleven.error || 'unknown problem')}. Check the key has "Text to Speech" and "Voices" access.</p>`}
    </form>`;
}

function careVoice() {
  const list = goodVoices();
  const natural = list.filter((v) => voiceQuality(v) >= 2);
  const rates = [[0.75, 'Very slow'], [0.85, 'Slow and gentle'], [0.95, 'Normal']];
  const label = (v) => `${v.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()}${voiceQuality(v) >= 2 ? ' ★ natural' : ''} — ${v.lang}`;
  return `
    <form class="paper stack" data-form="voice-save">
      <h2>${eleven.enabled ? 'Backup voice (built into this device)' : 'Voice'}</h2>
      ${eleven.enabled ? '<p class="hint">Used only when the warm voice is switched off or unreachable. Speed applies to both.</p>' : ''}
      ${'speechSynthesis' in window ? `
      <label>Voice <select name="voiceName" id="voice-pick">
        ${list.length ? list.map((v) => `<option value="${esc(v.name)}" ${voice && v.name === voice.name ? 'selected' : ''}>${esc(label(v))}</option>`).join('')
          : '<option value="">Default voice</option>'}
      </select></label>
      <label>Speed <select name="rate" id="voice-rate">${rates.map(([r, l]) =>
        `<option value="${r}" ${Number(settings.rate) === r ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="btn-row" style="margin-top:0">
        <button class="btn small" type="button" data-action="voice-preview">${icon('speak')} Listen</button>
        <button class="btn primary small" type="submit">Use this voice</button>
      </div>
      ${natural.length ? '' : `
      <div class="voice-tip">
        <strong>Get a natural, soothing voice (free)</strong>
        <p>This device only has older robotic voices. Download a Premium voice once and the app uses it automatically:</p>
        <p><b>iPhone / iPad:</b> Settings → Accessibility → Spoken Content → Voices → English → choose <b>Ava</b>, <b>Zoe</b> or <b>Evan</b> → tap the download button next to <b>Premium</b> (or Enhanced).</p>
        <p><b>Mac:</b> System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… → English → tick <b>Ava (Premium)</b> or <b>Zoe (Premium)</b>.</p>
        <p>Then fully close and reopen the app (or browser) and come back here.</p>
      </div>`}` : '<p class="hint">This browser cannot read aloud.</p>'}
    </form>`;
}

async function careSettings() {
  const scales = [[1, 'Large'], [1.15, 'Larger'], [1.3, 'Largest']];
  return `
    <form class="paper stack" data-form="settings-save">
      <h2>Settings</h2>
      <label>Their first name <span class="hint">(used in the greeting)</span>
        <input type="text" name="name" value="${esc(settings.name)}" maxlength="40"></label>
      <label>Text size <select name="scale">${scales.map(([v, l]) =>
        `<option value="${v}" ${Number(settings.scale) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" name="voice" ${settings.voice ? 'checked' : ''}>
        Read reminders and messages aloud</label>
      <label>New family PIN <span class="hint">(leave blank to keep current)</span>
        <input type="password" name="pin" inputmode="numeric" minlength="4" maxlength="8" autocomplete="new-password"></label>
      <button class="btn primary" type="submit">Save settings</button>
    </form>
    ${await careEleven()}
    ${careVoice()}
    <div class="paper">
      <h2>Sound on iPhone</h2>
      <p class="hint">Make sure the volume is up. Sound starts after the first tap on the screen. If you still hear nothing, check that the phone isn't on silent.</p>
      <button class="btn small" data-action="test-sound">${icon('speak')} Test sound</button>
    </div>
    <div class="paper">
      <h2>Your data</h2>
      <p class="hint">Everything is saved securely online and shared only with the people in this care circle (see Family &amp; devices).</p>
      ${myRole === 'family' ? '<button class="btn small danger" data-action="reset">Delete this care circle…</button>' : ''}
    </div>`;
}

// ================================================================ router
let renderSeq = 0;
async function render() {
  if (!circleId) return; // still signing in / pairing
  const seq = ++renderSeq;
  const [r = 'home', param] = location.hash.slice(1).split('/');
  const views = {
    home: viewHome, day: viewDay, messages: viewMessages, message: viewMessage,
    photos: viewPhotos, photo: viewPhoto, people: viewPeople, meds: viewMeds,
    calendar: viewCalendar, music: viewMusic, about: viewAbout, help: viewHelp, care: viewCare,
  };
  let html;
  try {
    html = await (views[r] || viewHome)(param);
  } catch (err) {
    console.error(err);
    html = topbar('Something went wrong') + `<div class="paper"><p>Please go back home and try again.</p>
      <p class="hint">Details for your family: ${esc(err && err.message || err)}</p></div>`;
  }
  if (seq !== renderSeq) return;
  if (!html || !String(html).trim()) html = topbar('') + empty('day', 'This page is empty.');
  $app.innerHTML = html;
  drawQRCodes();
  const auto = $app.querySelector('[autofocus]');
  if (auto) auto.focus();
}

function drawQRCodes() {
  $app.querySelectorAll('[data-qr]').forEach((el) => {
    if (!window.QRCode) { el.remove(); return; }
    el.innerHTML = '';
    new window.QRCode(el, { text: el.dataset.qr, width: 220, height: 220, colorDark: '#2b2925', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
  });
}

window.addEventListener('hashchange', () => {
  if (route() !== 'music') stopMusic();
  render();
  window.scrollTo(0, 0);
});

// ================================================================ actions
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, text } = el.dataset;
  switch (action) {
    case 'speak': speak(text, { purpose: el.dataset.purpose || 'other', senderVoice: el.dataset.voice || undefined }); break;
    case 'test-sound': chime(); setTimeout(() => speak('Hello! You can hear me.'), 600); break;
    case 'eleven-sample': {
      const opt = document.getElementById('eleven-pick')?.selectedOptions[0];
      if (opt && opt.dataset.preview) {
        stopSpeaking();
        voicePlayer.src = opt.dataset.preview;
        voicePlayer.play().catch(() => toast('Tap again to play'));
      } else toast('No sample for this voice — try "Hear it read the day"');
      break;
    }
    case 'eleven-try': {
      const id = document.getElementById('eleven-pick')?.value;
      speak(`Good morning${settings.name ? ', ' + settings.name : ''}. Today is ${spokenDate(new Date())}. ${spokenTime(new Date())}. Take your time this morning. There's no rush. Have a lovely day.`, { elevenVoiceId: id });
      break;
    }
    case 'voice-preview': {
      const name = document.getElementById('voice-pick')?.value;
      const rate = Number(document.getElementById('voice-rate')?.value) || 0.85;
      const v = allVoices.find((x) => x.name === name) || voice;
      speak(`Good morning. Today is ${spokenDate(new Date())}. It's a lovely day. Take your time, there's no rush.`, { voice: v, rate, device: true });
      break;
    }
    case 'done': await completeItem(id); break;
    case 'undo': await del('completions', `${dayKey()}:${id}`); render(); break;
    case 'reply': {
      const m = await get('messages', id);
      m.replies = [...(m.replies || []), { text, at: Date.now() }];
      await put('messages', m);
      toast('Reply sent ✓');
      render();
      break;
    }
    case 'song': await toggleSong(id, el); break;
    case 'care-lock': session('care', null); location.hash = '#home'; break;
    case 'task-del': if (confirm('Remove this task?')) { await del('tasks', id); render(); } break;
    case 'med-del': if (confirm('Remove this medicine?')) {
      const m = await get('meds', id);
      if (m?.photoId) { await del('media', m.photoId); forgetUrl(m.photoId); }
      await del('meds', id); render();
    } break;
    case 'rec-toggle': await toggleRecording(); break;
    case 'rec-discard': discardRecording(); break;
    case 'voice-try': {
      const v = storeOf('voices').get(id);
      speak(`Hello, ${settings.name || 'there'}. This is ${v ? v.name.split(' (')[0] : 'me'}. I love you, and I'm thinking about you today.`, { elevenVoiceId: id });
      break;
    }
    case 'voice-del':
      if (confirm('Remove this voice? Anything set to use it will go back to the warm narrator.')) {
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/voiceclone`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ action: 'delete', circleId, voiceId: id }) });
          if (!r.ok) throw new Error((await r.json()).error);
          await del('voices', id); toast('Voice removed'); render();
        } catch (err) { toast(err.message); }
      }
      break;
    case 'music-del': if (confirm('Remove this song?')) { await del('music', id); render(); } break;
    case 'event-del': if (confirm('Remove this event?')) { await del('events', id); render(); } break;
    case 'msg-del': if (confirm('Delete this message?')) { await del('messages', id); render(); } break;
    case 'media-del':
      if (confirm('Delete this item?')) { await del('media', id); forgetUrl(id); render(); }
      break;
    case 'person-del':
      if (confirm('Remove this person?')) {
        const p = await get('people', id);
        if (p?.photoId) { await del('media', p.photoId); forgetUrl(p.photoId); }
        await del('people', id); render();
      }
      break;
    case 'reset':
      if (confirm(`Permanently delete ${settings.name || 'this'} care circle — all tasks, medicines, messages, photos, music and people — for everyone?`)
          && confirm('Are you sure? This cannot be undone.')) {
        try {
          const paths = (await all('media')).map((m) => m.path).filter(Boolean);
          for (let i = 0; i < paths.length; i += 100) await sb.storage.from('media').remove(paths.slice(i, i + 100));
          const { error } = await sb.from('circles').delete().eq('id', circleId);
          if (error) throw error;
          local('circle', null);
          location.hash = '';
          location.reload();
        } catch (err) { toast(`Couldn't delete: ${err.message}`); }
      }
      break;
    case 'make-code': {
      const { data, error } = await sb.rpc('make_code', { p_circle: circleId, p_role: id });
      if (error) { toast(error.message); break; }
      lastCode = { code: data, role: id, until: Date.now() + 24 * 3600 * 1000 };
      render();
      break;
    }
    case 'member-del':
      if (confirm('Remove them from the care circle? They will no longer see anything.')) {
        const { error } = await sb.from('members').delete().match({ circle_id: circleId, user_id: id });
        if (error) toast(error.message); else render();
      }
      break;
    case 'sign-out':
      if (confirm(myRole === 'family' ? 'Sign out on this device?' : 'Unpair this device? A family member will need to pair it again.')) {
        if (myRole === 'device') await sb.from('members').delete().match({ circle_id: circleId, user_id: me.id });
        await sb.auth.signOut();
        local('circle', null);
        location.hash = '';
        location.reload();
      }
      break;
    case 'share-link':
      try { await navigator.share({ title: 'Memory Companion', text: el.dataset.text, url: el.dataset.url }); } catch { /* cancelled */ }
      break;
    case 'copy-link':
      try { await navigator.clipboard.writeText(el.dataset.url); toast('Link copied'); }
      catch { window.prompt('Copy this link:', el.dataset.url); }
      break;
    case 'welcome-family': showEmail(); break;
    case 'welcome-device': showPair(); break;
    case 'welcome-back': showWelcome(); break;
    case 'join-instead': showJoin(); break;
    case 'overlay-done': await completeItem(id); hideOverlay(); break;
    case 'overlay-ok': hideOverlay(); break;
    case 'overlay-later': snoozed.set(id, Date.now() + 10 * 60 * 1000); hideOverlay(); toast('I will remind you again in 10 minutes'); break;
  }
});

async function completeItem(key) {
  await put('completions', { id: `${dayKey()}:${key}`, date: dayKey(), taskId: key, at: Date.now() });
  const { items, doneMap } = await todayItems();
  if (items.length && items.every((t) => doneMap.has(t.key)) && !(await get('garden', dayKey()))) {
    await put('garden', { id: dayKey(), date: dayKey(), color: flowerColor(), at: Date.now() });
    toast('Your flower bloomed! 🌸');
    speak('You did everything today. Your flower has bloomed. Well done!');
  } else {
    toast('Well done ✓ Your flower grew a little');
    speak('Well done! Your flower grew a little.');
  }
  render();
}

async function toggleSong(id, btn) {
  if (nowPlaying && nowPlaying.id === id) {
    if (nowPlaying.audio.paused) nowPlaying.audio.play(); else nowPlaying.audio.pause();
  } else {
    stopMusic();
    const audio = new Audio(await mediaUrl(id));
    nowPlaying = { id, audio };
    audio.addEventListener('ended', () => { nowPlaying = null; if (route() === 'music') render(); });
    audio.play().catch(() => toast('Tap again to play'));
  }
  document.querySelectorAll('.song-btn').forEach((b) => {
    const on = nowPlaying && b.dataset.id === nowPlaying.id && !nowPlaying.audio.paused;
    b.innerHTML = on ? `${icon('pause')} Pause` : `${icon('play')} Play`;
  });
}

const val = (fd, k) => String(fd.get(k) || '').trim();

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const btn = form.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  try {
    switch (form.dataset.form) {
      case 'signin-email': {
        const email = val(fd, 'email');
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) { toast(/rate|limit|seconds/i.test(error.message) ? 'Too many emails just now. Please wait a few minutes and try again.' : error.message); break; }
        showCheckEmail(email);
        break;
      }
      case 'pair-code': {
        if (!me) {
          const { data, error } = await sb.auth.signInAnonymously();
          if (error) { toast(error.message); break; }
          me = data.user;
        }
        const { data: joined, error } = await sb.rpc('redeem_code', { p_code: val(fd, 'code'), p_display: val(fd, 'device') || 'Companion device', p_circle: linkCircle(fd.get('circle')) });
        if (error) { toast(error.message); break; }
        if (!joined) { toast(fd.get('circle') ? 'That link has expired or was already used. Ask for a new one.' : 'That code is not right or has expired. Typed codes work for 30 minutes.'); break; }
        await enterCircle();
        break;
      }
      case 'setup-circle': {
        const { data: id, error } = await sb.rpc('create_circle', { p_name: val(fd, 'name'), p_display: val(fd, 'me') });
        if (error) { toast(error.message); break; }
        circleId = id; mem.clear();
        settings = mergeSettings({ name: val(fd, 'name') });
        await put('settings', settings);
        await seedExamples(true);
        local('circle', id);
        await enterCircle();
        break;
      }
      case 'join-family': {
        const viaLink = fd.get('code') === local('invite') ? local('inviteCircle') : null;
        const { data: joined, error } = await sb.rpc('redeem_code', { p_code: val(fd, 'code'), p_display: val(fd, 'me'), p_circle: linkCircle(viaLink) });
        if (error) { toast(error.message); break; }
        if (!joined) { toast(viaLink ? 'That invite has expired or was already used. Ask for a new one.' : 'That code is not right or has expired. Typed codes work for 30 minutes.'); break; }
        local('invite', null); local('inviteCircle', null);
        await enterCircle();
        break;
      }
      case 'pin':
        if (fd.get('pin') === settings.pin) { session('care', '1'); render(); }
        else { toast('That PIN is not right'); form.reset(); }
        break;
      case 'task-add':
        await put('tasks', { id: uid(), title: val(fd, 'title'), time: fd.get('time'), icon: fd.get('icon') });
        toast('Task added'); render();
        break;
      case 'med-add': {
        const file = fd.get('file');
        const photoId = file && file.size ? await saveMedia(file, '', true) : null;
        const times = [...new Set(['t1', 't2', 't3'].map((k) => fd.get(k)).filter(Boolean))].sort();
        await put('meds', { id: uid(), name: val(fd, 'name'), dose: val(fd, 'dose'), purpose: val(fd, 'purpose'), times, photoId });
        toast('Medicine added'); render();
        break;
      }
      case 'event-add':
        await put('events', {
          id: uid(), title: val(fd, 'title'), date: fd.get('date'), time: fd.get('time') || '',
          place: val(fd, 'place'), with: val(fd, 'with'), note: val(fd, 'note'),
        });
        toast('Added to calendar'); render();
        break;
      case 'msg-add': {
        const file = fd.get('file');
        const mediaId = file && file.size ? await saveMedia(file, val(fd, 'text').slice(0, 120), false, val(fd, 'from')) : null;
        await put('messages', { id: uid(), from: val(fd, 'from'), text: val(fd, 'text'), mediaId, voiceId: String(fd.get('voiceId') || ''), at: Date.now(), read: false, replies: [] });
        toast('Message sent'); render();
        break;
      }
      case 'photo-add': {
        const files = fd.getAll('files').filter((f) => f.size);
        for (const f of files) await saveMedia(f, val(fd, 'caption'), false, val(fd, 'from'));
        toast(`Added ${files.length} item${files.length === 1 ? '' : 's'}`); render();
        break;
      }
      case 'narration-save': {
        settings.narration = { day: fd.get('day'), reminder: fd.get('reminder'), message: fd.get('message'), other: fd.get('other') };
        await put('settings', settings);
        toast('Saved');
        speak('Hello. This is how I will read the day.', { purpose: 'day' });
        break;
      }
      case 'voice-create': {
        if (!fd.get('consent')) { toast('Please confirm permission first'); break; }
        const files = fd.getAll('files').filter((f) => f && f.size);
        const blobs = rec.blob ? [rec.blob, ...files] : files;
        if (!blobs.length) { toast('Record your voice or choose a recording first'); break; }
        toast('Uploading the recording…');
        const paths = [];
        for (const b of blobs.slice(0, 5)) {
          const ext = ((b.type || '').includes('mp4') ? 'm4a' : (b.type || '').includes('webm') ? 'webm' : (b.name || '').split('.').pop() || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
          const path = `${circleId}/voice-samples/${uid()}.${ext}`;
          const { error } = await sb.storage.from('media').upload(path, b, { contentType: b.type || 'audio/mpeg' });
          if (error) throw new Error(error.message);
          paths.push(path);
        }
        toast('Creating the voice… this takes a few seconds');
        const r = await fetch(`${SUPABASE_URL}/functions/v1/voiceclone`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
          body: JSON.stringify({ action: 'create', circleId, name: val(fd, 'name'), paths }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || "Couldn't create the voice"); break; }
        await put('voices', { id: d.voiceId, name: val(fd, 'name'), ownerUser: rec.blob ? me.id : null, at: Date.now() });
        if (rec.url) URL.revokeObjectURL(rec.url);
        rec.blob = null; rec.url = '';
        toast('Voice ready ✓'); render();
        setTimeout(() => speak(`Hello, ${settings.name || 'there'}. It's me. I love you.`, { elevenVoiceId: d.voiceId }), 400);
        break;
      }
      case 'music-link-add': {
        const link = parseMusicLink(val(fd, 'url'));
        if (!link) { toast('Please paste a Spotify, Apple Music or YouTube link'); break; }
        toast('Looking up the song…');
        let info = {};
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/linkinfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ url: link.url }),
          });
          info = await r.json();
          if (!r.ok) { toast(info.error || "Couldn't look that up"); if (!val(fd, 'title')) break; info = {}; }
        } catch { info = {}; }
        await put('music', {
          id: uid(), provider: link.provider, url: link.url, embed: link.embed, open: link.open, tall: !!link.tall,
          title: val(fd, 'title') || info.title || 'Song', artist: info.artist || '', thumb: info.thumb || '', at: Date.now(),
        });
        toast('Song added'); render();
        break;
      }
      case 'song-add': {
        const files = fd.getAll('files').filter((f) => f.size);
        for (const f of files) await saveMedia(f, f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), true);
        toast(`Added ${files.length} song${files.length === 1 ? '' : 's'}`); render();
        break;
      }
      case 'caption-save': {
        const m = await get('media', form.dataset.id);
        m.caption = val(fd, 'caption');
        await put('media', m);
        toast('Saved');
        break;
      }
      case 'person-add': {
        const file = fd.get('file');
        const photoId = file && file.size ? await saveMedia(file, '', true) : null;
        await put('people', { id: uid(), name: val(fd, 'name'), relation: val(fd, 'relation'), phone: val(fd, 'phone'), photoId });
        toast('Person added'); render();
        break;
      }
      case 'about-save': {
        settings.about = {
          fullName: val(fd, 'fullName'), address: val(fd, 'address'), birthday: val(fd, 'birthday'),
          phone: val(fd, 'phone'), facts: String(fd.get('facts') || '').trim(),
        };
        settings.helpPersonId = fd.get('helpPersonId') || '';
        settings.units = fd.get('units') === 'celsius' ? 'celsius' : 'fahrenheit';
        const city = val(fd, 'city');
        let msg = 'Saved';
        if (city !== settings.city || (city && settings.lat == null)) {
          settings.city = city;
          settings.lat = settings.lon = null;
          settings.place = '';
          if (city) {
            try {
              const g = await geocode(city);
              if (g) Object.assign(settings, g); else msg = "Saved — but that town wasn't found";
            } catch { msg = 'Saved — weather lookup failed (offline?)'; }
          }
        }
        weather = null; weatherTried = 0;
        await put('settings', settings);
        toast(msg); render();
        break;
      }
      case 'eleven-save': {
        settings.voiceEngine = fd.get('voiceEngine') === 'device' ? 'device' : 'eleven';
        if (fd.get('elevenVoiceId')) settings.elevenVoiceId = String(fd.get('elevenVoiceId'));
        await put('settings', settings);
        toast('Voice saved');
        speak('Hello. This is how I will sound.');
        break;
      }
      case 'voice-save': {
        settings.voiceName = String(fd.get('voiceName') || '');
        settings.rate = Number(fd.get('rate')) || 0.85;
        await put('settings', settings);
        pickVoice();
        toast('Voice saved');
        speak('Hello. This is how I will sound.');
        break;
      }
      case 'settings-save': {
        settings.name = val(fd, 'name');
        settings.scale = Number(fd.get('scale'));
        settings.voice = fd.get('voice') === 'on';
        const pin = val(fd, 'pin');
        if (pin) {
          if (!/^\d{4,8}$/.test(pin)) { toast('PIN must be 4–8 digits'); break; }
          settings.pin = pin;
        }
        await put('settings', settings);
        applySettings();
        toast('Settings saved'); render();
        break;
      }
    }
  } catch (err) {
    console.error(err);
    toast('Sorry, that did not save. Please try again.');
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ================================================================ reminders
const snoozed = new Map();
const shown = new Set();
let overlayKey = null;

function hideOverlay() {
  $overlay.hidden = true;
  $overlay.innerHTML = '';
  overlayKey = null;
}

async function checkReminders() {
  if (overlayKey || session('care') === '1' || myRole !== 'device') return;
  const { items, doneMap } = await todayItems();
  const now = new Date();
  const hm = nowHM(now);
  const due = items.find((t) => {
    if (doneMap.has(t.key) || t.remindAt > hm) return false;
    if (now - hmToDate(t.remindAt, now) > 60 * 60 * 1000) return false; // only for an hour
    const snooze = snoozed.get(t.key);
    if (snooze) return now.getTime() >= snooze;
    return !shown.has(`${dayKey()}:${t.key}`);
  });
  if (!due) return;
  shown.add(`${dayKey()}:${due.key}`);
  snoozed.delete(due.key);
  overlayKey = due.key;
  const isEvent = due.kind === 'event';
  const label = isEvent ? `Coming up at ${fmtHM(due.time)}` : `It's ${fmtClock(now)}. Time to:`;
  $overlay.innerHTML = `
    <div class="ov-card" role="alertdialog" aria-labelledby="ov-what">
      <div class="ov-ic">${esc(due.icon)}</div>
      <div class="kicker">${esc(label)}</div>
      <div class="ov-what" id="ov-what">${esc(due.title)}</div>
      ${due.sub ? `<div class="ov-sub">${esc(due.sub)}</div>` : ''}
      <div class="ov-actions">
        ${isEvent
          ? `<button class="btn primary big" data-action="overlay-ok">Okay, thank you</button>`
          : `<button class="btn good big" data-action="overlay-done" data-id="${esc(due.key)}">${icon('check')} I did it</button>
             <button class="btn big" data-action="overlay-later" data-id="${esc(due.key)}">Remind me later</button>`}
      </div>
    </div>`;
  $overlay.hidden = false;
  chime();
  setTimeout(() => speak(isEvent
    ? `Just a gentle reminder. In one hour, at ${fmtHM(due.time)}, you have ${due.title}. ${due.sub || ''}`
    : `Just a gentle reminder. It's time to ${due.title.charAt(0).toLowerCase() + due.title.slice(1)}. ${due.sub || ''}`, { purpose: 'reminder' }), 1600);
}

// The family's chosen warm voice ("Brady J – Friendly, Casual, Warm").
const DEFAULT_ELEVEN_VOICE = '3svOJAOhuPHXwQC2H5eq';

async function setupEleven() {
  try {
    const r = await fetch(`${VOICE_FN}?status=1`, { headers: await authHeaders() });
    eleven.enabled = r.ok && (await r.json()).enabled;
  } catch { eleven.enabled = false; }
  if (eleven.enabled && !settings.elevenVoiceId) {
    const voices = await loadElevenVoices();
    const chosen = voices.find((v) => v.id === DEFAULT_ELEVEN_VOICE)
      || voices.slice().sort((x, y) => calmRank(y) - calmRank(x))[0];
    if (chosen) { settings.elevenVoiceId = chosen.id; await put('settings', settings); }
  }
  if (route() === 'care') render();
}

// ================================================================ sign-in & pairing screens
const welcomeHero = (title, sub) => {
  const part = partOfDay();
  return `
    <header class="hero sky-${part} welcome-hero">
      <div class="sun" aria-hidden="true"></div>
      <svg class="hills" viewBox="0 0 400 110" preserveAspectRatio="none" aria-hidden="true">
        <path class="h1" d="M0 70 C50 40 95 45 140 62 C185 78 220 30 280 38 C330 45 365 60 400 52 V110 H0Z"/>
        <path class="h2" d="M0 90 C60 72 120 80 190 90 C260 100 320 74 400 84 V110 H0Z"/>
      </svg>
      <div class="hero-text"><div class="season">Memory Companion</div><div class="day">${esc(title)}</div><div class="greet">${esc(sub)}</div></div>
    </header>`;
};
function showWelcome() {
  $app.innerHTML = welcomeHero('Welcome', 'A calm daily companion, shared with family.') + `
    <div class="paper stack-gap">
      <h2>Who is setting up this device?</h2>
      <button class="btn primary big wide" data-action="welcome-family">${icon('family')} I'm family or a caregiver</button>
      <p class="hint">Start here. Sign in with your email and set up your loved one's companion.</p>
      <button class="btn big wide" data-action="welcome-device">${icon('about')} This phone is for my loved one</button>
      <p class="hint">Use this on their phone, after a family member has set things up and given you a 6-digit code.</p>
    </div>`;
}
function showEmail() {
  const invited = !!local('invite');
  $app.innerHTML = welcomeHero(invited ? "You're invited" : 'Family sign in', invited ? 'Sign in with your email to join your family.' : 'We’ll email you a sign-in link.') + `
    <form class="paper stack" data-form="signin-email">
      <label>Your email <input type="email" name="email" required autocomplete="email" inputmode="email" autofocus></label>
      <button class="btn primary big" type="submit">Email me a sign-in link</button>
      <button class="btn ghost" type="button" data-action="welcome-back">‹ Back</button>
    </form>`;
  $app.querySelector('[autofocus]')?.focus();
}
function showCheckEmail(email) {
  $app.innerHTML = welcomeHero('Check your email', 'One more step.') + `
    <div class="paper">
      <p>We sent a sign-in link to <b>${esc(email)}</b>. It comes from Supabase and may take a minute.</p>
      <p><b>Open the email on this same device and tap the link.</b> It brings you right back here, signed in.</p>
      <p class="hint">Not there? Check spam or junk. You can ask for a new link in a few minutes.</p>
      <button class="btn ghost" data-action="welcome-family">‹ Use a different email</button>
    </div>`;
}
// The circle id that pairing/invite links carry (a UUID), or null.
const linkCircle = (v) => (/^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : null);
function showPair(code = '', circle = null) {
  const ready = /^\d{6}$/.test(code);
  $app.innerHTML = welcomeHero(ready ? 'Almost done' : 'Pair this phone', ready ? 'One tap and this phone is ready.' : 'Ask a family member for a 6-digit code.') + `
    <form class="paper stack" data-form="pair-code">
      ${ready ? `<p class="ready-text">Your family has set up a companion for you. Tap the button below.</p>
        <input type="hidden" name="code" value="${esc(code)}">${circle ? `<input type="hidden" name="circle" value="${esc(circle)}">` : ''}`
      : `<p>A family member gets the code in <b>Family tools → Family &amp; devices</b>.</p>
        <label>Pairing code <input type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="code-input" placeholder="123 456" autofocus></label>
        <label>Name this device <span class="hint">(optional)</span><input type="text" name="device" maxlength="40" placeholder="e.g. Mom's iPad"></label>`}
      <button class="btn primary big" type="submit">${ready ? 'Set up this phone' : 'Pair'}</button>
      ${ready ? '' : `<button class="btn ghost" type="button" data-action="welcome-back">‹ Back</button>`}
    </form>
    ${ready ? '' : `
    <div class="paper no-code">
      <h2>Don't have a code yet?</h2>
      <p>A family member sets things up first, on <b>their own</b> phone or computer. Then they send a link or show a QR code for this phone.</p>
      <button class="btn big wide" data-action="welcome-family">${icon('family')} I'm the family member, set up first</button>
    </div>`}`;
  $app.querySelector('[autofocus]')?.focus();
}
function showFamilyHasLink() {
  $app.innerHTML = welcomeHero('This link is for their phone', `You're signed in as family here.`) + `
    <div class="paper">
      <p>That setup link should be opened on <b>your loved one's</b> phone, not this one. Scan the QR code with their phone's camera, or send the link to them.</p>
      <button class="btn primary big wide" onclick="location.reload()">Go to Family tools</button>
    </div>`;
}
function showSetup() {
  if (local('invite')) return showJoin();
  $app.innerHTML = welcomeHero("Let's set things up", `Signed in as ${me.email || ''}`) + `
    <form class="paper stack" data-form="setup-circle">
      <h2>Who are you caring for?</h2>
      <label>Their first name <input type="text" name="name" required maxlength="40" placeholder="e.g. Mary" autofocus></label>
      <label>Your name, as they know you <input type="text" name="me" required maxlength="40" placeholder="e.g. Sarah (your daughter)"></label>
      <button class="btn primary big" type="submit">Create their companion</button>
      <p class="hint">We'll add a few example tasks to start — change or remove them anytime.</p>
    </form>
    <div class="paper"><p>Already invited by a relative?</p><button class="btn" data-action="join-instead">I have an invite code</button></div>`;
  $app.querySelector('[autofocus]')?.focus();
}
function showJoin() {
  $app.innerHTML = welcomeHero('Join your family', `Signed in as ${me.email || ''}`) + `
    <form class="paper stack" data-form="join-family">
      <label>Invite code <input type="text" name="code" required inputmode="numeric" maxlength="7" class="code-input" placeholder="123 456" value="${esc(local('invite') || '')}" ${local('invite') ? '' : 'autofocus'}></label>
      <label>Your name, as they know you <input type="text" name="me" required maxlength="40" placeholder="e.g. Tom (your son)" ${local('invite') ? 'autofocus' : ''}></label>
      <button class="btn primary big" type="submit">Join</button>
      <button class="btn ghost" type="button" onclick="localStorage.removeItem('invite');location.reload()">‹ Back</button>
    </form>`;
  $app.querySelector('[autofocus]')?.focus();
}

// The family's chosen warm voice ("Brady J – Friendly, Casual, Warm") is the default.
async function enterCircle() {
  const { data: rows, error } = await sb.from('members')
    .select('circle_id, role, display_name, created_at').eq('user_id', me.id).order('created_at');
  if (error) return showProblem(error.message);
  if (!rows.length) return me.is_anonymous ? showWelcome() : showSetup();
  const saved = local('circle');
  const row = rows.find((r) => r.circle_id === saved) || rows[0];
  circleId = row.circle_id; myRole = row.role; myName = row.display_name || '';
  local('circle', circleId);
  $app.innerHTML = '<div class="empty"><p>Loading…</p></div>';
  await loadCircle();
  await loadSettings();
  applySettings();
  pickVoice();
  setupEleven();
  listenLive();
  if (myRole === 'family' && (!location.hash || location.hash === '#home') && !session('seen-home')) {
    session('seen-home', '1');
    location.hash = '#care';
  }
  await render();
  startTimers();
}

let timersStarted = false;
function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  let lastDay = dayKey();
  setInterval(() => {
    document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = fmtClock(new Date()); });
    if (dayKey() !== lastDay) { lastDay = dayKey(); render(); }
    checkReminders();
  }, 20 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { softRender(); checkReminders(); } });
  setTimeout(checkReminders, 1500);
}

// ================================================================ start
(async function start() {
  if (!window.supabase) return showProblem('The app could not load. Please check the internet connection and try again.');
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Coming back from the email link: show any error, then tidy the address bar.
  const hashParams = new URLSearchParams(location.hash.slice(1));
  if (hashParams.get('error_description')) {
    history.replaceState(null, '', location.pathname);
    showWelcome();
    return toast(hashParams.get('error_description').replace(/\+/g, ' '));
  }
  const q = new URLSearchParams(location.search);
  const pairCode = (q.get('pair') || '').replace(/\D/g, '');
  const inviteCode = (q.get('invite') || '').replace(/\D/g, '');
  const pairCircle = linkCircle(q.get('c'));
  if (inviteCode) { local('invite', inviteCode); local('inviteCircle', pairCircle); }
  if (pairCode || inviteCode) history.replaceState(null, '', location.pathname + location.hash);

  const { data: { session: s } } = await sb.auth.getSession();
  if (location.hash.includes('access_token') || location.hash.includes('type=')) history.replaceState(null, '', location.pathname);
  if (!s) return pairCode ? showPair(pairCode, pairCircle) : inviteCode ? showEmail() : showWelcome();
  me = s.user;
  if (pairCode) {
    if (!me.is_anonymous) return showFamilyHasLink();
    const { count } = await sb.from('members').select('user_id', { count: 'exact', head: true }).eq('user_id', me.id);
    if (!count) return showPair(pairCode, pairCircle);
  }
  try { await enterCircle(); } catch (err) { console.error(err); showProblem(`Couldn't load: ${err.message}`); }
})();
