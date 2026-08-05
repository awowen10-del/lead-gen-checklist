import { getStore } from "@netlify/blobs";

/* TODO — SECURITY, deliberately out of scope for the persistence fix.
   Every route below is unauthenticated. There is no session, no origin check,
   no rate limit and no CORS restriction, so anyone who knows the site URL can
   read the whole notes log, overwrite any day's ticks and notes, and submit
   days to inflate the streak. That was true before this change and is
   unchanged by it. Likely fix: a shared secret in a Netlify env var checked on
   every request (cheap, single-operator), or Netlify Identity if this ever
   needs real accounts. Pick this up after the theme pass. */

export const config = { path: "/api/*" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Allowlist for POST /api/state — must stay in sync with TASKS in public/app.js.
// Additive only: ids are stable, and days saved before an id existed simply
// read back as unticked.
const TASK_IDS = ["ads", "content", "texts", "clients", "leads", "onboarding"];
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
    /* consistency: "strong" is load-bearing, not a nicety. Netlify Blobs
       defaults to "eventual", which serves reads from a cached edge that can
       return a pre-write version of a key for a short window after a write.
       That was the root cause of ticks appearing to vanish: the tick saved
       fine, then the next GET (or the read half of the read-modify-write
       below) returned the stale record and clobbered it. Strong reads go to
       the uncached edge instead. Do not drop back to eventual in this file.

       MUST be the object form. getStore() takes exactly ONE argument, so
       getStore("leadgen", { consistency: "strong" }) silently discards the
       options and leaves you on eventual consistency — no error, no warning,
       and reads that look fine locally but are stale in production. */
    store = getStore({ name: "leadgen", consistency: "strong" });
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

    // POST /api/state — merge a PARTIAL patch into today's record.
    //
    // The client sends only the fields it actually changed (one tick → one id),
    // never a whole day record, so a default/empty payload cannot exist to
    // overwrite notes or other ticks. Every field here is opt-in: absent means
    // "leave alone", and that contract is what makes the partial patch safe.
    //
    // This is a read-modify-write and is therefore not atomic — two writes
    // landing together can interleave and one can be lost. The client
    // serialises its own writes, which is sufficient for a single operator.
    // If this ever goes multi-user, Netlify Blobs supports conditional writes
    // (store.set with onlyIfMatch/onlyIfNew plus the etag from store.getWithMetadata)
    // and that is the place to add them.
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
