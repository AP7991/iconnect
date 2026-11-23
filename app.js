// iConnect for web. The phone does the real work; this page asks it things through Firebase.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, set, push, onValue, remove, get, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const SITE = "https://iconnect.australiantuition.com.au";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
const isPhone = matchMedia("(pointer:coarse)").matches && innerWidth < 820;

let db, auth, W = null, P = null, offset = 0, phoneAt = 0;
const S = { chats: [], folders: [], tags: [], feedOn: false, email: null, folder: "all", sub: null, key: null, msgs: [], imgs: new Map(), sort: localStorage.getItem("ic.sort") || "date", box: null, mails: [] };

// ---------- small helpers ----------
function toast(t) {
  const el = $("toast"); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3200);
}
function show(id) { for (const s of ["download", "pair", "app"]) $(s).hidden = s !== id; }
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function clock(t) { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function shortTime(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  if (sameDay(t, now)) return clock(t);
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}
function dayLabel(t) {
  const now = Date.now();
  if (sameDay(t, now)) return "Today";
  if (sameDay(t, now - 864e5)) return "Yesterday";
  return new Date(t).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
function when(t) {
  const d = new Date(t), now = Date.now();
  const day = sameDay(t, now) ? "Today" : sameDay(t, now + 864e5) ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return day + " " + clock(t);
}
const first = (n) => String(n || "").trim().split(/\s+/)[0] || n;
const folderById = (id) => S.folders.find((f) => f.id === id);
const chatByKey = (k) => S.chats.find((c) => c.key === k);

// ---------- start ----------
const cfg = window.ICONNECT_FIREBASE || {};
if (isPhone && !localStorage.getItem("ic.useWeb")) {
  show("download");
  fetch("version.json?t=" + Date.now()).then((r) => r.json()).then((v) => ($("dlVersion").textContent = "Version " + v.versionName)).catch(() => {});
  $("useWebAnyway").onclick = () => { localStorage.setItem("ic.useWeb", "1"); location.reload(); };
} else if (!cfg.apiKey) {
  show("pair"); $("setupNote").hidden = false; $("pairStatus").textContent = "Not set up yet";
} else {
  const fb = initializeApp(cfg);
  auth = getAuth(fb); db = getDatabase(fb);
  onValue(ref(db, ".info/serverTimeOffset"), (s) => (offset = s.val() || 0));
  onAuthStateChanged(auth, async (u) => {
    if (!u) { signInAnonymously(auth).catch((e) => { show("pair"); $("pairStatus").textContent = "Couldn't connect: " + e.message; }); return; }
    if (W) return;
    W = u.uid;
    P = localStorage.getItem("ic.phone");
    if (P) {
      try {
        const s = await get(ref(db, `users/${P}/webs/${W}`));
        if (s.exists()) return startApp();
      } catch (e) { /* not linked any more */ }
      localStorage.removeItem("ic.phone"); P = null;
    }
    startPairing();
  });
}

// ---------- pairing ----------
function randomCode(n) {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789", v = new Uint32Array(n);
  crypto.getRandomValues(v);
  return Array.from(v, (x) => a[x % a.length]).join("");
}
let pairUnsub = null;
async function startPairing() {
  show("pair");
  const nonce = randomCode(24);
  try {
    await set(ref(db, `pairs/${W}`), { nonce, created: serverTimestamp() });
  } catch (e) {
    $("pairStatus").textContent = "Couldn't make a code (" + e.message + ")"; return;
  }
  const qr = qrcode(0, "M");
  qr.addData(`${SITE}/#pair=${W}.${nonce}`); qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  $("pairStatus").textContent = "Waiting for your phone…";
  if (pairUnsub) pairUnsub();
  pairUnsub = onValue(ref(db, `pairs/${W}/phone`), (s) => {
    const p = s.val(); if (!p) return;
    pairUnsub(); pairUnsub = null;
    P = p; localStorage.setItem("ic.phone", P);
    remove(ref(db, `pairs/${W}`)).catch(() => {});
    startApp();
  });
}

// ---------- talking to the phone ----------
function ask(t, a = {}, timeout = 30000) {
  const r = push(ref(db, `sessions/${P}/req`));
  const rr = ref(db, `sessions/${P}/res/${r.key}`);
  return new Promise((resolve, reject) => {
    let unsub = null;
    const timer = setTimeout(() => {
      if (unsub) unsub(); remove(r).catch(() => {});
      reject(new Error("Your phone didn't answer. Check it's online and iConnect is open or connected."));
    }, timeout);
    unsub = onValue(rr, (s) => {
      const v = s.val(); if (!v) return;
      clearTimeout(timer); unsub(); remove(rr).catch(() => {});
      if (v.ok) { try { resolve(JSON.parse(v.d)); } catch (e) { resolve(v.d); } }
      else reject(new Error(v.e || "Something went wrong on the phone"));
    });
    set(r, { t, a: JSON.stringify(a), at: serverTimestamp(), w: W }).catch((e) => { clearTimeout(timer); if (unsub) unsub(); reject(e); });
  });
}

// ---------- the app ----------
let started = false, liveTimer = null;
function startApp() {
  if (started) return; started = true;
  show("app");
  // phone online?
  onValue(ref(db, `sessions/${P}/phone`), (s) => {
    const v = s.val() || {}; phoneAt = v.at || 0;
    $("phoneState").textContent = v.model ? v.model : "Phone";
    checkOnline();
  });
  setInterval(checkOnline, 10000);
  // unlinked from the phone?
  let seenLink = false;
  onValue(ref(db, `users/${P}/webs/${W}`), (s) => {
    if (s.exists()) { seenLink = true; return; }
    if (seenLink) { localStorage.removeItem("ic.phone"); toast("This computer was disconnected from your phone"); setTimeout(() => location.reload(), 1500); }
  });
  // something changed on the phone
  let firstLive = true;
  onValue(ref(db, `sessions/${P}/live`), () => {
    if (firstLive) { firstLive = false; return; }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { loadChats(); if (S.key) loadMsgs(false); }, 600);
  });
  wire();
  loadChats();
}
function checkOnline() {
  const off = !phoneAt || Date.now() + offset - phoneAt > 80000;
  $("offline").hidden = !off;
  $("phoneState").classList.toggle("off", off);
}

async function loadChats() {
  try {
    const d = await ask("convs");
    S.chats = d.chats || []; S.folders = d.folders || []; S.tags = d.tags || [];
    S.feedOn = !!d.feed; S.email = d.email;
    renderFolders(); renderChats(); renderBell();
    if (S.key) renderConvoHead();
  } catch (e) {
    $("chatList").innerHTML = `<div class="spin">${esc(e.message)}</div>`;
  }
}

// folders
function topFolders() { return S.folders.filter((f) => !f.parent); }
function kids(id) { return S.folders.filter((f) => f.parent === id); }
function subtree(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) { grew = false; for (const f of S.folders) if (f.parent && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; } }
  return out;
}
function folderChip(label, color, on, click) {
  const b = document.createElement("button");
  b.className = "fchip" + (on ? " on" : "");
  b.textContent = label;
  if (on) b.style.background = color; else b.style.color = color;
  b.onclick = click; return b;
}
function renderFolders() {
  const row = $("folders"); row.innerHTML = "";
  row.append(folderChip("All", "#2457D6", S.folder === "all", () => { S.folder = "all"; S.sub = null; renderFolders(); renderChats(); }));
  for (const f of topFolders()) {
    row.append(folderChip((f.emoji ? f.emoji + " " : "") + f.name, f.color, S.folder === f.id, () => { S.folder = f.id; S.sub = null; renderFolders(); renderChats(); }));
  }
  const sub = $("subfolders"); sub.innerHTML = "";
  if (S.folder !== "all" && kids(S.folder).length) {
    const top = folderById(S.folder);
    sub.append(folderChip("All in " + top.name, top.color, !S.sub, () => { S.sub = null; renderFolders(); renderChats(); }));
    for (const k of kids(S.folder)) sub.append(folderChip(k.name, k.color, S.sub === k.id, () => { S.sub = k.id; renderFolders(); renderChats(); }));
  }
}

function sorted(list) {
  const rank = (c) => {
    if (S.sort === "fup") return c.follow ? c.follow.due : Infinity;
    if (S.sort === "cal") return c.event ? c.event.at : Infinity;
    return 0;
  };
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const x = rank(a), y = rank(b);
    if (x !== y) return x < y ? -1 : 1;
    return b.date - a.date;
  });
}
function renderChats() {
  const q = $("search").value.trim().toLowerCase();
  let list = S.chats;
  if (q) list = list.filter((c) => (c.name + " " + c.snippet + " " + (c.addrs || []).join(" ") + " " + (c.email || "")).toLowerCase().includes(q));
  else if (S.folder !== "all") {
    const ids = subtree(S.sub || S.folder);
    list = list.filter((c) => ids.has(c.folder));
  }
  list = sorted(list);
  const box = $("chatList"); box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<div class="spin">${q ? "No chats match." : "No chats here."}</div>`; return; }
  for (const c of list) {
    const f = folderById(c.folder);
    const el = document.createElement("div");
    el.className = "row" + (c.key === S.key ? " on" : "");
    const chips = [];
    if (c.follow) chips.push(`<span class="chip ${c.follow.overdue ? "red" : "blue"}">⏰ ${esc(when(c.follow.due))}</span>`);
    if (c.event && c.event.at - Date.now() < 60 * 864e5) chips.push(`<span class="chip blue">📅 ${esc(when(c.event.at))} · ${esc(c.event.title)}</span>`);
    for (const id of c.tags || []) { const t = S.tags.find((x) => x.id === id); if (t) chips.push(`<span class="chip" style="color:${t.color}">${esc(t.name)}</span>`); }
    const snip = c.draft ? `<span style="color:var(--red)">Draft:</span> ${esc(c.draft)}` : (c.email ? "✉️ " : "") + esc(c.snippet);
    el.innerHTML = `<div class="main">
      <div class="line1"><span class="nm" style="color:${f ? f.color : "inherit"}">${c.pinned ? '<span class="pin">📌</span> ' : ""}${esc(c.name)}</span>
      <span class="tm ${c.unread ? "new" : ""}">${shortTime(c.date)}</span></div>
      <div class="line1"><div class="snip ${c.unread ? "bold" : ""}" style="flex:1">${snip}</div>${c.unread ? `<span class="count">${c.unread}</span>` : ""}</div>
      ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}</div>`;
    el.onclick = () => openChat(c.key);
    box.append(el);
  }
}

// ---------- a conversation ----------
async function openChat(key) {
  await saveDraft();
  S.key = key; S.msgs = [];
  $("convoEmpty").hidden = true; $("convoBody").hidden = false;
  renderChats(); renderConvoHead();
  $("msgs").innerHTML = '<div class="spin">Loading messages…</div>';
  const c = chatByKey(key);
  $("input").value = (c && c.draft) || ""; autosize();
  if (c) c.unread = 0;
  loadMsgs(true);
}
function renderConvoHead() {
  const c = chatByKey(S.key); if (!c) return;
  const f = folderById(c.folder);
  $("convoName").textContent = c.name; $("convoName").style.color = f ? f.color : "";
  $("convoSub").textContent = c.email ? c.email + (c.subject ? " · " + c.subject : "") : (c.addrs || []).join(", ") + (f ? " · " + f.name : "");
  const links = $("convoLinks"); links.innerHTML = "";
  for (const k of c.links || []) {
    const o = chatByKey(k); if (!o) continue;
    const s = document.createElement("span"); s.className = "chip blue link"; s.textContent = "🔗 " + o.name;
    s.onclick = () => openChat(k); links.append(s);
  }
  $("pinBtn").classList.toggle("on", !!c.pinned);
  $("fuBtn").classList.toggle("on", !!c.follow);
  $("evBtn").hidden = false;
}
async function loadMsgs(scroll) {
  const key = S.key, c = chatByKey(key); if (!c) return;
  try {
    const d = await ask("msgs", { key, tid: c.tid, group: c.group, limit: 150 });
    if (S.key !== key) return;
    const box = $("msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    S.msgs = d.msgs || [];
    renderMsgs();
    if (scroll || atBottom) box.scrollTop = box.scrollHeight;
  } catch (e) {
    if (S.key === key) $("msgs").innerHTML = `<div class="spin">${esc(e.message)}</div>`;
  }
}
function renderMsgs() {
  const c = chatByKey(S.key), box = $("msgs"); box.innerHTML = "";
  let last = 0;
  for (const m of S.msgs) {
    if (!last || !sameDay(last, m.date)) { const d = document.createElement("div"); d.className = "day"; d.textContent = dayLabel(m.date); box.append(d); }
    last = m.date;
    const b = document.createElement("div");
    const failed = !m.in && m.type === 5;
    b.className = "bub " + (m.in ? "in" : "out") + (failed ? " failed" : "");
    let html = "";
    if (c && c.group && m.in && m.senderName) html += `<div class="from">${esc(m.senderName)}</div>`;
    if (c && c.email && m.subject && m.in) html += "";
    for (const id of m.images || []) html += `<img data-img="${id}" alt="Picture" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="240" height="180" style="background:#0001">`;
    if (m.videos) html += `<div>🎬 Video (open on your phone)</div>`;
    if (m.audios) html += `<div>🎤 Voice message (open on your phone)</div>`;
    if (m.atts) html += `<div>📎 ${m.atts} attachment${m.atts > 1 ? "s" : ""} (open on your phone)</div>`;
    html += linkify(m.body || "");
    html += `<span class="t">${clock(m.date)}${failed ? " · Not sent" : m.pending || m.type === 4 || m.type === 6 ? " · Sending" : ""}</span>`;
    b.innerHTML = html;
    box.append(b);
  }
  for (const img of box.querySelectorAll("img[data-img]")) loadImg(img);
}
async function loadImg(img) {
  const id = img.dataset.img;
  if (S.imgs.has(id)) { img.src = S.imgs.get(id); img.removeAttribute("style"); img.removeAttribute("width"); img.removeAttribute("height"); return; }
  try {
    const b64 = await ask("img", { id: Number(id) }, 45000);
    const url = "data:image/jpeg;base64," + b64; S.imgs.set(id, url);
    img.src = url; img.removeAttribute("style"); img.removeAttribute("width"); img.removeAttribute("height");
    img.onclick = () => window.open().document.write(`<img src="${url}" style="max-width:100%">`);
  } catch (e) { img.alt = "Picture couldn't load"; }
}
async function sendMessage(e) {
  e && e.preventDefault();
  const text = $("input").value.trim(); if (!text || !S.key) return;
  const c = chatByKey(S.key);
  $("input").value = ""; autosize();
  if (c) c.draft = "";
  S.msgs.push({ in: false, body: text, date: Date.now(), pending: true });
  renderMsgs(); $("msgs").scrollTop = $("msgs").scrollHeight;
  try {
    await ask("send", { key: c.key, tid: c.tid, addrs: c.addrs, text, email: c.email, subject: c.subject });
    setTimeout(() => loadMsgs(true), 1500);
  } catch (err) {
    toast("Not sent: " + err.message); $("input").value = text; autosize();
    S.msgs.pop(); renderMsgs();
  }
}
let lastDraftSaved = "";
async function saveDraft() {
  if (!S.key) return;
  const c = chatByKey(S.key), text = $("input").value;
  if (!c || (c.draft || "") === text || lastDraftSaved === S.key + "\u0000" + text) return;
  c.draft = text; lastDraftSaved = S.key + "\u0000" + text;
  ask("draft", { key: c.key, text }).catch(() => {});
  renderChats();
}
function autosize() { const t = $("input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }

// ---------- modals ----------
function modal(title, body, onReady) {
  $("modalBox").innerHTML = `<h3>${esc(title)}<button data-close aria-label="Close">✕</button></h3>${body}`;
  $("modal").hidden = false;
  $("modalBox").querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  if (onReady) onReady($("modalBox"));
}
function closeModal() { $("modal").hidden = true; $("modalBox").innerHTML = ""; }
$("modal").addEventListener("mousedown", (e) => { if (e.target === $("modal") && !$("modalBox").dataset.sticky) closeModal(); });

function pathName(f) { const p = f.parent && folderById(f.parent); return p ? pathName(p) + " › " + f.name : f.name; }

function tagModal() {
  const c = chatByKey(S.key);
  const rows = S.tags.map((t) => `<label class="check"><input type="checkbox" value="${esc(t.id)}" ${c.tags.includes(t.id) ? "checked" : ""}> <span style="color:${t.color}">${esc(t.name)}</span></label>`).join("");
  modal("Tags for " + c.name, (rows || '<p class="muted">No tags yet. Make tags in the app (Folders and settings).</p>') + '<div class="acts"><button class="btn small ghost" data-close>Cancel</button><button class="btn small" id="tagSave">Save</button></div>', (m) => {
    m.querySelector("#tagSave").onclick = async () => {
      const ids = [...m.querySelectorAll("input:checked")].map((i) => i.value);
      closeModal(); c.tags = ids; renderChats();
      try { await ask("tags", { key: c.key, ids }); toast("Tags saved"); } catch (e) { toast(e.message); }
    };
  });
}
function moveModal() {
  const c = chatByKey(S.key);
  const list = S.folders.map((f) => `<button data-f="${esc(f.id)}" style="color:${f.color}">${f.id === c.folder ? "✓ " : ""}${esc(pathName(f))}</button>`).join("");
  modal("Move " + c.name + " to…", `<div class="pick">${list}</div>`, (m) => {
    m.querySelectorAll("[data-f]").forEach((b) => (b.onclick = async () => {
      closeModal(); c.folder = b.dataset.f; renderChats(); renderConvoHead();
      try { await ask("move", { key: c.key, folder: b.dataset.f, name: c.name }); toast("Moved"); } catch (e) { toast(e.message); }
    }));
  });
}
function followModal() {
  const c = chatByKey(S.key);
  const d = new Date(); const at9 = (days) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(9, 0, 0, 0); return x.getTime(); };
  const opts = [["In 1 hour", Date.now() + 36e5], ["This evening", (() => { const x = new Date(); x.setHours(18, 0, 0, 0); return x < d ? x.getTime() + 864e5 : x.getTime(); })()], ["Tomorrow 9am", at9(1)], ["In 2 days", at9(2)], ["Next week", at9(7)]];
  modal("Follow up with " + first(c.name), `
    <div class="pills" id="fuType"><button class="pillBtn on" data-t="me">Remind me to follow up</button><button class="pillBtn" data-t="them">Remind me if they don't reply</button></div>
    <label>When</label><div class="pills" id="fuWhen">${opts.map(([l, t]) => `<button class="pillBtn" data-at="${t}">${l}</button>`).join("")}</div>
    <label>Or pick a time</label><input type="datetime-local" id="fuCustom">
    <div class="acts">${c.follow ? '<button class="btn small danger" id="fuRemove">Remove follow-up</button>' : ""}<button class="btn small ghost" data-close>Cancel</button><button class="btn small" id="fuSave">Save</button></div>`, (m) => {
    let type = c.follow ? c.follow.type : "me", due = 0;
    m.querySelectorAll("#fuType button").forEach((b) => { b.classList.toggle("on", b.dataset.t === type); b.onclick = () => { type = b.dataset.t; m.querySelectorAll("#fuType button").forEach((x) => x.classList.toggle("on", x === b)); }; });
    m.querySelectorAll("#fuWhen button").forEach((b) => (b.onclick = () => { due = Number(b.dataset.at); m.querySelector("#fuCustom").value = ""; m.querySelectorAll("#fuWhen button").forEach((x) => x.classList.toggle("on", x === b)); }));
    const save = async (dueAt) => {
      closeModal();
      try { await ask("follow", { key: c.key, tid: c.tid, name: c.name, addrs: c.addrs, group: c.group, type, due: dueAt }); toast(dueAt ? "Follow-up set for " + when(dueAt) : "Follow-up removed"); loadChats(); }
      catch (e) { toast(e.message); }
    };
    m.querySelector("#fuSave").onclick = () => { const cu = m.querySelector("#fuCustom").value; const t = cu ? new Date(cu).getTime() : due; if (!t) return toast("Pick when"); save(t); };
    const r = m.querySelector("#fuRemove"); if (r) r.onclick = () => save(0);
  });
}

function eventModal(withKeys) {
  const c = chatByKey(S.key);
  const people = [c.key, ...(withKeys || [])].filter((k, i, a) => k && a.indexOf(k) === i).map(chatByKey).filter(Boolean);
  const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(18, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const linked = (c.links || []).map(chatByKey).filter(Boolean);
  $("modalBox").dataset.sticky = "1";
  modal(people.length > 1 ? `Event with ${first(people[0].name)} & ${first(people[1].name)}` : "Plan an event", `
    <input id="evTitle" placeholder="Title, e.g. Lesson with {first}">
    <div class="two"><div><label>Date</label><input type="date" id="evDate" value="${dateStr}"></div><div><label>Time</label><input type="time" id="evTime" value="18:00"></div></div>
    <label>How long</label><div class="pills" id="evLen">${[["30 min", 30], ["1 hr", 60], ["2 hr", 120], ["3 hr", 180], ["All day", -1]].map(([l, v]) => `<button class="pillBtn ${v === 60 ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div>
    <label>Repeat</label><div class="pills" id="evRep">${[["Never", ""], ["Daily", "DAILY"], ["Weekly", "WEEKLY"], ["2 weeks", "FORTNIGHTLY"], ["Monthly", "MONTHLY"]].map(([l, v]) => `<button class="pillBtn ${v === "" ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div>
    <div id="evCountRow" hidden><label>How many times</label><input type="number" id="evCount" value="10" min="2" max="200"></div>
    <label>Where</label><input id="evWhere" placeholder="Optional">
    <label>Description</label><textarea id="evNote" rows="3" placeholder="Hi {first}, see you {date} at {time}">${esc(people.length > 1 ? people.map((p) => `${p.name}: ${(p.addrs || []).join(", ")}${p.email ? " · " + p.email : ""}`).join("\n") : "")}</textarea>
    <p class="muted small">Merge fields fill in for each person: {first} {name} {me} {date} {time} {where}</p>
    <label>Invite</label><div id="evPeople"></div>
    <div class="pills" style="margin-top:8px">${linked.filter((l) => !people.includes(l)).map((l) => `<button class="pillBtn" data-add="${esc(l.key)}">🔗 ${esc(l.name)}</button>`).join("")}<button class="pillBtn" id="evAdd">+ Someone else</button></div>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="evIcs" checked> Add it to my calendar (downloads a calendar file)</label>
    <div class="acts"><button class="btn small" id="evSend">Send invite</button></div>`, (m) => {
    let len = 60, freq = "";
    const sel = (id, fn) => m.querySelectorAll(`#${id} button`).forEach((b) => (b.onclick = () => { m.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b)); fn(b.dataset.v); }));
    sel("evLen", (v) => { len = Number(v); m.querySelector("#evTime").disabled = len < 0; });
    sel("evRep", (v) => { freq = v; m.querySelector("#evCountRow").hidden = !v; });
    const drawPeople = () => {
      m.querySelector("#evPeople").innerHTML = people.map((p, i) => `<div class="todo"><div class="main"><b>${esc(p.name)}</b><div class="muted small">${esc(p.email || (p.addrs || []).join(", "))}</div></div>
        ${p.email ? "" : `<label class="check"><input type="checkbox" data-text="${i}" checked> Text</label>`}
        <label class="check"><input type="checkbox" data-mail="${i}" ${p.email || people.length > 1 ? "checked" : ""}> Email</label>
        ${i > 0 ? `<button class="iconBtn" data-rm="${i}" title="Remove">✕</button>` : ""}</div>`).join("");
      m.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { people.splice(Number(b.dataset.rm), 1); drawPeople(); }));
    };
    drawPeople();
    m.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => { const p = chatByKey(b.dataset.add); if (p && !people.includes(p)) people.push(p); b.remove(); drawPeople(); }));
    m.querySelector("#evAdd").onclick = () => pickChat((p) => { if (!people.includes(p)) people.push(p); drawPeople(); });
    m.querySelector("#evSend").onclick = async () => {
      const title = m.querySelector("#evTitle").value.trim(); if (!title) return toast("Give it a title first");
      const [y, mo, d] = m.querySelector("#evDate").value.split("-").map(Number);
      const [h, mi] = (m.querySelector("#evTime").value || "18:00").split(":").map(Number);
      const allDay = len < 0;
      const s = allDay ? new Date(y, mo - 1, d).getTime() : new Date(y, mo - 1, d, h, mi).getTime();
      const end = allDay ? s : s + len * 60000;
      let rrule = "";
      if (freq) rrule = (freq === "FORTNIGHTLY" ? "FREQ=WEEKLY;INTERVAL=2" : "FREQ=" + freq) + ";COUNT=" + Math.max(2, Math.min(200, Number(m.querySelector("#evCount").value) || 10));
      const ppl = people.map((p, i) => ({
        name: p.name, key: p.key, email: p.email || "", phone: p.email || p.group ? "" : (p.addrs || [])[0] || "",
        text: !!(m.querySelector(`[data-text="${i}"]`) || {}).checked, mail: !!(m.querySelector(`[data-mail="${i}"]`) || {}).checked,
      }));
      const ev = { title, where: m.querySelector("#evWhere").value.trim(), note: m.querySelector("#evNote").value.trim(), start: s, end, allDay, rrule, people: ppl };
      if (m.querySelector("#evIcs").checked) downloadIcs(ev);
      delete $("modalBox").dataset.sticky; closeModal();
      try { const n = await ask("event", ev, 60000); toast(`Invite sent (${n} message${n == 1 ? "" : "s"})`); loadChats(); }
      catch (e) { toast("Invite not sent: " + e.message); }
    };
  });
  $("modalBox").querySelector("[data-close]").onclick = () => { delete $("modalBox").dataset.sticky; closeModal(); };
}
function downloadIcs(ev) {
  const z = (t) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = (t) => { const d = new Date(t); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };
  const e = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//iConnect//EN", "BEGIN:VEVENT", "UID:" + Date.now() + "@iconnect", "DTSTAMP:" + z(Date.now()),
    ev.allDay ? "DTSTART;VALUE=DATE:" + day(ev.start) : "DTSTART:" + z(ev.start), ev.allDay ? "DTEND;VALUE=DATE:" + day(ev.start + 864e5) : "DTEND:" + z(ev.end),
    "SUMMARY:" + e(ev.title.replace(/\{\w+\}/g, "")), ev.where ? "LOCATION:" + e(ev.where) : "", ev.note ? "DESCRIPTION:" + e(ev.note) : "", ev.rrule ? "RRULE:" + ev.rrule : "", "END:VEVENT", "END:VCALENDAR"].filter(Boolean);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
  a.download = "event.ics"; a.click();
}
// small chooser layered over the event modal
function pickChat(done) {
  const wrap = document.createElement("div"); wrap.className = "modalWrap"; wrap.style.zIndex = 70;
  wrap.innerHTML = `<div class="modal"><h3>Invite someone<button aria-label="Close">✕</button></h3><input placeholder="Search chats"><div class="pick" style="margin-top:10px"></div></div>`;
  document.body.append(wrap);
  const list = wrap.querySelector(".pick"), input = wrap.querySelector("input");
  const draw = () => {
    const q = input.value.toLowerCase();
    list.innerHTML = "";
    for (const c of S.chats.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 60)) {
      const b = document.createElement("button"); b.textContent = c.name; b.onclick = () => { wrap.remove(); done(c); }; list.append(b);
    }
  };
  wrap.querySelector("h3 button").onclick = () => wrap.remove();
  input.oninput = draw; draw(); input.focus();
}
function newChatModal() {
  modal("New message", `<label>To (phone number)</label><input id="ncTo" placeholder="e.g. 0400 123 456"><label>Or pick a chat</label><input id="ncSearch" placeholder="Search"><div class="pick" id="ncList"></div>
    <label>Message</label><textarea id="ncText" rows="3"></textarea><div class="acts"><button class="btn small ghost" data-close>Cancel</button><button class="btn small" id="ncSend">Send</button></div>`, (m) => {
    const draw = () => {
      const q = m.querySelector("#ncSearch").value.toLowerCase(), l = m.querySelector("#ncList"); l.innerHTML = "";
      if (!q) return;
      for (const c of S.chats.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)) { const b = document.createElement("button"); b.textContent = c.name; b.onclick = () => { closeModal(); openChat(c.key); }; l.append(b); }
    };
    m.querySelector("#ncSearch").oninput = draw;
    m.querySelector("#ncSend").onclick = async () => {
      const to = m.querySelector("#ncTo").value.replace(/[^\d+]/g, ""), text = m.querySelector("#ncText").value.trim();
      if (!to || !text) return toast("Enter a number and a message");
      closeModal();
      try { await ask("send", { key: "", addrs: [to], text }); toast("Sent"); setTimeout(loadChats, 2000); } catch (e) { toast("Not sent: " + e.message); }
    };
  });
}
function renderBell() {
  const f = S.chats.filter((c) => c.follow), over = f.filter((c) => c.follow.overdue).length;
  const b = $("bellCount"); b.hidden = !f.length; b.textContent = f.length; b.classList.toggle("red", over > 0);
}
function todoModal() {
  const f = S.chats.filter((c) => c.follow).sort((a, b) => a.follow.due - b.follow.due);
  modal("To-do and follow-ups", f.length ? f.map((c) => `<div class="todo"><div class="main" data-open="${esc(c.key)}"><b>${esc(c.name)}</b>
    <div class="small" style="color:${c.follow.overdue ? "var(--red)" : "var(--text3)"}">${c.follow.type === "them" ? "If no reply by" : "Follow up"} ${esc(when(c.follow.due))}</div></div>
    <button class="btn small ghost" data-done="${esc(c.key)}">Done</button></div>`).join("") : '<p class="muted">Nothing to follow up. 🎉</p>', (m) => {
    m.querySelectorAll("[data-open]").forEach((d) => (d.onclick = () => { closeModal(); showTab("chats"); openChat(d.dataset.open); }));
    m.querySelectorAll("[data-done]").forEach((b) => (b.onclick = async () => {
      b.closest(".todo").remove();
      try { await ask("follow", { key: b.dataset.done, due: 0 }); loadChats(); } catch (e) { toast(e.message); }
    }));
  });
}

// ---------- email ----------
let mailLoaded = false;
async function loadBoxes() {
  if (!S.email) { $("boxList").innerHTML = '<p class="muted small">Connect your email in the iConnect app first.</p>'; return; }
  $("boxList").innerHTML = '<div class="spin">Loading…</div>';
  try {
    const boxes = await ask("boxes", {}, 45000);
    const l = $("boxList"); l.innerHTML = "";
    for (const b of boxes) {
      const el = document.createElement("button"); el.className = "box" + (b.name === S.box ? " on" : ""); el.textContent = b.label;
      el.onclick = () => { S.box = b.name; l.querySelectorAll(".box").forEach((x) => x.classList.toggle("on", x === el)); loadBox(); };
      l.append(el);
    }
    if (!S.box && boxes.length) { S.box = boxes[0].name; l.firstChild.classList.add("on"); loadBox(); }
    mailLoaded = true;
  } catch (e) { $("boxList").innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
}
async function loadBox() {
  const l = $("mailList"); l.innerHTML = '<div class="spin">Loading emails…</div>';
  try {
    S.mails = await ask("box", { box: S.box }, 60000);
    l.innerHTML = "";
    for (const m of S.mails) {
      const el = document.createElement("div"); el.className = "row";
      el.innerHTML = `<div class="main"><div class="line1"><span class="nm" style="font-size:15px;${m.seen ? "font-weight:600" : ""}">${esc(m.from)}</span><span class="tm">${shortTime(m.date)}</span></div>
        <div class="snip ${m.seen ? "" : "bold"}">${esc(m.subject)}</div><div class="snip small">${esc(m.preview)}</div></div>`;
      el.onclick = () => { l.querySelectorAll(".row").forEach((x) => x.classList.toggle("on", x === el)); openMail(m); };
      l.append(el);
    }
    if (!S.mails.length) l.innerHTML = '<div class="spin">No emails here.</div>';
  } catch (e) { l.innerHTML = `<div class="spin">${esc(e.message)}</div>`; }
}
async function openMail(m) {
  const v = $("mailView"); v.innerHTML = '<div class="spin">Opening…</div>';
  try {
    const d = await ask("mail", { box: S.box, uid: m.uid }, 60000);
    v.innerHTML = `<div class="mailHead"><h2>${esc(d.subject)}</h2><div><b>${esc(d.from || d.fromAddr)}</b> <span class="muted small">&lt;${esc(d.fromAddr)}&gt; · ${esc(new Date(d.date).toLocaleString())}</span></div>
      <div class="muted small">To: ${esc(d.to)}${d.cc ? " · Cc: " + esc(d.cc) : ""}</div>
      ${d.atts.length ? `<div class="chips">${d.atts.map((a) => `<span class="chip">📎 ${esc(a.name)}</span>`).join("")}</div>` : ""}
      <div style="margin-top:10px"><button class="btn small" id="replyBtn">Reply</button></div></div>`;
    const fr = document.createElement("iframe"); fr.className = "mailFrame"; fr.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    fr.srcdoc = `<base target="_blank"><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;margin:18px 22px;color:#15171C}</style>` + (d.html || `<pre style="white-space:pre-wrap;font-family:inherit">${esc(d.body)}</pre>`);
    v.append(fr);
    $("replyBtn").onclick = () => mailCompose(d.fromAddr, /^re:/i.test(d.subject) ? d.subject : "Re: " + d.subject);
  } catch (e) { v.innerHTML = `<div class="spin">${esc(e.message)}</div>`; }
}
function mailCompose(to = "", subject = "") {
  modal("New email", `<label>To</label><input id="mTo" value="${esc(to)}"><label>Subject</label><input id="mSubj" value="${esc(subject)}">
    <label>Message</label><textarea id="mBody" rows="8"></textarea><p class="muted small">Your signature is added by your phone.</p>
    <div class="acts"><button class="btn small ghost" data-close>Cancel</button><button class="btn small" id="mSend">Send</button></div>`, (m) => {
    m.querySelector(to ? "#mBody" : "#mTo").focus();
    m.querySelector("#mSend").onclick = async () => {
      const a = { to: m.querySelector("#mTo").value.trim(), subject: m.querySelector("#mSubj").value.trim(), body: m.querySelector("#mBody").value };
      if (!a.to) return toast("Who's it to?");
      closeModal();
      try { await ask("mailsend", a, 60000); toast("Email sent"); } catch (e) { toast("Not sent: " + e.message); }
    };
  });
}

// ---------- feed ----------
async function loadFeed() {
  const l = $("feedList");
  if (!S.feedOn) { l.innerHTML = '<p class="spin">Sign in to the feed in the iConnect app first (⋮ → Feed).</p>'; $("postForm").hidden = true; return; }
  $("postForm").hidden = false;
  l.innerHTML = '<div class="spin">Loading…</div>';
  try {
    const posts = await ask("feed", {}, 45000);
    l.innerHTML = posts.length ? "" : '<p class="spin">No posts yet.</p>';
    for (const p of posts) {
      const el = document.createElement("div"); el.className = "post";
      const media = p.media ? (p.type === "video" || p.type === "reel" ? `<video src="${esc(p.media)}" controls playsinline></video>` : `<img src="${esc(p.media)}" alt="">`) : "";
      el.innerHTML = `<div class="ph">${esc(p.name)} <span class="muted small">· ${shortTime(p.created)}</span></div><div class="pt">${linkify(p.text)}</div>${media}
        <div class="acts"><button>${p.liked ? "❤️" : "🤍"} ${p.likes}</button><span>💬 ${p.comments}</span></div>`;
      el.querySelector(".acts button").onclick = async (e) => {
        p.liked = !p.liked; p.likes += p.liked ? 1 : -1; e.currentTarget.textContent = `${p.liked ? "❤️" : "🤍"} ${p.likes}`;
        ask("like", { id: p.id, author: p.author, on: p.liked }).catch((er) => toast(er.message));
      };
      l.append(el);
    }
  } catch (e) { l.innerHTML = `<p class="spin">${esc(e.message)}</p>`; }
}

// ---------- wiring ----------
function showTab(t) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  for (const p of ["chats", "email", "feed"]) $(p).hidden = p !== t;
  if (t === "email" && !mailLoaded) loadBoxes();
  if (t === "feed") loadFeed();
}
function wire() {
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("search").oninput = renderChats;
  $("sort").value = S.sort;
  $("sort").onchange = () => { S.sort = $("sort").value; localStorage.setItem("ic.sort", S.sort); renderChats(); };
  $("composer").onsubmit = sendMessage;
  $("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  $("input").addEventListener("input", autosize);
  $("input").addEventListener("blur", saveDraft);
  window.addEventListener("beforeunload", saveDraft);
  $("pinBtn").onclick = async () => { const c = chatByKey(S.key); c.pinned = !c.pinned; renderChats(); renderConvoHead(); try { await ask("pin", { key: c.key, on: c.pinned }); } catch (e) { toast(e.message); } };
  $("tagBtn").onclick = tagModal;
  $("moveBtn").onclick = moveModal;
  $("fuBtn").onclick = followModal;
  $("evBtn").onclick = () => eventModal();
  $("bell").onclick = todoModal;
  $("newChat").onclick = newChatModal;
  $("composeMail").onclick = () => mailCompose();
  $("postForm").onsubmit = async (e) => {
    e.preventDefault(); const text = $("postText").value.trim(); if (!text) return;
    $("postText").value = "";
    try { await ask("post", { text }, 45000); toast("Posted"); loadFeed(); } catch (er) { toast(er.message); $("postText").value = text; }
  };
  $("menuBtn").onclick = (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; };
  document.addEventListener("click", () => ($("menu").hidden = true));
  $("refreshBtn").onclick = () => { loadChats(); if (S.key) loadMsgs(false); };
  $("disconnectBtn").onclick = async () => {
    if (!confirm("Disconnect this computer from your phone?")) return;
    try { await remove(ref(db, `users/${P}/webs/${W}`)); } catch (e) { /* already gone */ }
    localStorage.removeItem("ic.phone"); location.reload();
  };
  // drawing a line from one chat to another (same as the app): hold Alt and drag between two chats
  enableLineDraw();
}

// Draw a line from one person to another in the chat list → plan an event with both.
function enableLineDraw() {
  const list = $("chatList");
  let from = null, path = [], svg = null, poly = null;
  const rowKey = (el) => { const r = el && el.closest(".row"); if (!r) return null; const i = [...list.children].indexOf(r); return i >= 0 ? rowsShown()[i] : null; };
  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.clientX - list.getBoundingClientRect().left > 70) return;
    from = rowKey(e.target); if (!from) return;
    e.preventDefault(); path = [[e.clientX, e.clientY]];
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("style", "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:40");
    poly = document.createElementNS(svg.namespaceURI, "polyline");
    poly.setAttribute("style", "fill:none;stroke:#2457D6;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;opacity:.55");
    svg.append(poly); document.body.append(svg);
  });
  window.addEventListener("mousemove", (e) => { if (!from || !svg) return; path.push([e.clientX, e.clientY]); poly.setAttribute("points", path.map((p) => p.join(",")).join(" ")); });
  window.addEventListener("mouseup", (e) => {
    if (!from || !svg) return;
    const to = rowKey(document.elementFromPoint(e.clientX, e.clientY));
    const s = svg, p = poly, start = from; from = null; svg = null;
    if (!to || to === start || path.length < 4) { s.remove(); return; }
    // retrace with a glowing comet, then fade
    p.setAttribute("style", "fill:none;stroke:#2457D6;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 6px #5B9BFF)");
    const len = p.getTotalLength(); p.style.strokeDasharray = `${len * 0.45} ${len}`; p.style.strokeDashoffset = len * 0.45;
    p.animate([{ strokeDashoffset: len * 0.45 }, { strokeDashoffset: -len }], { duration: 850, easing: "ease-in-out" }).onfinish = () => {
      s.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250 }).onfinish = () => {
        s.remove();
        S.key = start; openChat(start).then(() => eventModal([to]));
      };
    };
  });
  function rowsShown() {
    // the keys in the order they're drawn
    const q = $("search").value.trim().toLowerCase();
    let l = S.chats;
    if (q) l = l.filter((c) => (c.name + " " + c.snippet + " " + (c.addrs || []).join(" ") + " " + (c.email || "")).toLowerCase().includes(q));
    else if (S.folder !== "all") { const ids = subtree(S.sub || S.folder); l = l.filter((c) => ids.has(c.folder)); }
    return sorted(l).map((c) => c.key);
  }
}
