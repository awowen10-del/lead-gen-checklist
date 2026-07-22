# Lead-Gen Hour — Daily Checklist

Single-page daily lead-generation checklist for Bodysculpt's 9–10am lead-gen hour.
Five tasks with tickboxes, a notes log, a submit flow, and a forgiving streak tracker.
All data lives in **Netlify Blobs** (store: `leadgen`) — no database, no accounts.

## Stack

- `public/` — static frontend (plain HTML/CSS/JS, no build step)
- `netlify/functions/api.mjs` — one function serving `/api/*`, backed by `@netlify/blobs`
- Theme matched to bodysculpt-ad-intelligence.netlify.app

## Run locally

```bash
npm install
npx netlify-cli dev
```

Local runs use a sandboxed Blobs store (nothing touches production data).

## Deploy

1. Push this folder to a Git repo (GitHub).
2. On Netlify: **Add new site → Import from Git**, pick the repo.
   Build settings come from `netlify.toml` (publish `public`, functions `netlify/functions`).
3. Done — Blobs works automatically on Git-linked sites, no config or env vars needed.

## How it works

- **Ticks & notes autosave** (debounced) to `day:<YYYY-MM-DD>` — reopening the same day
  restores your progress; a new calendar day starts fresh automatically.
- **Save notes** appends today's general + client-check-in notes to a persistent log
  (`noteslog`), viewable under **Past notes**.
- **Submit today** locks the day (further writes to a submitted day are rejected
  server-side) and records it in `history`.
- **Streak** is forgiving: a single missed day is skipped; only two consecutive
  missed days end the run. Also shows days completed this calendar month and a
  last-7-days dot strip.
