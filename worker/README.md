# Hashcat Benchmark Submission Worker

A Cloudflare Worker that accepts hashcat benchmark output posted from the static
frontend page and commits it directly to this repository's `benchmarks/`
directory via the GitHub Contents API. The push to `main` then triggers the
existing `Auto Update Benchmark Data` action which regenerates
`pages/datas.json` and the chart images — no pull request required.

## Flow

```
Browser (pages/index.html)
   │  POST { device, content, author, turnstileToken }
   ▼
Cloudflare Worker  ── validates content ──►  GitHub Contents API
   │                                              │
   └──────────── commit JSON ◄────────────────────┘
                                                  ▼
                              benchmarks/<Device>.txt pushed to main
                                                  ▼
                              GitHub Action runs gendata.py
                                                  ▼
                              pages/datas.json + images/ updated
```

## API

### `POST /submit`

```json
{
  "device": "RTX4090",
  "content": "<full hashcat -b --benchmark-all output>",
  "author": "optional credit / nickname",
  "turnstileToken": "optional, required if TURNSTILE_SECRET is set"
}
```

Responses:

- `201` — committed, returns `{ success, filename, commit: { sha, url } }`
- `400` — invalid JSON or device name
- `409` — `benchmarks/<device>.txt` already exists
- `413` — content over 512 KiB
- `422` — content does not parse as a hashcat benchmark
- `403` — Turnstile verification failed
- `502` — GitHub API error

`GET /` or `/health` returns `{ ok: true }`. CORS is enabled for all origins
by default; set `ALLOWED_ORIGIN` to lock it down.

## Validation

The worker parses the pasted text with the same regexes as `gendata.py` and
requires at least 3 hash modes and 3 `Speed.#...:` lines before it will commit.
Device names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

## Deploy

1. Install dependencies:
   ```sh
   cd worker
   npm install
   ```
2. Edit `wrangler.toml` if you forked the repo (`GITHUB_OWNER`, `GITHUB_REPO`,
   `GITHUB_BRANCH`, and optionally `ALLOWED_ORIGIN`).
3. Create a GitHub fine-grained PAT for the repo with **Contents → Read and
   write** and store it as a Worker secret:
   ```sh
   npx wrangler login
   npm run secret:github
   ```
4. (Optional) Create a [Turnstile](https://www.cloudflare.com/products/turnstile/)
   widget, store the secret key:
   ```sh
   npm run secret:turnstile
   ```
   and put the site key in `SUBMIT_CONFIG.turnstileSiteKey` in
   `pages/index.html`.
5. Deploy:
   ```sh
   npm run deploy
   ```
   Wrangler prints the worker URL, e.g.
   `https://hashcat-benchmark-submit.<your-subdomain>.workers.dev`.
6. Put that URL in `SUBMIT_CONFIG.workerUrl` in `pages/index.html` and commit.

### Local development

```sh
cp .dev.vars.example .dev.vars   # fill in GITHUB_TOKEN
npm run dev                      # http://localhost:8787
```
