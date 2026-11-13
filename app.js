/* BrainMaid family app: one shared hub for Ryan and Tamlyn. */
(function () {
"use strict";

/* ---------- setup ---------- */
const CFG = window.BM_CONFIG || {};
const sb = (window.supabase && CFG.url && CFG.key) ? window.supabase.createClient(CFG.url, CFG.key) : null;
const TABLES = { tasks: "tasks", events: "events", lists: "lists", items: "list_items", meals: "meals", ratings: "meal_ratings", plan: "plan", members: "members" };
const AISLES = ["Meat", "Fruit & veg", "Dairy & eggs", "Bakery", "Freezer", "Cupboard", "Sauces & spice", "Other"];
const DKEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DSHORT = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };
const NAMES = { R: "Ryan", T: "Tamlyn" };

const S = {
  session: null, me: null, notInvited: false, loaded: false, authMode: "in", authMsg: "",
  tab: "today", tasks: [], events: [], lists: [], items: [], meals: [], ratings: [], members: [], plan: null,
  listId: null, tier: "w", mealWeek: null, calDays: 60, sheet: null, form: null
};
try { S.tab = localStorage.getItem("bm.tab") || "today"; } catch (_) {}

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parse = s => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const sameDay = (a, b) => ymd(a) === ymd(b);
function dayLabel(d) {
  const t = today(), diff = Math.round((d - t) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString("en-ZA", { weekday: "long" });
  return d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
}
const hm = t => t ? String(t).slice(0, 5) : "";
const mine = () => (S.me && S.me.initials) || "R";
const partner = () => mine() === "R" ? "T" : "R";
const nameOf = i => { const m = S.members.find(x => x.initials === i); return (m && m.name) || NAMES[i] || i; };
const whoChip = w => w ? `<span class="who ${esc(w)}">${w === "both" ? "R+T" : esc(w)}</span>` : "";
const keyOf = n => String(n).toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }
function guessAisle(n) {
  const s = n.toLowerCase();
  const map = [["Meat", /chicken|beef|mince|steak|sirloin|rump|lamb|pork|bacon|sausage|boerewors|biltong|thigh|fillet/],
    ["Dairy & eggs", /milk|yog|cheese|cheddar|mozz|butter|cream|egg|hummus/],
    ["Bakery", /bread|roll|wrap|tortilla|pita|roti|flatbread|bun/],
    ["Freezer", /frozen|ice cream|peas/],
    ["Sauces & spice", /sauce|peri|chilli|chili|spice|paste|salsa|relish|mayo|ketchup|soy|vinegar|jalap|peppadew|masala|paprika|oregano|salt/],
    ["Fruit & veg", /apple|banana|berr|pear|naartjie|grape|lemon|lime|avo|tomato|potato|onion|garlic|ginger|carrot|courgette|broccoli|spinach|lettuce|salad|rocket|pepper|mushroom|bean|cucumber|butternut|veg|fruit/],
    ["Cupboard", /rice|pasta|penne|fusilli|spaghetti|noodle|oil|flour|sugar|honey|tin|oats|nut|almond|cashew|stock|coffee|tea|cereal|chips|passata|coconut|nappies|wipes|soap|toilet/]];
  for (const [a, re] of map) if (re.test(s)) return a;
  return "Other";
}
function nextDue(due, repeat) {
  let d = parse(due || ymd(today())); const t = today(); let guard = 0;
  do {
    if (repeat === "daily") d = addDays(d, 1);
    else if (repeat === "weekly") d = addDays(d, 7);
    else if (repeat === "monthly") d = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate());
    else d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
  } while (d <= t && guard++ < 800);
  return ymd(d);
}
function fail(error) {
  console.warn(error);
  const msg = (error && error.message) || "";
  if (/JWT|session|auth/i.test(msg)) toast("You've been signed out. Please sign in again.");
  else toast("That didn't save. Check your connection and try again.");
}

/* ---------- meal plan ---------- */
function planStart() { return mondayOf(parse((S.plan && S.plan.start_date) || "2026-11-02")); }
function weekNo(monday) { const diff = Math.round((monday - planStart()) / 864e5 / 7); return ((diff % 4) + 4) % 4 + 1; }
function takeoutFor(monday) { const t = (S.plan && S.plan.takeout) || {}; return t[ymd(monday)] || (S.plan && S.plan.default_takeout) || "wed"; }
function dayPlan(date) {
  const k = DKEY[date.getDay()];
  if (k === "sat" || k === "sun") return { type: "weekend" };
  const mon = mondayOf(date), w = weekNo(mon), to = takeoutFor(mon);
  if (k === to) return { type: "takeout", week: w };
  const cook = ["mon", "tue", "wed", "thu", "fri"].filter(d => d !== to);
  return { type: "cook", week: w, meal: S.meals.find(m => m.week === w && m.slot === cook.indexOf(k) + 1) };
}
const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;
const shopMonday = () => isWeekend(today()) ? addDays(mondayOf(today()), 7) : mondayOf(today());

/* ---------- calendar maths ---------- */
function occurrences(e, from, to) {
  const out = [], base = parse(e.date);
  if (!e.repeat) { if (base >= from && base <= to) out.push(base); return out; }
  if (e.repeat === "yearly") {
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) { const d = new Date(y, base.getMonth(), base.getDate()); if (d >= from && d <= to) out.push(d); }
    return out;
  }
  if (e.repeat === "monthly") {
    for (let i = 0; i < 6; i++) { const d = new Date(from.getFullYear(), from.getMonth() + i, base.getDate()); if (d >= from && d <= to && d >= base) out.push(d); }
    return out;
  }
  if (e.repeat === "weekly") {
    let d = base; if (d < from) d = addDays(d, Math.ceil((from - d) / 864e5 / 7) * 7);
    while (d <= to) { out.push(d); d = addDays(d, 7); }
  }
  return out;
}
function agenda(from, to) {
  const list = [];
  for (const e of S.events) for (const d of occurrences(e, from, to)) list.push({ d, kind: "event", o: e, sort: e.time ? hm(e.time) : "00:00" });
  for (const t of S.tasks) { if (t.done || !t.due) continue; const d = parse(t.due); if (d >= from && d <= to) list.push({ d, kind: "task", o: t, sort: "99" }); }
  list.sort((a, b) => (a.d - b.d) || a.sort.localeCompare(b.sort));
  return list;
}

/* ---------- data ---------- */
async function load(key) {
  const { data, error } = await sb.from(TABLES[key]).select("*");
  if (error) { console.warn(error); return; }
  if (key === "plan") S.plan = data[0] || null; else S[key] = data || [];
  if (key === "lists") { S.lists.sort((a, b) => a.sort - b.sort); if (!S.listId || !S.lists.find(l => l.id === S.listId)) S.listId = (S.lists[0] || {}).id || null; }
}
async function loadAll() {
  await Promise.all(Object.keys(TABLES).map(load));
  S.loaded = true; render();
}
const pending = {};
function refresh(key) { clearTimeout(pending[key]); pending[key] = setTimeout(async () => { await load(key); render(); }, 250); }
let channel = null;
function subscribe() {
  if (channel) return;
  channel = sb.channel("household");
  for (const [k, t] of Object.entries(TABLES)) { if (k !== "members") channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => refresh(k)); }
  channel.subscribe();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.me) loadAll(); });

async function write(key, op) {
  const { error } = await op;
  if (error) { fail(error); return false; }
  await load(key); render(); return true;
}

/* ---------- boot / auth ---------- */
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!sb) { render(); return; }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((_e, s) => { S.session = s; if (!s) { S.me = null; S.loaded = false; render(); } });
  if (S.session) await afterLogin(); else render();
}
async function afterLogin() {
  const { data, error } = await sb.rpc("claim_invite");
  if (error) { S.notInvited = /not_invited/.test(error.message || ""); if (!S.notInvited) S.authMsg = "Couldn't connect. Check your internet and try again."; render(); return; }
  S.me = Array.isArray(data) ? data[0] : data; S.notInvited = false;
  await loadAll(); subscribe();
}
async function signIn(email, password, create) {
  S.authMsg = ""; render();
  const res = create ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
  if (res.error) {
    const m = res.error.message || "";
    S.authMsg = /Invalid login/i.test(m) ? "That email and password don't match. First time here? Tap \"First time? Create your password\"." :
      /already registered/i.test(m) ? "You already have a password. Use Sign in instead." :
      /Password should be/i.test(m) ? "Use a password of at least 6 characters." : m;
    render(); return;
  }
  if (!res.data.session && create) {
    const again = await sb.auth.signInWithPassword({ email, password });
    if (!again.error && again.data.session) { S.session = again.data.session; await afterLogin(); return; }
  }
  if (!res.data.session) { S.authMsg = "Check your email and tap the confirm link, then come back and sign in here."; S.authMode = "in"; render(); return; }
  S.session = res.data.session; await afterLogin();
}

/* ---------- views ---------- */
const ICON = {
  today: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  cal: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  lists: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
  meals: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1-3 4-3 7h3"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};

function taskRow(t, opts) {
  const due = t.due ? parse(t.due) : null, late = due && due < today();
  const meta = [whoChip(t.who)];
  if (opts && opts.showDate && due) meta.push(late ? `<span class="late">Since ${esc(dayLabel(due))}</span>` : esc(dayLabel(due)));
  else if (late) meta.push(`<span class="late">Since ${esc(dayLabel(due))}</span>`);
  if (t.repeat) meta.push("repeats " + esc(t.repeat));
  return `<div class="row${t.done ? " done" : ""}"><button class="tick${t.done ? " on" : ""}" data-act="tick-task" data-id="${esc(t.id)}" aria-label="Mark done: ${esc(t.title)}">${t.done ? ICON.check : ""}</button><button class="main" data-act="edit-task" data-id="${esc(t.id)}"><span class="t">${esc(t.title)}</span><span class="m">${meta.join(" ")}</span></button></div>`;
}
function eventRow(e, d, showDate) {
  return `<div class="row"><span class="time">${e.time ? esc(hm(e.time)) : "All day"}</span><button class="main" data-act="edit-event" data-id="${esc(e.id)}"><span class="t">${esc(e.title)}</span><span class="m">${whoChip(e.who)}${showDate ? esc(dayLabel(d)) : ""}${e.repeat ? (showDate ? " · " : "") + "every " + esc(e.repeat.replace("ly", "")).replace("dai", "day") : ""}</span></button></div>`;
}
function installBanner() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
  let dismissed = false; try { dismissed = localStorage.getItem("bm.installDone") === "1"; } catch (_) {}
  if (!ios || standalone || dismissed) return "";
  const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|GSA/.test(navigator.userAgent);
  return `<div class="banner"><p>${safari ? "<b>Put BrainMaid on your home screen:</b> tap the Share button below, then <b>Add to Home Screen</b>." : "<b>Open this page in Safari</b> to put BrainMaid on your home screen."}</p><button class="link" data-act="install-ok">OK</button></div>`;
}

function vToday() {
  const t = today(), h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  let html = `<div class="top"><div><h1>${greet}, ${esc(nameOf(mine()))}</h1><p class="sub">${esc(t.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long" }))}</p></div><button class="gear" data-act="settings" aria-label="Settings">${ICON.gear}</button></div>`;
  html += installBanner();

  // tonight
  const p = dayPlan(t);
  if (p.type === "cook" && p.meal) {
    html += `<section class="card now"><p class="k">Tonight</p><p class="big">${esc(p.meal.title)}</p><p class="sub">${esc(p.meal.mins)} min · ${esc(p.meal.kit)} · Week ${p.week}</p><div class="tools"><button class="btn small" data-act="meal" data-id="${esc(p.meal.id)}" data-date="${ymd(t)}">Recipe and checklist</button></div></section>`;
  } else if (p.type === "takeout") {
    html += `<section class="card now"><p class="k">Tonight</p><p class="big">Takeout night</p><p class="sub">No cooking. Mila's backup: freezer meatballs, cheese and fruit.</p></section>`;
  }
  const tp = dayPlan(addDays(t, 1));
  if (tp.type === "cook" && tp.meal) {
    const meat = (tp.meal.ing || []).filter(i => i.a === "Meat");
    if (meat.length) html += `<div class="card"><p style="margin:0">❄️ Tonight, move <b>${meat.map(i => esc(((i.q ? i.q + " " : "") + i.n).toLowerCase())).join(", ")}</b> from the freezer to the fridge for tomorrow's ${esc(tp.meal.title.toLowerCase())}.</p></div>`;
  }

  // today list
  const todays = agenda(t, t).filter(x => x.kind === "event");
  const tasks = S.tasks.filter(x => !x.done && x.due && parse(x.due) <= t).sort((a, b) => a.due.localeCompare(b.due));
  html += `<h2>Today</h2>`;
  if (!todays.length && !tasks.length) html += `<div class="rows"><p class="empty">Nothing else needs you today.</p></div>`;
  else html += `<div class="rows">${todays.map(x => eventRow(x.o, x.d, false)).join("")}${tasks.map(x => taskRow(x)).join("")}</div>`;

  // coming up
  const soon = agenda(addDays(t, 1), addDays(t, 7)).slice(0, 8);
  if (soon.length) html += `<h2>Next 7 days</h2><div class="rows">${soon.map(x => x.kind === "event" ? eventRow(x.o, x.d, true) : taskRow(x.o, { showDate: true })).join("")}</div>`;

  // buy list
  const shop = S.lists.find(l => l.kind === "shop");
  if (shop) {
    const n = S.items.filter(i => i.list_id === shop.id && !i.done).length;
    html += `<button class="card" style="border:0;text-align:left;flex-direction:row;align-items:center;justify-content:space-between" data-act="go-list" data-id="${esc(shop.id)}"><span><b>${esc(shop.name)}</b><br><span class="sub">${n ? n + " thing" + (n === 1 ? "" : "s") + " to get" : "Nothing to get"}</span></span><span class="link">Open</span></button>`;
  }
  return html;
}

function vCalendar() {
  const t = today();
  let html = `<div class="top"><div><h1>Calendar</h1><p class="sub">Everything coming up, for both of you</p></div><button class="btn small" data-act="add" data-type="event">+ Event</button></div>`;
  const items = agenda(t, addDays(t, S.calDays));
  if (!items.length) html += `<div class="rows"><p class="empty">Nothing planned yet. Tap + Event to add one.</p></div>`;
  let cur = "";
  let block = [];
  const flush = () => { if (block.length) { html += `<h2>${esc(cur)}</h2><div class="rows">${block.join("")}</div>`; block = []; } };
  for (const x of items) {
    const label = dayLabel(x.d) + (Math.abs(Math.round((x.d - t) / 864e5)) < 7 && !sameDay(x.d, t) ? " · " + x.d.toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : "");
    if (label !== cur) { flush(); cur = label; }
    block.push(x.kind === "event" ? eventRow(x.o, x.d, false) : taskRow(x.o));
  }
  flush();
  html += `<div class="tools"><button class="btn small ghost" data-act="more-cal">Show further ahead</button></div>`;
  const undated = S.tasks.filter(x => !x.done && !x.due);
  if (undated.length) html += `<h2>To-dos with no date</h2><div class="rows">${undated.map(x => taskRow(x)).join("")}</div>`;
  return html;
}

function vLists() {
  const list = S.lists.find(l => l.id === S.listId);
  let html = `<div class="top"><div><h1>Lists</h1><p class="sub">Shared, live on both phones</p></div></div>`;
  html += `<div class="chips">${S.lists.map(l => `<button class="chip${l.id === S.listId ? " on" : ""}" data-act="pick-list" data-id="${esc(l.id)}">${esc(l.name)}</button>`).join("")}<button class="chip" data-act="new-list">+ New list</button></div>`;
  if (!list) return html + `<p class="empty">No lists yet.</p>`;
  const shop = list.kind === "shop";
  let rows = S.items.filter(i => i.list_id === list.id);
  if (shop) {
    const cw = rows.filter(i => i.tier === "w" && !i.done).length, cm = rows.filter(i => i.tier === "m" && !i.done).length;
    html += `<div class="seg"><button class="${S.tier === "w" ? "on" : ""}" data-act="tier" data-v="w">This week · ${cw}</button><button class="${S.tier === "m" ? "on" : ""}" data-act="tier" data-v="m">Monthly bulk · ${cm}</button></div>`;
    rows = rows.filter(i => i.tier === S.tier);
  }
  html += `<form class="add" data-form="item"><input type="text" id="item-name" placeholder="Add to ${esc(list.name)}" autocomplete="off" enterkeyhint="done"><button class="btn">Add</button></form>`;
  const open = rows.filter(i => !i.done).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const done = rows.filter(i => i.done);
  if (!open.length) html += `<div class="rows"><p class="empty">${shop ? (S.tier === "w" ? "Nothing to buy. Add what's running low, or fill it from this week's meals." : "Nothing on the monthly list. Fill it from all 16 meals once a month.") : "Nothing here yet."}</p></div>`;
  else if (shop) {
    for (const a of AISLES) { const g = open.filter(i => (i.aisle || "Other") === a); if (g.length) html += `<h2>${esc(a)}</h2><div class="rows">${g.map(itemRow).join("")}</div>`; }
  } else html += `<div class="rows">${open.map(itemRow).join("")}</div>`;
  if (shop) html += `<div class="tools">${S.tier === "w" ? `<button class="btn small ghost" data-act="build" data-tier="w">+ Week ${weekNo(shopMonday())} dinners</button>` : `<button class="btn small ghost" data-act="build" data-tier="m">+ Monthly bulk</button>`}${open.length ? `<button class="btn small ghost" data-act="copy">Copy list</button>` : ""}</div>`;
  if (done.length) html += `<div class="top" style="align-items:center"><h2>${shop ? "In the trolley" : "Done"} · ${done.length}</h2><button class="link" data-act="clear-done">Clear</button></div><div class="rows">${done.map(itemRow).join("")}</div>`;
  if (!shop) html += `<div class="tools"><button class="link" data-act="del-list" style="color:var(--bad)">Delete this list</button></div>`;
  return html;
}
function itemRow(i) {
  return `<div class="row${i.done ? " done" : ""}"><button class="tick${i.done ? " on" : ""}" data-act="tick-item" data-id="${esc(i.id)}" aria-label="Tick ${esc(i.name)}">${i.done ? ICON.check : ""}</button><button class="main" data-act="edit-item" data-id="${esc(i.id)}"><span class="t">${esc(i.name)}</span>${i.qty || i.who ? `<span class="m">${whoChip(i.who)}${esc(i.qty || "")}</span>` : ""}</button></div>`;
}

function vMeals() {
  const t = today(), mon = isWeekend(t) ? addDays(mondayOf(t), 7) : mondayOf(t);
  const w = S.mealWeek || weekNo(mon);
  let html = `<div class="top"><div><h1>Meals</h1><p class="sub">4-week dinner rotation · weekends free</p></div></div>`;
  const to = takeoutFor(mon);
  html += `<div class="card"><b>${isWeekend(t) ? "Next week's" : "This week's"} takeout night</b><div class="chips">${["mon", "tue", "wed", "thu", "fri"].map(d => `<button class="chip${d === to ? " on" : ""}" data-act="takeout" data-mon="${ymd(mon)}" data-day="${d}">${DSHORT[d]}</button>`).join("")}</div><span class="sub">The other four nights cook in order.</span></div>`;
  html += `<div class="seg">${[1, 2, 3, 4].map(n => `<button class="${n === w ? "on" : ""}" data-act="mweek" data-v="${n}">Week ${n}</button>`).join("")}</div>`;
  const list = S.meals.filter(m => m.week === w).sort((a, b) => a.slot - b.slot);
  if (!list.length) html += `<p class="empty">No meals for this week.</p>`;
  html += `<div class="rows">${list.map(m => `<div class="row"><span class="time">Night ${m.slot}</span><button class="main" data-act="meal" data-id="${esc(m.id)}"><span class="t">${esc(m.title)}</span><span class="m">${esc(m.mins)} min · ${esc(m.protein || "")}${score(m.id)}</span></button></div>`).join("")}</div>`;
  html += `<h2>Every day</h2><div class="card"><b>Breakfast in under 2 minutes</b><ul class="steps"><li>2 boiled eggs with biltong or cheese</li><li>Greek yoghurt, berries and a spoon of oats or nuts</li><li>A protein drinking yoghurt and a banana</li><li>Mila: full-cream yoghurt with soft fruit, or oats with milk</li></ul><b>House rules</b><ul class="steps"><li>No fish or seafood</li><li>Plate Mila's portion before any chilli goes in</li><li>Cut Mila's round foods into quarters; cheese in sticks</li><li>Every dinner makes tomorrow's three lunches; Mila's box gets an ice pack</li></ul></div>`;
  return html;
}
function score(id) {
  let up = 0, dn = 0;
  for (const r of S.ratings) if (r.meal_id === id) for (const f of ["r", "t", "m"]) { if (r[f] === 1) up++; if (r[f] === -1) dn++; }
  return up || dn ? ` · ▲${up} ▼${dn}` : "";
}

function vAuth() {
  const create = S.authMode === "up";
  return `<div class="wrap center"><h1>BrainMaid</h1><p class="sub">Ryan and Tamlyn's family hub</p>
  <form class="card" data-form="auth"><label class="l" for="a-email">Email</label><input type="email" id="a-email" autocomplete="username" required>
  <label class="l" for="a-pass">${create ? "Choose a password (6+ characters)" : "Password"}</label><input type="password" id="a-pass" autocomplete="${create ? "new-password" : "current-password"}" required minlength="6">
  ${S.authMsg ? `<p class="sub" style="color:var(--bad)">${esc(S.authMsg)}</p>` : ""}
  <button class="btn full">${create ? "Create my password" : "Sign in"}</button>
  <button type="button" class="link" data-act="auth-mode">${create ? "Already have a password? Sign in" : "First time? Create your password"}</button></form></div>`;
}
function vNotInvited() {
  return `<div class="wrap center"><h1>Almost there</h1><p>This email isn't on the Eyden family list yet. Sign in with the email Ryan set up for you, or ask Ryan to add this one.</p><button class="btn" data-act="signout">Sign out</button></div>`;
}

/* ---------- sheets ---------- */
function openSheet(html) { $("#sheet").innerHTML = `<div class="grab"></div>${html}`; $("#sheet-wrap").hidden = false; document.body.style.overflow = "hidden"; }
function closeSheet() { $("#sheet-wrap").hidden = true; $("#sheet").innerHTML = ""; S.form = null; document.body.style.overflow = ""; }

function formSheet() {
  const f = S.form, isEdit = !!f.id, type = f.type;
  const t = today(), sat = addDays(t, (6 - t.getDay() + 7) % 7 || 7);
  const whenOpts = [["Today", ymd(t)], ["Tomorrow", ymd(addDays(t, 1))], ["Saturday", ymd(sat)]];
  const title = isEdit ? (type === "event" ? "Edit event" : type === "item" ? "Edit item" : "Edit to-do") : "Add";
  let h = `<div class="hd"><h1 style="font-size:1.4rem">${title}</h1><button class="link" data-act="close-sheet">Cancel</button></div>`;
  if (!isEdit) h += `<div class="seg"><button class="${type === "task" ? "on" : ""}" data-act="f-type" data-v="task">To-do</button><button class="${type === "event" ? "on" : ""}" data-act="f-type" data-v="event">Event</button><button class="${type === "item" ? "on" : ""}" data-act="f-type" data-v="item">To buy</button></div>`;
  h += `<form data-form="sheet" style="display:flex;flex-direction:column;gap:10px">`;
  h += `<input type="text" id="f-title" value="${esc(f.title)}" placeholder="${type === "event" ? "e.g. Mila's crèche concert" : type === "item" ? "e.g. nappies, milk, peri-peri" : "e.g. pay the electricity, book the vet"}" autocomplete="off" required>`;
  if (type === "item") {
    h += `<label class="l" for="f-list">Which list</label><select id="f-list">${S.lists.map(l => `<option value="${esc(l.id)}"${l.id === f.listId ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select>`;
    h += `<label class="l" for="f-qty">How much (optional)</label><input type="text" id="f-qty" value="${esc(f.qty || "")}" placeholder="e.g. 2 tins">`;
  } else {
    h += `<label class="l">When</label><div class="chips">${whenOpts.map(([l, v]) => `<button type="button" class="chip${f.date === v ? " on" : ""}" data-act="f-when" data-v="${v}">${l}</button>`).join("")}${type === "task" ? `<button type="button" class="chip${!f.date ? " on" : ""}" data-act="f-when" data-v="">No date</button>` : ""}</div>`;
    h += `<input type="date" id="f-date" value="${esc(f.date || "")}" aria-label="Pick a date">`;
    if (type === "event") h += `<label class="l" for="f-time">Time (optional)</label><input type="time" id="f-time" value="${esc(hm(f.time))}">`;
    h += `<label class="l" for="f-repeat">Repeats</label><select id="f-repeat"><option value="">No</option>${(type === "task" ? ["daily", "weekly", "monthly", "yearly"] : ["weekly", "monthly", "yearly"]).map(r => `<option value="${r}"${f.repeat === r ? " selected" : ""}>${r === "daily" ? "Every day" : "Every " + r.replace("ly", "")}</option>`).join("")}</select>`;
  }
  h += `<label class="l">For</label><div class="chips">${[[mine(), "Me"], [partner(), nameOf(partner())], ["both", "Both of us"]].map(([v, l]) => `<button type="button" class="chip${f.who === v ? " on" : ""}" data-act="f-who" data-v="${v}">${esc(l)}</button>`).join("")}</div>`;
  if (type !== "item") h += `<label class="l" for="f-notes">Notes (optional)</label><textarea id="f-notes" rows="2">${esc(f.notes || "")}</textarea>`;
  h += `<button class="btn full">${isEdit ? "Save" : "Add"}</button>`;
  if (isEdit) h += `<button type="button" class="btn danger full" data-act="f-delete">Delete</button>`;
  h += `</form>`;
  return h;
}
function startForm(type, existing) {
  const t = today();
  S.form = existing ? Object.assign({ type }, existing, { listId: existing.list_id, title: existing.title || existing.name, date: existing.date || existing.due || "" }) :
    { type, title: "", date: type === "task" ? ymd(t) : type === "event" ? ymd(t) : "", time: "", who: "both", repeat: "", notes: "", listId: (S.lists.find(l => l.kind === "shop") || S.lists[0] || {}).id, qty: "" };
  openSheet(formSheet());
  setTimeout(() => { const el = $("#f-title"); if (el && !existing) el.focus(); }, 50);
}
function syncForm() {
  const f = S.form; if (!f) return;
  const v = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  if (v("f-title") !== undefined) f.title = v("f-title");
  if (v("f-date") !== undefined) f.date = v("f-date");
  if (v("f-time") !== undefined) f.time = v("f-time");
  if (v("f-repeat") !== undefined) f.repeat = v("f-repeat");
  if (v("f-notes") !== undefined) f.notes = v("f-notes");
  if (v("f-list") !== undefined) f.listId = v("f-list");
  if (v("f-qty") !== undefined) f.qty = v("f-qty");
}
async function saveForm() {
  syncForm(); const f = S.form; const title = (f.title || "").trim();
  if (!title) { toast("Type what it is first."); return; }
  let ok = false;
  if (f.type === "task") {
    const row = { title, due: f.date || null, who: f.who, repeat: f.repeat || null, notes: f.notes || null };
    ok = await write("tasks", f.id ? sb.from("tasks").update(row).eq("id", f.id) : sb.from("tasks").insert(row));
  } else if (f.type === "event") {
    if (!f.date) { toast("Pick a date for the event."); return; }
    const row = { title, date: f.date, time: f.time || null, who: f.who, repeat: f.repeat || null, notes: f.notes || null };
    ok = await write("events", f.id ? sb.from("events").update(row).eq("id", f.id) : sb.from("events").insert(row));
  } else {
    const list = S.lists.find(l => l.id === f.listId);
    const row = { name: title, qty: f.qty || null, list_id: f.listId, who: f.who === "both" ? null : f.who, aisle: guessAisle(title) };
    if (!f.id) row.tier = "w";
    ok = await write("items", f.id ? sb.from("list_items").update(row).eq("id", f.id) : sb.from("list_items").insert(row));
    if (ok && !f.id && list) toast("Added to " + list.name);
  }
  if (ok) { if (!f.id && f.type !== "item") toast(f.type === "event" ? "Added to the calendar" : "Added"); closeSheet(); }
}

function mealSheet(id, date) {
  const m = S.meals.find(x => x.id === id); if (!m) return;
  const d = date || ymd(today());
  const r = S.ratings.find(x => x.meal_id === id && x.date === d) || {};
  const openKeys = new Set(S.items.filter(i => !i.done).map(i => keyOf(i.name)));
  const rate = (f, label) => `<div class="rate"><b>${label}</b><div class="b">${[[1, "👍"], [0, "😐"], [-1, "👎"]].map(([v, e]) => `<button class="rb${r[f] === v ? " on" : ""}" data-act="rate" data-meal="${esc(id)}" data-date="${d}" data-f="${f}" data-v="${v}" aria-label="${label} ${v === 1 ? "liked it" : v === 0 ? "okay" : "didn't like it"}">${e}</button>`).join("")}</div></div>`;
  let h = `<div class="hd"><span class="sub">${esc(m.mins)} min · ${esc(m.kit)}</span><button class="link" data-act="close-sheet">Close</button></div><h1 style="font-size:1.5rem">${esc(m.title)}</h1>`;
  h += `<div class="card"><b>Check you have everything</b>${(m.ing || []).map((i, ix) => { const on = openKeys.has(keyOf(i.n)); return `<div class="row" style="padding:7px 0"><span class="main" style="cursor:default"><span class="t">${esc(i.n)}</span><span class="m">${esc(i.q || "")}</span></span>${on ? `<span class="sub">On the list</span>` : `<button class="btn small ghost" data-act="need" data-meal="${esc(id)}" data-ix="${ix}">Need it</button>`}</div>`; }).join("")}</div>`;
  h += `<div class="card"><b>Method</b><ol class="steps">${(m.steps || []).map(s => `<li>${esc(s)}</li>`).join("")}</ol><p class="split"><span class="tag t-mila">Mila</span><span>${esc(m.mila)}</span></p><p class="split"><span class="tag t-spice">Adults</span><span>${esc(m.spice)}</span></p></div>`;
  h += `<div class="card"><b>Plates</b><dl class="kv"><div><dt>Ryan</dt><dd>${esc((m.plates || {}).ryan)}</dd></div><div><dt>Tamlyn</dt><dd>${esc((m.plates || {}).tamlyn)}</dd></div></dl>`;
  if (m.lunch && m.lunch.ryan) h += `<b>Tomorrow's lunch boxes</b><dl class="kv"><div><dt>Ryan</dt><dd>${esc(m.lunch.ryan)}</dd></div><div><dt>Tamlyn</dt><dd>${esc(m.lunch.tamlyn)}</dd></div><div><dt>Mila</dt><dd>${esc(m.lunch.mila)}</dd></div></dl>`;
  h += `</div><div class="card"><b>How was it?</b>${rate("r", "Ryan")}${rate("t", "Tamlyn")}${rate("m", "Mila")}<label class="l" for="rate-note">What would make it better?</label><textarea id="rate-note" data-meal="${esc(id)}" data-date="${d}">${esc(r.note || "")}</textarea><button class="btn small ghost" data-act="save-note">Save note</button></div>`;
  S.sheet = { kind: "meal", id, date: d };
  openSheet(h);
}
function settingsSheet() {
  const email = (S.session && S.session.user && S.session.user.email) || "";
  openSheet(`<div class="hd"><h1 style="font-size:1.4rem">Settings</h1><button class="link" data-act="close-sheet">Close</button></div>
  <div class="card"><b>Signed in as ${esc(nameOf(mine()))}</b><span class="sub">${esc(email)}</span></div>
  <div class="card"><b>Put BrainMaid on your home screen</b><ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open BrainMaid from the new icon and sign in once.</li></ol></div>
  <div class="card"><b>Phone notifications</b><span class="sub">Coming in the next update: morning, 4 PM dinner check, shop day and event reminders.</span></div>
  <button class="btn danger full" data-act="signout">Sign out</button>`);
}

/* ---------- render ---------- */
const VIEWS = { today: vToday, calendar: vCalendar, lists: vLists, meals: vMeals };
function render() {
  const app = $("#app");
  if (!sb) { app.innerHTML = `<div class="wrap center"><h1>BrainMaid</h1><p>This app isn't connected to its database yet. Add the Supabase details to config.js.</p></div>`; return; }
  if (!S.session) { app.innerHTML = vAuth(); return; }
  if (S.notInvited) { app.innerHTML = vNotInvited(); return; }
  if (!S.me || !S.loaded) { app.innerHTML = `<div class="wrap center"><p class="empty">${esc(S.authMsg || "Loading your family hub…")}</p></div>`; return; }
  const a = document.activeElement, keep = a && a.id && /INPUT|TEXTAREA/.test(a.tagName) && app.contains(a) ? { id: a.id, v: a.value } : null;
  const n = (() => { const shop = S.lists.find(l => l.kind === "shop"); return shop ? S.items.filter(i => i.list_id === shop.id && !i.done && i.tier === "w").length : 0; })();
  const tabs = [["today", "Today", ICON.today], ["calendar", "Calendar", ICON.cal], ["lists", "Lists", ICON.lists], ["meals", "Meals", ICON.meals]];
  app.innerHTML = `<main class="wrap">${VIEWS[S.tab]()}</main>
    <button class="fab" data-act="add" data-type="task" aria-label="Add something">+</button>
    <nav class="tabs" aria-label="Sections"><div class="in">${tabs.map(([k, l, i]) => `<button class="${S.tab === k ? "on" : ""}" data-act="tab" data-v="${k}" aria-current="${S.tab === k ? "page" : "false"}">${i}${k === "lists" && n ? `<span class="badge">${n}</span>` : ""}<span>${l}</span></button>`).join("")}</div></nav>`;
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.v; el.focus({ preventScroll: true }); } }
  if (S.sheet && S.sheet.kind === "meal" && !$("#sheet-wrap").hidden) { /* keep meal sheet fresh */ const st = $("#sheet").scrollTop; mealSheet(S.sheet.id, S.sheet.date); $("#sheet").scrollTop = st; }
}

/* ---------- actions ---------- */
async function buildShop(tier) {
  const shop = S.lists.find(l => l.kind === "shop"); if (!shop) return;
  let src = [];
  if (tier === "w") { const w = weekNo(shopMonday()); S.meals.filter(m => m.week === w).forEach(m => (m.ing || []).forEach(i => { if (i.t === "w") src.push(i); })); ((S.plan && S.plan.staples && S.plan.staples.w) || []).forEach(i => src.push(i)); }
  else { S.meals.forEach(m => (m.ing || []).forEach(i => { if (i.t === "m") src.push(i); })); ((S.plan && S.plan.staples && S.plan.staples.m) || []).forEach(i => src.push(i)); }
  const agg = new Map();
  for (const i of src) { const k = keyOf(i.n); if (!agg.has(k)) agg.set(k, { n: i.n, a: i.a || guessAisle(i.n), qs: [] }); agg.get(k).qs.push(i.q || ""); }
  const have = new Set(S.items.filter(i => i.list_id === shop.id && !i.done && i.tier === tier).map(i => keyOf(i.name)));
  const rows = [];
  for (const [k, v] of agg) {
    if (have.has(k)) continue;
    const f = v.qs.filter(Boolean); const q = !f.length ? "" : f.length === 1 ? f[0] : f.every(x => x === f[0]) ? f[0] + " × " + f.length : f.join(" + ");
    rows.push({ list_id: shop.id, name: v.n, qty: q || null, aisle: v.a, tier });
  }
  if (!rows.length) { toast("Everything's already on the list"); return; }
  if (await write("items", sb.from("list_items").insert(rows))) toast(`Added ${rows.length} items`);
}

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  switch (act) {
    case "tab": S.tab = b.dataset.v; try { localStorage.setItem("bm.tab", S.tab); } catch (_) {} render(); window.scrollTo(0, 0); return;
    case "auth-mode": S.authMode = S.authMode === "up" ? "in" : "up"; S.authMsg = ""; render(); return;
    case "signout": closeSheet(); await sb.auth.signOut(); S.session = null; S.me = null; S.notInvited = false; render(); return;
    case "install-ok": try { localStorage.setItem("bm.installDone", "1"); } catch (_) {} render(); return;
    case "settings": settingsSheet(); return;
    case "close-sheet": closeSheet(); S.sheet = null; return;
    case "add": startForm(b.dataset.type || "task"); return;
    case "edit-task": { const t = S.tasks.find(x => x.id === id); if (t) startForm("task", t); return; }
    case "edit-event": { const ev = S.events.find(x => x.id === id); if (ev) startForm("event", ev); return; }
    case "edit-item": { const it = S.items.find(x => x.id === id); if (it) startForm("item", Object.assign({}, it, { who: it.who || "both" })); return; }
    case "f-type": syncForm(); S.form.type = b.dataset.v; if (S.form.type === "event" && !S.form.date) S.form.date = ymd(today()); openSheet(formSheet()); return;
    case "f-when": syncForm(); S.form.date = b.dataset.v; openSheet(formSheet()); return;
    case "f-who": syncForm(); S.form.who = b.dataset.v; openSheet(formSheet()); return;
    case "f-delete": {
      const f = S.form, table = f.type === "event" ? "events" : f.type === "item" ? "list_items" : "tasks", key = f.type === "event" ? "events" : f.type === "item" ? "items" : "tasks";
      if (await write(key, sb.from(table).delete().eq("id", f.id))) { toast("Deleted"); closeSheet(); }
      return;
    }
    case "tick-task": {
      const t = S.tasks.find(x => x.id === id); if (!t) return;
      if (t.repeat && !t.done) { const nd = nextDue(t.due, t.repeat); if (await write("tasks", sb.from("tasks").update({ due: nd }).eq("id", id))) toast("Done. Next one: " + dayLabel(parse(nd))); }
      else if (await write("tasks", sb.from("tasks").update({ done: !t.done, done_at: t.done ? null : new Date().toISOString() }).eq("id", id)) && !t.done) toast("Done. Nice one.");
      return;
    }
    case "tick-item": { const it = S.items.find(x => x.id === id); if (it) await write("items", sb.from("list_items").update({ done: !it.done }).eq("id", id)); return; }
    case "go-list": S.tab = "lists"; S.listId = id; S.tier = "w"; render(); window.scrollTo(0, 0); return;
    case "pick-list": S.listId = id; render(); return;
    case "tier": S.tier = b.dataset.v; render(); return;
    case "new-list": {
      openSheet(`<div class="hd"><h1 style="font-size:1.4rem">New list</h1><button class="link" data-act="close-sheet">Cancel</button></div><form data-form="newlist" style="display:flex;flex-direction:column;gap:10px"><input type="text" id="nl-name" placeholder="e.g. Christmas, Holiday packing" required autocomplete="off"><button class="btn full">Create list</button></form>`);
      setTimeout(() => { const el = $("#nl-name"); if (el) el.focus(); }, 50); return;
    }
    case "del-list": {
      const l = S.lists.find(x => x.id === S.listId); if (!l) return;
      openSheet(`<div class="hd"><h1 style="font-size:1.4rem">Delete "${esc(l.name)}"?</h1><button class="link" data-act="close-sheet">Cancel</button></div><p>This removes the list and everything on it, for both of you.</p><button class="btn danger full" data-act="del-list-yes">Yes, delete it</button>`); return;
    }
    case "del-list-yes": { const lid = S.listId; if (await write("lists", sb.from("lists").delete().eq("id", lid))) { await load("items"); closeSheet(); render(); toast("List deleted"); } return; }
    case "clear-done": {
      const list = S.lists.find(l => l.id === S.listId); if (!list) return;
      let q = sb.from("list_items").delete().eq("list_id", list.id).eq("done", true);
      if (list.kind === "shop") q = q.eq("tier", S.tier);
      await write("items", q); return;
    }
    case "build": buildShop(b.dataset.tier); return;
    case "copy": {
      const list = S.lists.find(l => l.id === S.listId); if (!list) return;
      const rows = S.items.filter(i => i.list_id === list.id && !i.done && (list.kind !== "shop" || i.tier === S.tier));
      let txt = list.name + "\n";
      if (list.kind === "shop") { for (const a of AISLES) { const g = rows.filter(i => (i.aisle || "Other") === a); if (g.length) txt += "\n" + a + "\n" + g.map(i => "- " + i.name + (i.qty ? " (" + i.qty + ")" : "")).join("\n") + "\n"; } }
      else txt += rows.map(i => "- " + i.name).join("\n");
      try { await navigator.clipboard.writeText(txt.trim()); toast("List copied. Paste it into WhatsApp or Sixty60."); } catch (_) { toast("Couldn't copy on this phone."); }
      return;
    }
    case "more-cal": S.calDays += 90; render(); return;
    case "mweek": S.mealWeek = +b.dataset.v; render(); return;
    case "takeout": {
      const t = Object.assign({}, (S.plan && S.plan.takeout) || {}); t[b.dataset.mon] = b.dataset.day;
      await write("plan", sb.from("plan").update({ takeout: t }).eq("household_id", S.me.household_id)); return;
    }
    case "meal": mealSheet(id, b.dataset.date); return;
    case "need": {
      const m = S.meals.find(x => x.id === b.dataset.meal), i = m && (m.ing || [])[+b.dataset.ix], shop = S.lists.find(l => l.kind === "shop");
      if (!i || !shop) return;
      if (await write("items", sb.from("list_items").insert({ list_id: shop.id, name: i.n, qty: i.q || null, aisle: i.a || guessAisle(i.n), tier: "w" }))) toast("Added " + i.n + " to the buy list");
      return;
    }
    case "rate": {
      const f = b.dataset.f, v = +b.dataset.v, meal = b.dataset.meal, date = b.dataset.date;
      const cur = S.ratings.find(x => x.meal_id === meal && x.date === date) || {};
      const row = Object.assign({ household_id: S.me.household_id, meal_id: meal, date }, { r: cur.r ?? null, t: cur.t ?? null, m: cur.m ?? null, note: cur.note ?? null });
      row[f] = cur[f] === v ? null : v;
      await write("ratings", sb.from("meal_ratings").upsert(row, { onConflict: "household_id,meal_id,date" })); return;
    }
    case "save-note": {
      const el = $("#rate-note"); if (!el) return;
      const meal = el.dataset.meal, date = el.dataset.date, cur = S.ratings.find(x => x.meal_id === meal && x.date === date) || {};
      const row = { household_id: S.me.household_id, meal_id: meal, date, r: cur.r ?? null, t: cur.t ?? null, m: cur.m ?? null, note: el.value.trim() || null };
      if (await write("ratings", sb.from("meal_ratings").upsert(row, { onConflict: "household_id,meal_id,date" }))) toast("Note saved");
      return;
    }
  }
});
document.addEventListener("submit", async e => {
  const f = e.target.closest("form[data-form]"); if (!f) return; e.preventDefault();
  const kind = f.dataset.form;
  if (kind === "auth") { await signIn($("#a-email").value.trim(), $("#a-pass").value, S.authMode === "up"); return; }
  if (kind === "sheet") { await saveForm(); return; }
  if (kind === "item") {
    const input = $("#item-name"), name = input.value.trim(), list = S.lists.find(l => l.id === S.listId); if (!name || !list) return;
    const row = { list_id: list.id, name, aisle: guessAisle(name), tier: list.kind === "shop" ? S.tier : "w" };
    if (await write("items", sb.from("list_items").insert(row))) { const el = $("#item-name"); if (el) { el.value = ""; el.focus(); } }
    return;
  }
  if (kind === "newlist") {
    const name = $("#nl-name").value.trim(); if (!name) return;
    const sort = Math.max(0, ...S.lists.map(l => l.sort || 0)) + 1;
    const { data, error } = await sb.from("lists").insert({ name, sort }).select();
    if (error) { fail(error); return; }
    await load("lists"); S.listId = data && data[0] ? data[0].id : S.listId; closeSheet(); render(); toast("List created");
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet-wrap").hidden) closeSheet(); });

boot();
})();
