"use strict";

/* ---------------- Config ---------------- */
const TASKS = [
  { id: "ads", label: "Launch / tweak new ads", link: { url: "https://bodysculpt-ad-intelligence.netlify.app", text: "Ad Intel ↗" } },
  { id: "content", label: "Post content / stories" },
  { id: "texts", label: "Texts + follow-ups", link: { url: "https://salesfollowup-bodysculpt.netlify.app", text: "Follow-ups ↗" } },
  { id: "clients", label: "Check in with clients", notes: true },
  { id: "leads", label: "Reach out to old leads" },
];

/* ---------------- State ---------------- */
let state = {
  checked: Object.fromEntries(TASKS.map((t) => [t.id, false])),
  submitted: false,
  generalNotes: "",
  clientNotes: "",
};
let history = {};
let currentDate = todayStr();
let saveTimer = null;
let dirty = false; // true only after a real user interaction — a stale tab must never autosave
let lastSavedNotes = null; // snapshot of last notes saved to the log
let logLoaded = false;

/* ---------------- Date helpers ---------------- */
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

/* ---------------- Autosave (debounced) ---------------- */
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushState, 600);
}

async function pushState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return; // never write state the user hasn't actually changed
  try {
    await api("state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: currentDate,
        checked: state.checked,
        generalNotes: state.generalNotes,
        clientNotes: state.clientNotes,
      }),
    });
    dirty = false;
    clearError();
  } catch (e) {
    showError(`Couldn't save: ${e.message}`);
  }
}

/* ---------------- Rendering ---------------- */
function renderTasks() {
  const list = document.getElementById("taskList");
  list.innerHTML = "";
  for (const task of TASKS) {
    const li = document.createElement("li");
    li.className = "task" + (state.checked[task.id] ? " task--done" : "");
    li.dataset.id = task.id;

    const row = document.createElement("label");
    row.className = "task__row";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!state.checked[task.id];
    input.disabled = state.submitted;
    input.addEventListener("change", () => {
      state.checked[task.id] = input.checked;
      li.classList.toggle("task--done", input.checked);
      renderProgress();
      scheduleSave();
    });

    const box = document.createElement("span");
    box.className = "task__box";
    box.textContent = "✓";
    box.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "task__label";
    label.textContent = task.label;

    row.append(input, box, label);

    if (task.link) {
      const a = document.createElement("a");
      a.className = "task__link";
      a.href = task.link.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = task.link.text;
      // don't toggle the checkbox when tapping the link
      a.addEventListener("click", (e) => e.stopPropagation());
      row.append(a);
    }

    li.append(row);

    if (task.notes) {
      const wrap = document.createElement("div");
      wrap.className = "task__notes";
      const ta = document.createElement("textarea");
      ta.className = "field__input field__input--small";
      ta.id = "clientNotes";
      ta.rows = 2;
      ta.placeholder = "Client check-in notes…";
      ta.value = state.clientNotes;
      ta.disabled = state.submitted;
      ta.addEventListener("input", () => {
        state.clientNotes = ta.value;
        scheduleSave();
      });
      // typing in the textarea shouldn't toggle the checkbox
      ta.addEventListener("click", (e) => e.stopPropagation());
      wrap.append(ta);
      li.append(wrap);
    }

    list.append(li);
  }
}

function renderProgress() {
  const done = TASKS.filter((t) => state.checked[t.id]).length;
  document.getElementById("progressLabel").textContent = `${done} of ${TASKS.length} done`;
  const fill = document.getElementById("progressFill");
  fill.style.width = `${(done / TASKS.length) * 100}%`;
  fill.classList.toggle("progressbar__fill--full", done === TASKS.length);
}

function renderStats() {
  document.getElementById("stats").hidden = false;
  const run = computeRun();
  document.getElementById("statRun").textContent = run === 1 ? "1 day" : `${run} days`;

  const monthName = new Date().toLocaleDateString("en-GB", { month: "long" });
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
  document.getElementById("generalNotes").disabled = state.submitted;
  const clientTa = document.getElementById("clientNotes");
  if (clientTa) clientTa.disabled = state.submitted;
  document.querySelectorAll("#taskList input").forEach((el) => (el.disabled = state.submitted));
}

function renderAll() {
  document.getElementById("todayLabel").textContent = prettyDate(currentDate);
  document.getElementById("generalNotes").value = state.generalNotes;
  renderTasks();
  renderProgress();
  renderStats();
  renderSubmitState();
}

/* ---------------- Notes log ---------------- */
async function saveNotes({ silent = false } = {}) {
  const general = state.generalNotes.trim();
  const clients = state.clientNotes.trim();
  const status = document.getElementById("notesStatus");
  if (!general && !clients) {
    if (!silent) {
      status.textContent = "Nothing to save yet";
      status.classList.add("notes__status--error");
      setTimeout(() => { status.textContent = ""; status.classList.remove("notes__status--error"); }, 2500);
    }
    return;
  }
  const snapshot = `${general}\n---\n${clients}`;
  if (snapshot === lastSavedNotes) {
    if (!silent) flashStatus("Already saved ✓");
    return;
  }
  try {
    await api("notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: currentDate, general, clients }),
    });
    lastSavedNotes = snapshot;
    logLoaded = false; // refresh log next time it's opened
    if (!silent) flashStatus("Saved to log ✓");
    clearError();
  } catch (e) {
    if (!silent) {
      status.textContent = "Save failed";
      status.classList.add("notes__status--error");
    }
    showError(`Couldn't save notes: ${e.message}`);
  }
}

function flashStatus(msg) {
  const status = document.getElementById("notesStatus");
  status.classList.remove("notes__status--error");
  status.textContent = msg;
  setTimeout(() => { if (status.textContent === msg) status.textContent = ""; }, 2500);
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
    await saveNotes({ silent: true }); // capture today's notes in the log
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
    state = { ...state, ...data.day, checked: { ...state.checked, ...data.day.checked } };
    history = data.history || {};
    clearError();
  } catch (e) {
    showError(`Can't reach storage — changes won't be saved. (${e.message})`);
  }
  dirty = false;
  lastSavedNotes = null;
  renderAll();
}

// On re-focus: if the calendar day rolled over, start fresh; otherwise re-sync
// from the server (picks up changes made on another device, avoids stale state)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (todayStr() !== currentDate) {
    state = {
      checked: Object.fromEntries(TASKS.map((t) => [t.id, false])),
      submitted: false,
      generalNotes: "",
      clientNotes: "",
    };
    load();
  } else if (!dirty && !saveTimer) {
    load();
  }
});

/* ---------------- Wire up ---------------- */
document.getElementById("generalNotes").addEventListener("input", (e) => {
  state.generalNotes = e.target.value;
  scheduleSave();
});
document.getElementById("saveNotesBtn").addEventListener("click", () => saveNotes());
document.getElementById("submitBtn").addEventListener("click", submitDay);
document.getElementById("toggleLogBtn").addEventListener("click", async (e) => {
  const panel = document.getElementById("logPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  e.target.textContent = open ? "Hide" : "Show";
  e.target.setAttribute("aria-expanded", String(open));
  if (open && !logLoaded) await loadLog();
});

load();
