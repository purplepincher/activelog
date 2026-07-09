# Product status: activelog-agent vs. the activelog.ai landing page

This document records what the installable `activelog-agent` package **actually
is**, verified directly from its published wheel, and where that does and does
not match the story told by `public/index.html`. It exists so reviewers and
readers don't have to re-derive it.

It is **not** a feature list. Several things the landing page implies are not
real; those are called out explicitly below.

## TL;DR

| claim / artifact | status |
|---|---|
| `activelog.ai` landing page renders and is served by a Worker | ✅ real |
| "ActiveLog" = a JSON event-log envelope (`alv`/`dev`/`seq`/`ts`/`mono`/`type`/`body`) | ⚠️ a design described on the page; **no code for it exists in this repo** |
| An installable package backs activelog.ai | ✅ `activelog-agent` on PyPI is real and published by the org |
| …and that package implements the envelope above | ❌ **no** — it is a wearable-fitness agent (see below) |
| `activelog-agent` 0.2.0 can be imported today | ❌ **no** — `SyntaxError` on import |
| `pip install activelog` installs this project | ❌ **no** — that name is an unrelated third-party package |

## What the landing page says

`public/index.html` describes ActiveLog as "the JSON envelope convention that
powers real event logging across this product family," with a fixed seven-field
shape, and claims it "already powers DeckBoss's real, shipped logbook." The page
shows this envelope as its quick-start:

```json
{ "alv": 1, "dev": "abc123", "seq": 42, "ts": "2025-02-14T12:00:00Z",
  "mono": 1234567890, "type": "temperature_read",
  "body": { "sensor": "cabin", "value": 22.5 } }
```

## What `activelog-agent` on PyPI actually is

`activelog-agent` (PyPI, published by `superinstance`; project
`github.com/SuperInstance/activelog-agent`) is version `0.2.0`. Its own summary
line reads:

> Fitness Guardian for activelog.ai — wearable health → PLATO → wellness insights

Inspecting the published wheel (`activelog_agent/__init__.py`) confirms this. It
exports a single class, `ActiveLogAgent`, whose public methods are:

- `log_hrv(heart_rate, hrv_ms, source="watch")`
- `log_sleep(hours, quality, source="watch")`
- `log_activity(steps, active_minutes, source="watch")`
- `log_recovery(score)`
- `ask(question)` — reads recent tiles from a PLATO server and returns a string
- `detect_emergence(events)`, `check_consensus(tile_ids)` — thin wrappers over
  `fleet_agent.fleet_math`

Each `log_*` method POSTs a "tile" to a PLATO room at
`http://localhost:8847/room/activelog-ai`. **This is a fitness/wellness agent
that writes to a PLATO memory server — not an event-log envelope encoder.** It
shares a name with the page's "ActiveLog" concept but is otherwise a different
product.

## Current 0.2.0 release is not importable

The published `0.2.0` wheel has a malformed `__init__.py`. A module-level
`def __init__(self, …)` (mis-indented out of the class) is followed by further
mis-indented methods, so Python rejects the file before any code runs:

```
activelog-agent: SYNTAX ERROR -> line 53:
  unindent does not match any outer indentation level
  offending: '    def _write(self, metric_type: str, value: float, metadata: dict) -> bool:\n'
```

In practice: `pip install activelog-agent==0.2.0` succeeds, but
`import activelog_agent` raises `SyntaxError`. Even setting the parse bug aside,
the agent is only functional with a PLATO server reachable at
`http://localhost:8847` (it `import`s `fleet_agent` and `requests`).

## The bare `activelog` name is someone else's package

`pip install activelog` installs an **unrelated** generic logging utility
(PyPI `activelog`, author Tatsuya Abe / AjxLab, last released 2020,
`github.com/AjxLab/ActiveLog`). It has nothing to do with this project; do not
use it as a stand-in.

## What this repo would need to make the page's story true

To close the gap between the landing page and something verifiable from this
repo, the work would be at minimum:

1. An actual schema/spec for the seven-field envelope (none is present).
2. A reference encoder/decoder in any language, with tests.
3. A traceable link to where DeckBoss consumes it (the "powers DeckBoss's
   shipped logbook" claim is external to this repo and unverified here).

Until then, the page is best read as a **proposal for a convention**, not as
documentation of shipped code in this repository.
