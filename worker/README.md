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
  "content": "<full hashcat -b --benchmark-all output>",
  "turnstileToken": "<Cloudflare Turnstile token>"
}
```

That's the whole request — no GPU model field. The worker extracts the model
from the first real device line in the output (e.g. `* Device #1: NVIDIA GeForce
RTX 4090, 20155/24563 MB, 128MCU`) and names the file
`benchmarks/<Model>_<UTC-timestamp>.txt`, e.g.
`benchmarks/NVIDIA_GeForce_RTX_4090_2026-08-12T14-30-45.123.txt`
(colons are replaced with hyphens so filenames are valid on Windows).

Responses:

- `201` — committed, returns `{ success, device, filename, path, submittedAt, commit: { sha, url } }`
- `400` — invalid JSON or empty content
- `403` — Turnstile verification failed (or token missing)
- `409` — generated filename already exists (retry)
- `413` — content over 512 KiB
- `422` — content does not parse as a hashcat benchmark, or no GPU device line found
- `500` — worker not configured (`GITHUB_TOKEN` / `TURNSTILE_SECRET` missing)
- `502` — GitHub API error

`GET /` or `/health` returns `{ ok: true }`. CORS is enabled for all origins
by default; set `ALLOWED_ORIGIN` to lock it down.

## Validation & abuse protection

- **Turnstile is mandatory.** `TURNSTILE_SECRET` must be set or the endpoint
  returns 500; every submission is verified with Cloudflare before any work
  happens. Add your Pages origin to the Turnstile widget's allowed hostnames.
- The worker parses the pasted text with the same regexes as `gendata.py` and
  requires at least 3 hash modes and 3 `Speed.#...:` lines.
- The GPU model is extracted from the benchmark output itself and sanitized to
  `[A-Za-z0-9._-]` (whitespace → `_`), so callers can't choose arbitrary paths.
- Content is capped at 512 KiB; filenames are timestamped to millisecond
  precision, so resubmissions never overwrite existing data.

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
   `https://hashcat-speeds.<your-subdomain>.workers.dev`.
6. Put that URL in `SUBMIT_CONFIG.workerUrl` in `pages/index.html` and commit.

### Local development

```sh
cp .dev.vars.example .dev.vars   # fill in GITHUB_TOKEN
npm run dev                      # http://localhost:8787
```
