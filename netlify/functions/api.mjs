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
//
// Which ids the client SHOWS on a given day (see `days` in TASKS — "email" is
// Thursday-only) is deliberately not modelled here. The server stores whatever
// it is sent and defaults the rest to false, so a day record is the same shape
// every day and changing the schedule needs no server change and rewrites no
// history.
const TASK_IDS = ["ads", "content", "texts", "clients", "leads", "onboarding", "dm", "email"];
// The subset that was briefly stored as a number rather than a tick. Both rows
// are plain ticks again, so nothing writes these any more — but the field is
// retained on the same grounds as the dead note fields below: days already
// stored carry a count, and keeping the id here keeps those values readable in
// the record rather than making them invisible.
const COUNT_IDS = ["leads", "dm"];
const MAX_COUNT = 999;
const MAX_RECENT_DAYS = 60;
// Allowlist for the free-text fields on a day record — must stay in sync with
// NOTE_FIELDS in public/app.js. Same additive rule as TASK_IDS.
//
// `generalNotes` is retained deliberately. Its UI (the "Notes — what happened
// today" card) was removed, so nothing writes it any more, but days already
// stored carry one and the merge below leaves untouched fields alone. Dropping
// it from here would not delete anything, but keeping it means the historic
// values stay readable in the record rather than becoming invisible.
//
// `emailNotes` is retained on the same grounds: the Thursday email row lost its
// note when the list was restructured into sections, so nothing writes it any
// more, but anything already stored stays readable.
const NOTE_FIELDS = ["generalNotes", "clientNotes", "adsNotes", "emailNotes"];
const MAX_LOG_ENTRIES = 1000;
const MAX_NOTE_LEN = 5000;

/* A day record is the same shape every day. Which ids the client SHOWS on a
   given date is a client concern (see SECTIONS in public/app.js) and is
   deliberately not modelled here, so changing the schedule needs no server
   change and rewrites no history.

   `na` is the one map whose absence is meaningful rather than merely empty: a
   task not present in it was not marked N/A, which is exactly what the 14-day
   tally reads. */
const emptyDay = () => ({
  checked: Object.fromEntries(TASK_IDS.map((id) => [id, false])),
  counts: Object.fromEntries(COUNT_IDS.map((id) => [id, 0])),
  na: {},
  submitted: false,
  ...Object.fromEntries(NOTE_FIELDS.map((f) => [f, ""])),
});

const cleanCount = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_COUNT, n));
};

/* The last `n` calendar dates ending today, as YYYY-MM-DD. Built from a local
   Date for the same reason the client does — toISOString would shift the key
   across UTC midnight and quietly drop or duplicate a day at the window edge. */
const recentDates = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    );
  }
  return out;
};

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
      const counts = { ...(cur.counts || {}) };
      if (body.counts && typeof body.counts === "object") {
        for (const id of COUNT_IDS) {
          if (body.counts[id] !== undefined) counts[id] = cleanCount(body.counts[id]);
        }
      }
      const na = { ...(cur.na || {}) };
      if (body.na && typeof body.na === "object") {
        for (const id of TASK_IDS) {
          if (typeof body.na[id] === "boolean") na[id] = body.na[id];
        }
      }
      const day = { ...cur, checked, counts, na };
      for (const f of NOTE_FIELDS) {
        // undefined means "not sent, leave alone" — the contract above. Only a
        // field the client explicitly included is ever overwritten.
        if (body[f] !== undefined) day[f] = cleanNote(body[f]);
        else if (day[f] === undefined) day[f] = "";
      }
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

    /* GET /api/recent?days=14 — the raw day records behind the 14-day panel.
       Only the fields the panel tallies are returned, and notes are deliberately
       NOT among them: this route exists to count ticks, counts and N/As, and
       shipping the free text as well would put every note on the wire for a
       panel that never displays one. Days with no record are simply absent —
       "the app was never opened" is not the same as "nothing was done", and the
       client relies on being able to tell them apart. */
    if (req.method === "GET" && route === "recent") {
      const asked = parseInt(url.searchParams.get("days") || "14", 10);
      const n = Math.max(1, Math.min(MAX_RECENT_DAYS, Number.isFinite(asked) ? asked : 14));
      const dates = recentDates(n);
      const records = await Promise.all(
        dates.map((date) => store.get(`day:${date}`, { type: "json" }))
      );
      const days = [];
      for (let i = 0; i < dates.length; i++) {
        const rec = records[i];
        if (!rec) continue;
        days.push({
          date: dates[i],
          checked: rec.checked || {},
          counts: rec.counts || {},
          na: rec.na || {},
          submitted: !!rec.submitted,
        });
      }
      return json({ days });
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
