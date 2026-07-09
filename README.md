# activelog

Landing page for **activelog.ai** — a Cloudflare Worker that serves a single
static HTML page introducing *ActiveLog*, a proposed JSON event-log envelope
convention.

This repo is part of the PurplePincher / SuperInstance domain family. Two of
its siblings — [`activeledger`](https://github.com/purplepincher/activeledger)
and [`luciddreamer`](https://github.com/purplepincher/luciddreamer) — share the
exact same Worker + design-system skeleton, differing only in the page they
serve and the Worker name.

> **Read this first:** the repository you are holding contains **no
> implementation** of the ActiveLog envelope. It is a one-page marketing /
> explainer site. What the underlying installable package actually is, and where
> the page's claims do and do not line up with code, is spelled out in
> [docs/product-status.md](docs/product-status.md). The short version is in the
> [Honesty / status](#honesty--status) section below.

---

## What is actually in this repo

A Cloudflare Worker whose entire job is to serve a static asset directory. There
is no application logic, no server-side processing, and no build step beyond
what Wrangler does natively.

```
activelog/
├── src/index.ts        # 13-line request handler: env.ASSETS.fetch(request) + 404/500
├── public/index.html   # the page that gets served (ActiveLog explainer)
├── family/             # shared PurplePincher design-system skeleton (see below)
│   ├── README.md          # operator's manual for the design system
│   ├── tokens.css         # :root palette + type scale (inlined into the page)
│   ├── base.css           # reset + component classes (.eyebrow, .chain, .ledger, …)
│   ├── provenance-panel.css
│   └── provenance-panel.html
└── wrangler.jsonc      # name="activelog", assets dir ./public, binding ASSETS
```

`src/index.ts` is byte-for-byte identical to the handler in `activeledger` and
`luciddreamer`:

```ts
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const response = await env.ASSETS.fetch(request);
      if (!response) return new Response("Not found", { status: 404 });
      return response;
    } catch (e) {
      return new Response(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`, { status: 500 });
    }
  },
};
```

Every request is handed to the Workers [static assets](https://developers.cloudflare.com/workers/static-assets/)
binding (`env.ASSETS`). If no file matches, the Worker returns `404`; on an
exception it returns `500`. That is the whole runtime behavior.

### The `family/` design system

`family/` is the shared PurplePincher design skeleton, documented in
[`family/README.md`](family/README.md). Its architecture is a deliberate
**inline-at-build-time, never-fetch-at-runtime** rule: `tokens.css` and
`base.css` are copied into the page's `<style>` block (which is why
`public/index.html` is self-contained and makes no runtime CSS requests).

Two notes a reader should be aware of:

- The page does **not** perform the per-site accent swap described in
  `family/README.md`. It leaves `--claw` at the default aubergine, so this site
  currently renders in the reference palette rather than a dedicated activelog
  accent.
- The `provenance-panel.*` honesty component ships in `family/` but is **not**
  used by this page. The page has its own inline "Honesty note" instead.

---

## Run it

No `package.json`, no dependencies to install — Wrangler talks to the TypeScript
entry directly. Wrangler 4.x is what this was authored against.

```bash
# local dev server (serves public/index.html)
wrangler dev

# validate config + bundle without deploying
wrangler deploy --dry-run

# deploy to Cloudflare (requires you to be authenticated to the activelog account)
wrangler deploy
```

`wrangler deploy --dry-run` was verified against this repo: it reads the
`./public` assets directory, bundles the Worker, and reports the `env.ASSETS`
binding.

---

## Honesty / status

Using the family's honesty-marker convention:

- ✅ **real today** — the static landing page renders; the Worker serves it via
  `env.ASSETS`; the `family/` design-system assets are present and inlined.
- ⚠️ **real but conditional** — the *ActiveLog envelope convention* the page
  describes (`alv`, `dev`, `seq`, `ts`, `mono`, `type`, `body`) is a **design
  documented on the page, not code in this repo**. The only installable
  artifact published under this name is the PyPI package `activelog-agent` (by
  the same org's `superinstance` publisher), and **it is a different product**:
  a wearable-fitness "Fitness Guardian" agent (`ActiveLogAgent` with
  `log_hrv` / `log_sleep` / `log_activity` / `log_recovery`), not an event-log
  envelope. Its current `0.2.0` release also fails to `import` with a
  `SyntaxError` (see [docs/product-status.md](docs/product-status.md)).
- 🔮 **later phase / not done** — no envelope schema, encoder, or decoder exists
  in this repo; no tests, no CI, no `package.json`; the page's claim that the
  envelope "powers DeckBoss's real, shipped logbook" refers to a **different**
  repo and cannot be verified from here.

> ⚠️ **Do not `pip install activelog`.** The bare name `activelog` on PyPI is an
> **unrelated** third-party logging utility (by a different author, last
> released 2020). It has nothing to do with this project.

---

## Related

- `docs/product-status.md` — the verified reality of `activelog-agent` on PyPI
  versus what this landing page claims.
- [`family/README.md`](family/README.md) — the design-system operator's manual.
- Sibling landing repos: [`activeledger`](https://github.com/purplepincher/activeledger),
  [`luciddreamer`](https://github.com/purplepincher/luciddreamer).
