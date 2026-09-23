# TypeStat

Counts how much you type each day — **including the characters you typed and then deleted**.

A Windows desktop app. A global keyboard hook counts keystrokes; editor plug-ins report exact character counts. Everything stays on your machine.

[中文](README.md)

---

## What it answers

Most typing trackers only count what survives in the document. But a real chunk of the
work is revising: type it, look at it, delete it, type it again. That part is invisible
everywhere else.

TypeStat counts both ends:

- **Insertions** count, and so do **deletions**. `net = inserted − deleted`.
- Backspace rate, time at the desk, minutes actually spent typing, hourly distribution,
  and per-app totals all come out of the same records.
- Every number on every page is computed by the backend; the UI only draws it.

## Two metrics that must not be mixed up

This is the first thing to get straight.

|  | Keystrokes | Characters |
|---|---|---|
| Source | global low-level hook (`WH_KEYBOARD_LL`) | reported by editor plug-ins |
| Coverage | every app, out of the box | only apps with an adapter |
| Means | how many keys were pressed | how many characters entered the document (deletions counted separately) |

**They are not convertible.** Typing "你好" on a pinyin IME may be five keystrokes
(one per letter) or one keystroke (commit the whole phrase). The hook cannot tell these
apart; only the editor knows how many characters its document actually gained. So on an
app with no adapter the character row shows **"not measurable", not 0** — those two
numbers never share an axis in this program.

## Privacy

- **No input content is recorded.** The database holds "which physical key, which day,
  how many times" (`vk_code` / `scan_code` / count). No ordering, no text, no window titles.
- **Adapters report two integers.** The payload is `{app, input, delete}` — an app name
  and two numbers. On the WPS side, what is read is the document's character count (the
  delta of `doc.Characters.Count`); the fallback path measures the **length** of
  `Range.Text` and drops it immediately. Never stored, never sent, never written to disk.
- **Data stays local**: `%APPDATA%\com.typestat.app\typestat.db`.
- **The only outbound traffic** is the "Summary" page, which sends **numbers and app
  names** to an OpenAI-compatible endpoint (DeepSeek by default) to have them written up
  as prose. It works without one — it falls back to a local template. Which provider, and
  whether to send at all, is your call.
- The API key is encrypted with Windows DPAPI before being stored in that same database.
  Signing in as a different Windows account, or copying the database to another machine,
  makes it undecryptable.

## The eleven pages

| Page | What it shows |
|---|---|
| Today | today's ledger: keystrokes, backspaces, net characters, desk time, speed |
| Hours | keystrokes hour by hour |
| Duration | desk time and minutes actually spent typing, per day |
| Trends | keystrokes and characters over the last 7 / 30 / 90 days |
| Heat | density grid of day × hour |
| Keys | keyboard heatmap, most-pressed keys; 1 / 7 / 30 / 90 day ranges |
| Apps | how much went into each app, with character coverage |
| Detail | per-app ledger: keystrokes and characters side by side, with their differing coverage made visible |
| Summary | reads one period (week / month) as a paragraph; archived and re-readable |
| Adapter | plug-in reporting channel: port, token, last report received |
| Settings | capture status, manual hook rebuild, known limits, database location |

## Install

Download an installer (`.msi` or `.exe`) from [Releases](../../releases).

Requires Windows 10/11 and the WebView2 runtime (bundled with Windows 11).

## Build from source

Requires Node 18+, stable Rust (MSVC toolchain).

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # build installers
```

The bundlers (WiX, NSIS) are downloaded by the Tauri CLI on first build; this fails
without network access. In that case, build the executable only:

```bash
npm run tauri build -- --no-bundle
```

Run the tests:

```bash
cd src-tauri && cargo test    # Rust
cd .. && npm run build        # frontend (includes tsc --noEmit)
```

## Adapters (optional)

Exact character counts can only come from the app itself. Two adapters exist today.
Neither is required — without them, character counts are simply not measurable.

### WPS Writer

Open the **Adapters** page in TypeStat and press "Install into WPS". The app carries the
add-in files inside its own binary (no Node, no hunting for directories) and fills in the
port and token itself, since it is the one that generated them. **WPS must be fully
restarted afterwards** — add-ins load once, at startup.

To install by hand, or onto another machine, "Save plug-in files" on the same page writes
both plug-ins into one folder. Details in [`wps-addon/README.md`](wps-addon/README.md)
(Chinese).

### Obsidian

Copy `main.js` and `manifest.json` from `obsidian-plugin/` into

```
<your vault>/.obsidian/plugins/typestat/
```

Enable it under community plug-ins, then enter the port and token in the plug-in
settings — both are shown on TypeStat's "Adapter" page.

### The receiver

Both adapters POST `{app, input, delete}` with an `X-TypeStat-Token` header to
`http://127.0.0.1:<port>/report`. The port is the first free one in 42180–42189; the
token is regenerated at random on every launch.

The receiver binds to loopback only and **validates the token on every request** — that
is the entire defense. CORS is `*`, because the add-in page runs from a `file://` origin,
and pinning Origin would not stop a real attacker (a non-browser client can write any
Origin it likes) while it would lock the plug-ins out. **No endpoint returns 200 without
a token**, deliberately: otherwise any web page could `fetch` it to confirm TypeStat is
installed on this machine.

## Known limits

Not bugs — Windows' rules. Listed so you do not think something was missed.

- **Input in elevated windows is not captured.** Without elevation, UIPI stops the hook
  from receiving input destined for higher-integrity processes (Task Manager, anything
  run as administrator). Running TypeStat as administrator covers them.
- **Some games and security software block hooks.** Anti-cheat, DRM players and banking
  controls intercept global keyboard hooks by design; there is no way around it.
- **Windows silently removes hooks.** After ten callback timeouts the hook is unhooked
  with no notification API whatsoever. A watchdog cross-checks every 60 seconds and
  rebuilds automatically; the settings page also has a manual rebuild button as a fallback.
- **"Not measurable" is not 0.** An app with no adapter has no character count, and the
  UI says so.

## Repository layout

```
src/                    React frontend (no router; pages dispatched by hand)
  pages/                the eleven pages
  components/           LinePlot, KeyboardHeatmap
  dev/mockBackend.ts    fake backend for browsing the UI via app-preview.html
src-tauri/              Rust backend
  hook/                 global hooks (keyboard, mouse, watchdog)
  collector/            event classification, auto-repeat filtering, foreground app attribution
  db/                   SQLite (WAL), schema and migrations
  adapters/ipc.rs       local receiver (axum)
  report/               "Summary": period arithmetic, sheet rendering, model call, DPAPI key
wps-addon/              WPS Writer add-in (JS)
obsidian-plugin/        Obsidian plug-in
design-demos/           early design directions (static HTML, unrelated to the shipped UI)
```

Data flow is strictly one-way: the hook callback only reads struct fields and enqueues —
it never queries UI Automation or writes to the database (a low-level hook callback must
return within 300 ms or the system drops the hook). Classification and persistence happen
on the collector thread, batched by the minute.

## License

[MIT](LICENSE)
