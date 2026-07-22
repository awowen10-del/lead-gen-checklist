import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_IDS = ["ads", "content", "texts", "clients", "leads"];
const MAX_LOG_ENTRIES = 1000;
const MAX_NOTE_LEN = 5000;

const emptyDay = () => ({
  checked: Object.fromEntries(TASK_IDS.map((id) => [id, false])),
  submitted: false,
  generalNotes: "",
  clientNotes: "",
});

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const err = (status, message) => json({ error: message }, status);

const cleanNote = (v) => (typeof v === "string" ? v.slice(0, MAX_NOTE_LEN) : "");

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  let store;
  try {
    store = getStore("leadgen");
  } catch (e) {
    return err(500, "Storage unavailable — is this site linked on Netlify? " + e.message);
  }

  try {
    // GET /api/state?date=YYYY-MM-DD → today's state + completion history
    if (req.method === "GET" && route === "state") {
      const date = url.searchParams.get("date") || "";
      if (!DATE_RE.test(date)) return err(400, "Invalid or missing date");
      const day = (await store.get(`day:${date}`, { type: "json" })) || emptyDay();
      const history = (await store.get("history", { type: "json" })) || {};
      return json({ day, history });
    }

    // POST /api/state — upsert today's ticks / notes (autosave)
    if (req.method === "POST" && route === "state") {
      const body = await req.json();
      if (!DATE_RE.test(body.date || "")) return err(400, "Invalid or missing date");
      const key = `day:${body.date}`;
      const cur = (await store.get(key, { type: "json" })) || emptyDay();
      // A submitted day is locked — ignore writes (e.g. from a stale open tab)
      if (cur.submitted) return json({ ok: true, day: cur, locked: true });
      const checked = { ...cur.checked };
      if (body.checked && typeof body.checked === "object") {
        for (const id of TASK_IDS) {
          if (typeof body.checked[id] === "boolean") checked[id] = body.checked[id];
        }
      }
      const day = {
        ...cur,
        checked,
        generalNotes: body.generalNotes !== undefined ? cleanNote(body.generalNotes) : cur.generalNotes,
        clientNotes: body.clientNotes !== undefined ? cleanNote(body.clientNotes) : cur.clientNotes,
      };
      await store.setJSON(key, day);
      return json({ ok: true, day });
    }

    // POST /api/submit — mark day complete, feed history
    if (req.method === "POST" && route === "submit") {
      const body = await req.json();
      if (!DATE_RE.test(body.date || "")) return err(400, "Invalid or missing date");
      const key = `day:${body.date}`;
      const day = (await store.get(key, { type: "json" })) || emptyDay();
      day.submitted = true;
      day.submittedAt = new Date().toISOString();
      await store.setJSON(key, day);
      const history = (await store.get("history", { type: "json" })) || {};
      history[body.date] = true;
      await store.setJSON("history", history);
      return json({ ok: true, day, history });
    }

    // POST /api/notes — append an entry to the notes log
    if (req.method === "POST" && route === "notes") {
      const body = await req.json();
      if (!DATE_RE.test(body.date || "")) return err(400, "Invalid or missing date");
      const general = cleanNote(body.general);
      const clients = cleanNote(body.clients);
      if (!general.trim() && !clients.trim()) return err(400, "Nothing to save");
      let log = (await store.get("noteslog", { type: "json" })) || [];
      if (!Array.isArray(log)) log = [];
      log.push({ date: body.date, savedAt: new Date().toISOString(), general, clients });
      if (log.length > MAX_LOG_ENTRIES) log = log.slice(-MAX_LOG_ENTRIES);
      await store.setJSON("noteslog", log);
      return json({ ok: true, count: log.length });
    }

    // GET /api/log — the notes log
    if (req.method === "GET" && route === "log") {
      const log = (await store.get("noteslog", { type: "json" })) || [];
      return json({ log: Array.isArray(log) ? log : [] });
    }

    return err(404, "Not found");
  } catch (e) {
    return err(500, e.message || "Server error");
  }
};
