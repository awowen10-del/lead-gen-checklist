"use strict";

/* ---------------- Config ----------------
   The list is three sections, and the sections — not the tasks — own the
   scheduling. A task belongs to exactly one section and inherits its days,
   which is what lets Thursday swap the whole tail out for a single job
   without any per-task special-casing.

   Completion is keyed by stable ids, never by position — reordering is safe,
   but an id here must also exist in TASK_IDS in netlify/functions/api.mjs or
   the server will silently drop its ticks. Labels are free to change: they are
   display-only and no stored record references them. Ids are deliberately
   unchanged from earlier versions of the list even where the wording has moved
   on ("clients" is the Trainerize dip, "texts" is messaging new leads), so
   every day already stored still reads back against the right row.

   Per task:
     link    one chip or an array of them, rendered in the order given.
             Keep the text short; chips sit on the task row.
     notes   gives the task its own collapsible note. `field` is the day-record
             field the text is stored in and must also exist in NOTE_FIELDS in
             netlify/functions/api.mjs, or the note will save to nothing.
     na      whether the row can be marked N/A. false renders the button
             disabled with `naHint` as its tooltip rather than hiding it — the
             point is that the answer is visibly "no", not that the option is
             missing.
     short   the name used in the 14-day panel, where the full label is too long.

   Sections carry `days` as JS day numbers (0 = Sunday … 6 = Saturday). The
   weekday always comes from currentDate, never a fresh Date(), so the rows on
   screen match the date in the header even after a rollover with the tab open. */
const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;
const EVERY_DAY = [SUN, MON, TUE, WED, THU, FRI, SAT];
const EXCEPT_THU = EVERY_DAY.filter((d) => d !== THU);

/* Both non-N/A-able rows share one explanation, and it is the reason they are
   not N/A-able: the work is never genuinely unavailable. */
const NA_LOCKED_HINT = "There's always someone to message.";

const SECTIONS = [
  {
    id: "hour",
    title: "The hour",
    time: "9:00 – 10:00",
    days: EVERY_DAY,
    tasks: [
      {
        id: "texts",
        short: "New leads",
        label: "Message new leads",
        na: true,
        link: { url: "https://salesfollowup-bodysculpt.netlify.app", text: "Follow-ups ↗" },
      },
      {
        id: "leads",
        short: "Parked leads",
        label: "Follow up parked / quiet leads (2+ weeks)",
        na: false,
        naHint: NA_LOCKED_HINT,
      },
      {
        id: "dm",
        short: "DM outreach",
        label: "DM outreach",
        na: false,
        naHint: NA_LOCKED_HINT,
        link: [
          { url: "https://www.instagram.com", text: "Instagram ↗" },
          { url: "https://business.facebook.com/latest/inbox/all", text: "Meta Inbox ↗" },
        ],
      },
    ],
  },
  {
    /* The ordinary tail. Thursday gets the section below instead — the two are
       mutually exclusive by construction, since their `days` do not overlap. */
    id: "tail",
    title: "The tail",
    time: "10:00 – 10:15",
    days: EXCEPT_THU,
    tasks: [
      {
        id: "content",
        short: "Publish content",
        label: "Publish scheduled content",
        na: true,
        link: { url: "https://bodysculptcontent.netlify.app", text: "Content ↗" },
      },
      {
        id: "clients",
        short: "Trainerize dip",
        label: "Trainerize dip (10 min cap)",
        na: true,
        link: { url: "https://bodysculpt4.trainerize.com/app/overview", text: "Trainerize ↗" },
        notes: {
          field: "clientNotes",
          placeholder: "Wins, quotes, transformations — anything worth posting",
          title: "Check-in notes",
        },
      },
      {
        id: "onboarding",
        short: "Onboarding",
        label: "Onboarding tracker — welcome cards etc",
        na: true,
        link: { url: "https://bodysculpt-onboarding.netlify.app", text: "Onboarding ↗" },
      },
    ],
  },
  {
    /* Thursday's tail is one job, not three. The email IS the tail that day. */
    id: "tail-thu",
    title: "The tail",
    time: "10:00 – 10:15",
    days: [THU],
    tasks: [
      {
        id: "email",
        short: "Thursday email",
        label: "Write and schedule the email",
        na: true,
        link: { url: "https://bodysculptcontent.netlify.app", text: "Content ↗" },
      },
    ],
  },
  {
    id: "weekly",
    title: "Twice weekly",
    time: "Mon and Thu",
    days: [MON, THU],
    tasks: [
      {
        id: "ads",
        short: "Ad review",
        label: "Review ad performance",
        na: true,
        link: { url: "https://bodysculpt-ad-intelligence.netlify.app", text: "Ad Intel ↗" },
        notes: { field: "adsNotes", placeholder: "Ad notes…", title: "Ad notes" },
      },
    ],
  },
];

/* Flat views of the config. ALL_TASKS is the schema — every id and note field
   that can ever exist — as distinct from the tasks that apply to a given day. */
const ALL_TASKS = SECTIONS.flatMap((s) => s.tasks);
const NOTE_FIELDS = ALL_TASKS.filter((t) => t.notes).map((t) => t.notes.field);

const NOTES_DEBOUNCE_MS = 600;
const RECENT_DAYS = 14;
const NA_FLAG_THRESHOLD = 3; // N/A this often in the window and the panel says so
const ROLLOVER_POLL_MS = 30000;

const emptyState = () => ({
  checked: {},
  na: {},
  submitted: false,
  ...Object.fromEntries(NOTE_FIELDS.map((f) => [f, ""])),
});

/* ---------------- State ---------------- */
let state = emptyState();
let currentDate = todayStr();

/* Persistence bookkeeping.
   `loaded` is the gate: it is true only after a GET has actually succeeded.
   Nothing may be written to the server while it is false, because until the
   server's version of today has arrived we have nothing but defaults, and
   writing defaults is how a day's notes and ticks got erased. */
let loaded = false;
/* `pending` holds only the fields the user has actually changed since the last
   successful write — never a whole day record. It is the payload source for
   every save, which is what makes a default/empty write structurally
   impossible rather than merely guarded against. */
let pending = { checked: {}, na: {} };
let inFlight = false;
let saveTimer = null;
let savedFlashTimer = null;

let lastSavedNotes = null; // snapshot of last notes saved to the log
let logLoaded = false;
let recentLoaded = false;
let notesOpen = {}; // task id → whether its collapsible note panel is expanded

/* ---------------- Date helpers ----------------
   todayStr() is the ONE place a date key is ever generated, and it is purely
   local-time (getFullYear/getMonth/getDate — never toISOString, which would
   shift the key across UTC midnight). currentDate is set from it and from
   nothing else. */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* A YYYY-MM-DD key `back` days before today, for walking the 14-day window. */
function dateStr(back) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Parsed from the parts, never new Date(iso): the string form is treated as UTC
   and would shift the weekday backwards for anyone west of UTC, landing
   Thursday's list on Wednesday evening. */
function weekdayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
}

/* ---------------- Which tasks apply to a day ----------------
   One pair of functions answers this for ANY date, not just today, because the
   14-day panel has to know whether a task was even on the list on a past date
   before it can say anything about how often it was skipped. */
function sectionsFor(iso) {
  const dow = weekdayOf(iso);
  return SECTIONS.filter((s) => s.days.includes(dow));
}

function tasksFor(iso) {
  return sectionsFor(iso).flatMap((s) => s.tasks);
}

function visibleTasks() {
  return tasksFor(currentDate);
}

/* An N/A row is neither done nor outstanding — it is off the list, so it is
   false here AND absent from the denominator in renderProgress. */
function isDone(task) {
  if (state.na[task.id]) return false;
  return !!state.checked[task.id];
}

function activeTasks() {
  return visibleTasks().filter((t) => !state.na[t.id]);
}

/* ---------------- API ---------------- */
async function api(path, options) {
  const res = await fetch(`/api/${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = msg;
  el.hidden = false;
}
function clearError() {
  document.getElementById("errorBanner").hidden = true;
}

/* Load failure is never silent: the checklist blocks input and says so, with a
   retry. Swallowing this is what let a failed load turn into a wiped record. */
function showLoadBlocker(msg) {
  const el = document.getElementById("loadBlocker");
  document.getElementById("loadBlockerText").textContent =
    `Couldn't load today's data — don't tick yet. (${msg})`;
  el.hidden = false;
}
function hideLoadBlocker() {
  document.getElementById("loadBlocker").hidden = true;
}

/* ---------------- Save indicator ---------------- */
function setSaveState(kind) {
  const el = document.getElementById("saveState");
  clearTimeout(savedFlashTimer);
  el.classList.remove("savestate--saved", "savestate--error");
  if (kind === "saving") {
    el.textContent = "Saving…";
    el.hidden = false;
  } else if (kind === "saved") {
    el.textContent = "Saved ✓";
    el.classList.add("savestate--saved");
    el.hidden = false;
    savedFlashTimer = setTimeout(() => { el.hidden = true; }, 2000);
  } else if (kind === "error") {
    el.textContent = "Not saved";
    el.classList.add("savestate--error");
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/* ---------------- Autosave ----------------
   Ticks and N/A save immediately — they are single, deliberate actions and
   there is nothing to coalesce. Only typing is debounced. */
function queueMap(map, id, value) {
  pending[map][id] = value;
  clearTimeout(saveTimer);
  saveTimer = null;
  pushState();
}

function queueChecked(id, value) { queueMap("checked", id, value); }
function queueNa(id, value) { queueMap("na", id, value); }

function queueNote(field, value) {
  pending[field] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushState, NOTES_DEBOUNCE_MS);
}

function hasPending() {
  return (
    Object.keys(pending.checked).length > 0 ||
    Object.keys(pending.na).length > 0 ||
    NOTE_FIELDS.some((f) => f in pending)
  );
}

/* The one place a write payload is built, for both the normal save path and the
   exit flush — so the two can never drift into disagreeing about what gets
   sent. Only changed fields are included; absent means "leave alone" server-side. */
function buildPayload() {
  const payload = { date: currentDate };
  for (const map of ["checked", "na"]) {
    if (Object.keys(pending[map]).length) payload[map] = { ...pending[map] };
  }
  for (const f of NOTE_FIELDS) {
    if (f in pending) payload[f] = pending[f];
  }
  return payload;
}

function takePending() {
  if (!hasPending()) return null;
  const payload = buildPayload();
  pending = { checked: {}, na: {} };
  return payload;
}

/* Put a failed payload back so nothing is lost, without clobbering anything the
   user has changed since — newer edits always win. */
function restorePending(payload) {
  for (const map of ["checked", "na"]) {
    if (!payload[map]) continue;
    for (const [id, v] of Object.entries(payload[map])) {
      if (!(id in pending[map])) pending[map][id] = v;
    }
  }
  for (const f of NOTE_FIELDS) {
    if (f in payload && !(f in pending)) pending[f] = payload[f];
  }
}

async function pushState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!loaded) return; // load must resolve before any write is permitted
  if (inFlight) return; // a save is running; it re-checks pending when it finishes
  const payload = takePending();
  if (!payload) return;

  inFlight = true;
  setSaveState("saving");
  let ok = false;
  try {
    await api("state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    ok = true;
    setSaveState("saved");
    clearError();
    recentLoaded = false; // the 14-day panel is now one edit out of date
  } catch (e) {
    restorePending(payload);
    setSaveState("error");
    showError(`Couldn't save: ${e.message}`);
  } finally {
    inFlight = false;
  }
  // Only chain on success — on failure we stop and wait for the next user
  // action or exit flush, rather than hammering a dead endpoint in a loop.
  if (ok && hasPending()) await pushState();
}

/* ---------------- Exit flush ----------------
   A debounced or in-flight save does not survive the page being hidden: iOS
   freezes timers the moment the tab goes to the background and a plain fetch
   is cancelled on unload. sendBeacon is handed to the browser and sent
   regardless of what happens to the page.

   Known limit, accepted: sendBeacon returns only "queued / not queued" and
   exposes no response, so the indicator cannot confirm the write landed. It
   shows "Saving…" and the next load reconciles the truth. `pending` is
   deliberately NOT cleared here — the write is an idempotent merge, so if the
   page survives, saving it again is harmless and covers a beacon that failed. */
function flushOnExit() {
  if (!loaded || !hasPending()) return;
  const body = JSON.stringify(buildPayload());
  let sent = false;
  if (navigator.sendBeacon) {
    // sendBeacon cannot set headers, so the content type rides on the Blob.
    sent = navigator.sendBeacon("/api/state", new Blob([body], { type: "application/json" }));
  }
  if (!sent) {
    fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }
  setSaveState("saving");
}

/* ---------------- Rendering ---------------- */
function inputsDisabled() {
  return state.submitted || !loaded;
}

function chip(className, text) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  return el;
}

function renderTasks() {
  const host = document.getElementById("taskList");
  host.innerHTML = "";
  for (const section of sectionsFor(currentDate)) {
    host.append(renderSection(section));
  }
}

function renderSection(section) {
  const wrap = document.createElement("section");
  wrap.className = "section";

  const head = document.createElement("div");
  head.className = "section__head";
  const title = document.createElement("h3");
  title.className = "section__title";
  title.textContent = section.title;
  const time = document.createElement("span");
  time.className = "section__time";
  time.textContent = section.time;
  head.append(title, time);

  const list = document.createElement("ul");
  list.className = "tasks";
  for (const task of section.tasks) list.append(renderTask(task));

  wrap.append(head, list);
  return wrap;
}

function renderTask(task) {
  const na = !!state.na[task.id];
  const done = isDone(task);

  const li = document.createElement("li");
  li.className = "task" + (done ? " task--done" : "") + (na ? " task--na" : "");
  li.dataset.id = task.id;

  // head holds everything that must stay one uniform row height; on a narrow
  // screen the tools wrap beneath the label rather than squeezing it.
  const head = document.createElement("div");
  head.className = "task__head";

  // The row is a <label> so the whole thing is a hit target for its checkbox.
  const row = document.createElement("label");
  row.className = "task__row";

  const box = document.createElement("span");
  box.className = "task__box";
  box.textContent = "✓";
  box.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "task__label";
  label.textContent = task.label;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!state.checked[task.id];
  input.disabled = inputsDisabled() || na;
  input.addEventListener("change", () => {
    state.checked[task.id] = input.checked;
    li.classList.toggle("task--done", isDone(task));
    renderProgress();
    queueChecked(task.id, input.checked);
  });
  row.append(input, box, label);
  head.append(row);

  /* The head goes into the row NOW, before anything below adds to it. The note
     panel is a child of the <li>, not of the head, and must come after it — so
     the head has to be appended first and then mutated in place, rather than
     assembled and appended last. */
  li.append(head);

  const tools = document.createElement("div");
  tools.className = "task__tools";
  head.append(tools);

  // One chip or several — a lone object is treated as a list of one so the
  // common single-link case stays a plain object in the config.
  for (const link of [].concat(task.link || [])) {
    const a = document.createElement("a");
    a.className = "task__link";
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.text;
    tools.append(a);
  }

  if (task.notes) tools.append(renderNoteButton(task, li));
  tools.append(renderNaButton(task));

  return li;
}

/* Builds both halves of the note affordance and returns only the button: the
   collapsible panel is appended straight onto the <li>, because the two live in
   different parents — the button belongs in the tools row, the panel below it. */
function renderNoteButton(task, li) {
  const field = task.notes.field;
  const panelId = `taskNotes-${task.id}`;
  const open = !!notesOpen[task.id];

  const wrap = document.createElement("div");
  wrap.className = "task__notes";
  wrap.id = panelId;
  wrap.hidden = !open;

  const ta = document.createElement("textarea");
  ta.className = "field__input field__input--small";
  ta.id = `note-${task.id}`;
  ta.rows = 2;
  ta.placeholder = task.notes.placeholder;
  ta.value = state[field] || "";
  ta.disabled = inputsDisabled();
  wrap.append(ta);
  li.append(wrap);

  const toggle = chip(
    "task__note-btn" + (ta.value.trim() ? " task__note-btn--filled" : ""),
    "Note"
  );
  toggle.title = task.notes.title;
  toggle.setAttribute("aria-label", task.notes.title);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", panelId);

  ta.addEventListener("input", () => {
    state[field] = ta.value;
    toggle.classList.toggle("task__note-btn--filled", ta.value.trim() !== "");
    queueNote(field, ta.value);
  });
  toggle.addEventListener("click", () => {
    const next = !notesOpen[task.id];
    notesOpen[task.id] = next;
    wrap.hidden = !next;
    toggle.setAttribute("aria-expanded", String(next));
    if (next) ta.focus();
  });

  return toggle;
}

/* N/A takes the row off today's list entirely — greyed, not counted, and
   recorded so the 14-day panel can point out a row you keep skipping.

   On the two outreach rows the button is rendered DISABLED rather than omitted.
   Leaving it out would read as an oversight; leaving it in, greyed, with the
   reason on it, says the answer is no on purpose. */
function renderNaButton(task) {
  const na = !!state.na[task.id];
  const btn = chip("na-btn" + (na ? " na-btn--on" : ""), "N/A");
  btn.setAttribute("aria-pressed", String(na));

  if (!task.na) {
    btn.disabled = true;
    btn.title = task.naHint;
    btn.setAttribute("aria-label", `N/A unavailable — ${task.naHint}`);
    return btn;
  }

  btn.disabled = inputsDisabled();
  btn.title = na ? `${task.label} — marked N/A today` : `Mark "${task.label}" N/A today`;
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", () => {
    const next = !state.na[task.id];
    state.na[task.id] = next;
    queueNa(task.id, next);
    /* A full re-render, not a class toggle: the row's tick has to be disabled
       and the denominator recomputed. Cheap, and there is no caret to lose —
       the press has already moved focus off any field. */
    renderAll();
  });
  return btn;
}

function renderProgress() {
  const active = activeTasks();
  const total = active.length;
  const done = active.filter(isDone).length;
  const naCount = visibleTasks().length - total;

  document.getElementById("taskCount").textContent =
    `${done}/${total} done${naCount ? ` · ${naCount} N/A` : ""}`;
  document.getElementById("progressLabel").textContent = `${done} of ${total} done`;

  const fill = document.getElementById("progressFill");
  const pct = total ? (done / total) * 100 : 0;
  fill.style.width = `${pct}%`;
  fill.classList.toggle("progressbar__fill--full", total > 0 && done === total);
}

function renderSubmitState() {
  document.getElementById("submitPending").hidden = state.submitted;
  document.getElementById("submitDone").hidden = !state.submitted;
  document.getElementById("submitBtn").disabled = !loaded;
}

function renderAll() {
  document.getElementById("todayLabel").textContent = prettyDate(currentDate);
  renderTasks();
  renderProgress();
  renderSubmitState();
}

/* ---------------- Notes log ----------------
   Captures the day's Trainerize check-in notes into the persistent log on
   submit. Task notes themselves live in the day record and are saved by the
   autosave path above — this is only the log copy. */
async function saveNotes() {
  const clients = (state.clientNotes || "").trim();
  if (!clients) return;
  if (clients === lastSavedNotes) return;
  try {
    await api("notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: currentDate, general: "", clients }),
    });
    lastSavedNotes = clients;
    logLoaded = false; // refresh log next time it's opened
    clearError();
  } catch (e) {
    showError(`Couldn't save notes: ${e.message}`);
  }
}

async function loadLog() {
  const list = document.getElementById("logList");
  const empty = document.getElementById("logEmpty");
  try {
    const { log } = await api("log");
    list.innerHTML = "";
    const entries = [...log].reverse();
    empty.hidden = entries.length > 0;
    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = "log__entry";
      const date = document.createElement("p");
      date.className = "log__date";
      const t = entry.savedAt
        ? new Date(entry.savedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : "";
      date.textContent = `${prettyDate(entry.date)}${t ? ` · ${t}` : ""}`;
      li.append(date);
      if (entry.general) {
        const p = document.createElement("p");
        p.className = "log__note";
        p.textContent = entry.general;
        li.append(p);
      }
      if (entry.clients) {
        const p = document.createElement("p");
        p.className = "log__note";
        const tag = document.createElement("span");
        tag.className = "log__tag";
        tag.textContent = "Check-in notes: ";
        p.append(tag, document.createTextNode(entry.clients));
        li.append(p);
      }
      list.append(li);
    }
    logLoaded = true;
  } catch (e) {
    showError(`Couldn't load past notes: ${e.message}`);
  }
}

/* ---------------- Last 14 days ----------------
   Reads the stored day records straight back and tallies them. The denominator
   is "days this task was actually on the list AND you opened the app", which is
   why it re-derives the schedule for each past date rather than assuming every
   task existed every day: N/A'ing the ad review twice out of the four Mondays
   and Thursdays in a fortnight is a very different signal from twice out of
   fourteen, and only the schedule knows which it is. */
function tallyRecent(days) {
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  const rows = [];
  for (const task of ALL_TASKS) {
    let occasions = 0, naCount = 0;
    for (let i = 0; i < RECENT_DAYS; i++) {
      const iso = dateStr(i);
      const rec = byDate[iso];
      if (!rec) continue; // app never opened that day — not a skip, just no data
      if (!tasksFor(iso).some((t) => t.id === task.id)) continue; // not on the list
      occasions++;
      if (rec.na && rec.na[task.id]) naCount++;
    }
    if (!occasions) continue;
    rows.push({ task, occasions, naCount });
  }
  return rows;
}

async function loadRecent() {
  const list = document.getElementById("recentList");
  const empty = document.getElementById("recentEmpty");
  const flags = document.getElementById("recentFlags");
  try {
    const { days } = await api(`recent?days=${RECENT_DAYS}`);
    const rows = tallyRecent(days || []);
    list.innerHTML = "";
    flags.innerHTML = "";
    empty.hidden = rows.length > 0;

    for (const row of rows.filter((r) => r.naCount >= NA_FLAG_THRESHOLD)) {
      const p = document.createElement("p");
      p.className = "flag";
      p.textContent = `${row.task.short}: N/A ${row.naCount} times. Pipeline gap?`;
      flags.append(p);
    }

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tally" + (row.naCount >= NA_FLAG_THRESHOLD ? " tally--flagged" : "");

      const name = document.createElement("span");
      name.className = "tally__name";
      name.textContent = row.task.short;

      const meta = document.createElement("span");
      meta.className = "tally__meta";
      meta.textContent = `N/A ${row.naCount} of ${row.occasions}`;

      li.append(name, meta);
      list.append(li);
    }
    recentLoaded = true;
  } catch (e) {
    showError(`Couldn't load the last 14 days: ${e.message}`);
  }
}

/* ---------------- Submit ---------------- */
async function submitDay() {
  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await pushState(); // flush any pending tick/note changes first
    await saveNotes(); // capture today's check-in notes in the log
    await api("submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: currentDate }),
    });
    state.submitted = true;
    recentLoaded = false;
    renderAll();
    clearError();
  } catch (e) {
    showError(`Couldn't submit: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit today ✓";
  }
}

/* ---------------- Load / day rollover ---------------- */
async function load() {
  currentDate = todayStr();
  try {
    const data = await api(`state?date=${currentDate}`);
    const day = data.day || {};
    state = {
      ...state,
      ...day,
      checked: { ...(day.checked || {}) },
      na: { ...(day.na || {}) },
    };
    loaded = true;
    hideLoadBlocker();
    clearError();
  } catch (e) {
    // Leave `state` alone and keep the gate shut: with loaded === false nothing
    // can be written, so a failed load cannot turn into an overwritten record.
    loaded = false;
    showLoadBlocker(e.message);
  }
  lastSavedNotes = null;
  renderAll();
}

/* A new day is a clean sheet in memory before the fetch, so nothing from
   yesterday can survive into today's record even if the load then fails. */
function startNewDay() {
  state = emptyState();
  pending = { checked: {}, na: {} };
  notesOpen = {};
  recentLoaded = false;
  load();
}

/* Midnight rollover for a tab that is simply left open — the visibilitychange
   handler below only fires on a return to the page, and this list is meant to
   be sitting there at 9am on the day it belongs to. */
setInterval(() => {
  if (todayStr() !== currentDate) startNewDay();
}, ROLLOVER_POLL_MS);

// On re-focus: if the calendar day rolled over, start fresh; if there are
// unsaved edits, push them rather than reloading over the top of them;
// otherwise re-sync from the server (picks up another device, avoids stale
// state). Reloading while edits are pending would discard them.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    flushOnExit();
    return;
  }
  if (todayStr() !== currentDate) {
    startNewDay();
  } else if (hasPending()) {
    pushState();
  } else if (!inFlight) {
    load();
  }
});

// pagehide covers the cases visibilitychange does not: tab close, back/forward
// navigation, and iOS killing the page outright.
window.addEventListener("pagehide", flushOnExit);

/* ---------------- Wire up ---------------- */
function wirePanel(btnId, panelId, onFirstOpen) {
  document.getElementById(btnId).addEventListener("click", async (e) => {
    const panel = document.getElementById(panelId);
    const open = panel.hidden;
    panel.hidden = !open;
    e.target.textContent = open ? "Hide" : "Show";
    e.target.setAttribute("aria-expanded", String(open));
    if (open) await onFirstOpen();
  });
}

document.getElementById("submitBtn").addEventListener("click", submitDay);
document.getElementById("retryLoadBtn").addEventListener("click", load);
wirePanel("toggleLogBtn", "logPanel", async () => { if (!logLoaded) await loadLog(); });
wirePanel("toggleRecentBtn", "recentPanel", async () => { if (!recentLoaded) await loadRecent(); });

load();
