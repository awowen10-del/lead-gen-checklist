"use strict";

/* ---------------- Config ---------------- */
/* Completion is keyed by these stable ids, never by position — reordering is
   safe, but an id here must also exist in TASK_IDS in netlify/functions/api.mjs
   or the server will silently drop its ticks. Labels are free to change: they
   are display-only and no stored record references them.

   `notes` gives a task its own collapsible note. `field` is the day-record
   field the text is stored in and must also exist in NOTE_FIELDS in
   netlify/functions/api.mjs, or the note will save to nothing.

   `link` is one chip or an array of them; they render in the order given.
   Keep the text short — chips sit on the task row and must not wrap.

   `mirror` shows ANOTHER task's note here, read-only. It reads an existing
   field and writes nothing, so it adds no field to the day record.

   Array order IS the display order, and it is deliberate: check-ins sit
   immediately before content because the wins captured there are the material
   for the day's stories. Reordering is safe — nothing stored references
   position — but keep that pair adjacent and in that order. */
const TASKS = [
  { id: "texts", label: "Message new leads", link: { url: "https://salesfollowup-bodysculpt.netlify.app", text: "Follow-ups ↗" } },
  { id: "leads", label: "Follow up leads that are parked or have been quiet for 2 weeks" },
  {
    id: "dm",
    label: "DM outreach",
    link: [
      { url: "https://www.instagram.com", text: "Instagram ↗" },
      { url: "https://business.facebook.com/latest/inbox/all", text: "Meta Inbox ↗" },
    ],
  },
  {
    id: "ads",
    label: "Launch / tweak new ads",
    link: { url: "https://bodysculpt-ad-intelligence.netlify.app", text: "Ad Intel ↗" },
    notes: { field: "adsNotes", placeholder: "Ad notes…", title: "Ad notes" },
  },
  {
    id: "clients",
    label: "Check in with clients",
    link: { url: "https://bodysculpt4.trainerize.com/app/overview", text: "Trainerize ↗" },
    notes: {
      field: "clientNotes",
      placeholder: "Wins, quotes, transformations — anything worth posting",
      title: "Check-in notes",
    },
  },
  {
    id: "content",
    label: "Post content / stories",
    link: { url: "https://bodysculptcontent.netlify.app", text: "Content ↗" },
    mirror: { field: "clientNotes", title: "Today's check-in wins" },
  },
  { id: "onboarding", label: "Check onboarding tracker for any outstanding jobs", link: { url: "https://bodysculpt-onboarding.netlify.app", text: "Onboarding ↗" } },
];

/* Every free-text field the day record carries, derived from TASKS so adding a
   note to a task is a one-line change. Save, restore and exit-flush all iterate
   this — none of them names a field directly. */
const NOTE_FIELDS = TASKS.filter((t) => t.notes).map((t) => t.notes.field);

const NOTES_DEBOUNCE_MS = 600;

const emptyChecked = () => Object.fromEntries(TASKS.map((t) => [t.id, false]));
const emptyState = () => ({
  checked: emptyChecked(),
  submitted: false,
  ...Object.fromEntries(NOTE_FIELDS.map((f) => [f, ""])),
});

/* ---------------- State ---------------- */
let state = emptyState();
let history = {};
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
let pending = { checked: {} };
let inFlight = false;
let saveTimer = null;
let savedFlashTimer = null;

let lastSavedNotes = null; // snapshot of last notes saved to the log
let logLoaded = false;
let notesOpen = {}; // task id → whether its collapsible note panel is expanded

/* ---------------- Date helpers ----------------
   todayStr() is the ONE place a date key is ever generated, and it is purely
   local-time (getFullYear/getMonth/getDate — never toISOString, which would
   shift the key across UTC midnight). currentDate is set from it and from
   nothing else. */
function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
}

/* ---------------- Streak logic (forgiving) ----------------
   Walk back day by day from today (today itself only counts once
   submitted, and never counts as a miss). A single missed day is
   skipped; only 2+ consecutive missed days end the run. */
function computeRun() {
  let run = 0;
  let misses = 0;
  let offset = state.submitted ? 0 : -1;
  for (let i = 0; i < 366; i++) {
    const day = todayStr(offset - i);
    if (history[day]) {
      run++;
      misses = 0;
    } else {
      misses++;
      if (misses >= 2) break;
    }
  }
  return run;
}

function computeMonth() {
  const prefix = currentDate.slice(0, 7); // YYYY-MM
  return Object.keys(history).filter((d) => d.startsWith(prefix) && history[d]).length;
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
   Ticks save immediately — they are single, deliberate actions and there is
   nothing to coalesce. Only free-text typing is debounced. */
function queueChecked(id, value) {
  pending.checked[id] = value;
  clearTimeout(saveTimer);
  saveTimer = null;
  pushState();
}

function queueNote(field, value) {
  pending[field] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushState, NOTES_DEBOUNCE_MS);
}

function hasPending() {
  return (
    Object.keys(pending.checked).length > 0 ||
    NOTE_FIELDS.some((f) => f in pending)
  );
}

/* The one place a write payload is built, for both the normal save path and the
   exit flush — so the two can never drift into disagreeing about what gets
   sent. Only changed fields are included; absent means "leave alone" server-side. */
function buildPayload() {
  const payload = { date: currentDate };
  if (Object.keys(pending.checked).length) payload.checked = { ...pending.checked };
  for (const f of NOTE_FIELDS) {
    if (f in pending) payload[f] = pending[f];
  }
  return payload;
}

function takePending() {
  if (!hasPending()) return null;
  const payload = buildPayload();
  pending = { checked: {} };
  return payload;
}

/* Put a failed payload back so nothing is lost, without clobbering anything the
   user has changed since — newer edits always win. */
function restorePending(payload) {
  if (payload.checked) {
    for (const [id, v] of Object.entries(payload.checked)) {
      if (!(id in pending.checked)) pending.checked[id] = v;
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

function renderTasks() {
  const list = document.getElementById("taskList");
  list.innerHTML = "";
  for (const task of TASKS) {
    const li = document.createElement("li");
    li.className = "task" + (state.checked[task.id] ? " task--done" : "");
    li.dataset.id = task.id;

    // head holds everything that must stay one uniform row height
    const head = document.createElement("div");
    head.className = "task__head";

    const row = document.createElement("label");
    row.className = "task__row";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!state.checked[task.id];
    input.disabled = inputsDisabled();
    input.addEventListener("change", () => {
      state.checked[task.id] = input.checked;
      li.classList.toggle("task--done", input.checked);
      renderProgress();
      queueChecked(task.id, input.checked);
    });

    const box = document.createElement("span");
    box.className = "task__box";
    box.textContent = "✓";
    box.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "task__label";
    label.textContent = task.label;

    row.append(input, box, label);
    head.append(row);

    // One chip or several — a lone object is treated as a list of one so the
    // common single-link case stays a plain object in TASKS.
    for (const link of [].concat(task.link || [])) {
      const a = document.createElement("a");
      a.className = "task__link";
      a.href = link.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = link.text;
      head.append(a);
    }

    li.append(head);

    if (task.notes) {
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

      // small affordance in the row; keeps every row the same height
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className =
        "task__note-btn" + (ta.value.trim() ? " task__note-btn--filled" : "");
      toggle.textContent = "🗒";
      toggle.title = task.notes.title;
      toggle.setAttribute("aria-label", task.notes.title);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-controls", panelId);

      ta.addEventListener("input", () => {
        state[field] = ta.value;
        toggle.classList.toggle("task__note-btn--filled", ta.value.trim() !== "");
        syncMirrors();
        queueNote(field, ta.value);
      });
      toggle.addEventListener("click", () => {
        const next = !notesOpen[task.id];
        notesOpen[task.id] = next;
        wrap.hidden = !next;
        toggle.setAttribute("aria-expanded", String(next));
        if (next) ta.focus();
      });

      head.append(toggle);
      li.append(wrap);
    }

    /* Read-only view of another task's note, so the wins captured during
       check-ins are in front of you while posting instead of a scroll away.
       Nothing here is editable and nothing is saved — the source textarea on
       the check-in task remains the only writer of the field. Empty source
       means no panel and no button at all, not an empty box. */
    if (task.mirror) {
      const panelId = `taskMirror-${task.id}`;
      const text = (state[task.mirror.field] || "").trim();
      const open = !!notesOpen[task.id];

      const wrap = document.createElement("div");
      wrap.className = "task__notes";
      wrap.id = panelId;
      wrap.hidden = !open || !text;

      const heading = document.createElement("p");
      heading.className = "task__mirror-label";
      heading.textContent = task.mirror.title;

      const body = document.createElement("p");
      body.className = "task__mirror-text";
      body.textContent = text;

      wrap.append(heading, body);

      const toggle = document.createElement("button");
      toggle.type = "button";
      // Always "filled": the button only ever exists when there is something
      // to read, so the accent is the honest state.
      toggle.className = "task__note-btn task__note-btn--filled";
      toggle.id = `mirrorBtn-${task.id}`;
      toggle.textContent = "✨";
      toggle.title = task.mirror.title;
      toggle.setAttribute("aria-label", task.mirror.title);
      toggle.setAttribute("aria-expanded", String(open && !!text));
      toggle.setAttribute("aria-controls", panelId);
      toggle.hidden = !text;

      toggle.addEventListener("click", () => {
        const next = !notesOpen[task.id];
        notesOpen[task.id] = next;
        wrap.hidden = !next;
        toggle.setAttribute("aria-expanded", String(next));
      });

      head.append(toggle);
      li.append(wrap);
    }

    list.append(li);
  }
}

/* Keep every mirror in step with its source as it is typed. This patches the
   DOM in place rather than calling renderTasks(), which would rebuild the
   textarea being typed into and take the caret with it. */
function syncMirrors() {
  for (const task of TASKS) {
    if (!task.mirror) continue;
    const wrap = document.getElementById(`taskMirror-${task.id}`);
    const toggle = document.getElementById(`mirrorBtn-${task.id}`);
    if (!wrap || !toggle) continue;
    const text = (state[task.mirror.field] || "").trim();
    const body = wrap.querySelector(".task__mirror-text");
    if (body) body.textContent = text;
    toggle.hidden = !text;
    toggle.setAttribute("aria-expanded", String(!!text && !!notesOpen[task.id]));
    wrap.hidden = !text || !notesOpen[task.id];
  }
}

function renderProgress() {
  const done = TASKS.filter((t) => state.checked[t.id]).length;
  document.getElementById("taskCount").textContent = `${done}/${TASKS.length} done`;
  document.getElementById("progressLabel").textContent = `${done} of ${TASKS.length} done`;
  const fill = document.getElementById("progressFill");
  fill.style.width = `${(done / TASKS.length) * 100}%`;
  fill.classList.toggle("progressbar__fill--full", done === TASKS.length);
}

function renderStats() {
  document.getElementById("stats").hidden = false;
  const run = computeRun();
  document.getElementById("statRun").textContent = run === 1 ? "1 day" : `${run} days`;

  // Flag colour on the streak tile, using the dashboard's translucent-accent
  // pattern. Green at a 3+ day run, amber at 1-2, neutral at 0 — deliberately
  // no red, since a missed morning is not an error state.
  const runTile = document.getElementById("statRunTile");
  runTile.classList.toggle("stat--good", run >= 3);
  runTile.classList.toggle("stat--warn", run > 0 && run < 3);

  // Month name comes from currentDate, not from a fresh Date() — otherwise the
  // count (which is keyed off currentDate) and its label disagree across a
  // month boundary.
  const [y, m] = currentDate.split("-").map(Number);
  const monthName = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long" });
  document.getElementById("statMonth").textContent = String(computeMonth());
  document.getElementById("statMonthLabel").textContent = `✅ days in ${monthName}`;

  const week = document.getElementById("weekDots");
  week.innerHTML = "";
  for (let i = 6; i >= 0; i--) {
    const day = todayStr(-i);
    const dot = document.createElement("span");
    dot.className = "week__dot" +
      (history[day] ? " week__dot--done" : "") +
      (i === 0 ? " week__dot--today" : "");
    dot.title = prettyDate(day);
    week.append(dot);
  }
}

function renderSubmitState() {
  document.getElementById("submitPending").hidden = state.submitted;
  document.getElementById("submitDone").hidden = !state.submitted;
  if (state.submitted) {
    const run = computeRun();
    document.getElementById("doneText").textContent =
      run > 1
        ? `Nice work — that's a ${run}-day run. See you tomorrow at 9am.`
        : "Nice work — today is logged. See you tomorrow at 9am.";
  }
  document.getElementById("submitBtn").disabled = !loaded;
  document.querySelectorAll("#taskList input").forEach((el) => (el.disabled = inputsDisabled()));
  document.querySelectorAll("#taskList textarea").forEach((el) => (el.disabled = inputsDisabled()));
}

function renderAll() {
  document.getElementById("todayLabel").textContent = prettyDate(currentDate);
  renderTasks();
  renderProgress();
  renderStats();
  renderSubmitState();
}

/* ---------------- Notes log ----------------
   Called only on submit now that the day-notes card is gone: it captures the
   day's client check-in notes into the persistent log. Task notes themselves
   live in the day record and are saved by the autosave path above — this is
   only the log copy. */
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
        tag.textContent = "Client check-ins: ";
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

/* ---------------- Submit ---------------- */
async function submitDay() {
  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await pushState(); // flush any pending tick/notes changes first
    await saveNotes(); // capture today's check-in notes in the log
    const { history: h } = await api("submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: currentDate }),
    });
    history = h;
    state.submitted = true;
    renderStats();
    renderSubmitState();
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
    state = { ...state, ...data.day, checked: { ...emptyChecked(), ...data.day.checked } };
    history = data.history || {};
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
    state = emptyState();
    pending = { checked: {} };
    notesOpen = {};
    load();
  } else if (hasPending()) {
    pushState();
  } else if (!inFlight) {
    load();
  }
});

// pagehide covers the cases visibilitychange does not: tab close, back/forward
// navigation, and iOS killing the page outright.
window.addEventListener("pagehide", flushOnExit);

/* ---------------- Light / dark theme ----------------
   Inherited from the dashboard: same function names, same data-theme attribute
   on <html>, same localStorage key ("bodysculpt:theme"), so a choice made on
   either site is honoured by the other. Purely visual — no render path, no
   data and no behaviour depends on it. The boot script in <head> applies the
   stored value before the stylesheet parses; this only handles the toggle. */
function bsTheme() {
  try { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
  catch (e) { return "light"; }
}
function bsSetTheme(t) {
  const next = t === "dark" ? "dark" : "light";
  try { document.documentElement.setAttribute("data-theme", next); } catch (e) {}
  try { localStorage.setItem("bodysculpt:theme", next); } catch (e) {}
  // keep the iOS status bar in step with the page background
  const meta = document.getElementById("themeColorMeta");
  if (meta) meta.setAttribute("content", next === "dark" ? "#0f1b2d" : "#f2f4f8");
  bsSyncThemeBtn();
  return next;
}
function bsToggleTheme() { return bsSetTheme(bsTheme() === "dark" ? "light" : "dark"); }
// The button offers the theme you'd switch TO, so its label always names the next state.
function bsSyncThemeBtn() {
  const b = document.getElementById("themeToggle");
  if (!b) return;
  const dark = bsTheme() === "dark";
  b.textContent = dark ? "☀ Light" : "☾ Dark";
  b.title = dark ? "Switch to the light theme" : "Switch to the dark theme";
  b.setAttribute("aria-pressed", dark ? "true" : "false");
}
// Boot: the <head> script already applied the stored theme, so only the button
// label and the status-bar colour need bringing into line on first paint.
bsSyncThemeBtn();
(function syncThemeColorOnBoot() {
  const meta = document.getElementById("themeColorMeta");
  if (meta) meta.setAttribute("content", bsTheme() === "dark" ? "#0f1b2d" : "#f2f4f8");
})();

/* ---------------- Wire up ---------------- */
document.getElementById("submitBtn").addEventListener("click", submitDay);
document.getElementById("retryLoadBtn").addEventListener("click", load);
document.getElementById("toggleLogBtn").addEventListener("click", async (e) => {
  const panel = document.getElementById("logPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  e.target.textContent = open ? "Hide" : "Show";
  e.target.setAttribute("aria-expanded", String(open));
  if (open && !logLoaded) await loadLog();
});

load();
