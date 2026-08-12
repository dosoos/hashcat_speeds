/**
 * Cloudflare Worker: receive hashcat benchmark submissions from the frontend
 * and commit them directly to the repo's benchmarks/ directory via the GitHub
 * Contents API. A push to main then triggers the existing GitHub Action that
 * regenerates pages/datas.json and the chart images.
 *
 * The request body only needs { content } — the GPU model is extracted from the
 * benchmark output itself and the file is auto-named:
 *   benchmarks/<Model>_YYYY-MM-DDTHH-MM-SS.sssZ.txt
 *
 * Required secrets (set with `wrangler secret put`):
 *   GITHUB_TOKEN      – fine-grained PAT with Contents read/write on the repo
 *   TURNSTILE_SECRET  – Cloudflare Turnstile secret key (mandatory)
 * Optional vars:
 *   GITHUB_OWNER   (default: dosoos)
 *   GITHUB_REPO    (default: hashcat_speeds)
 *   GITHUB_BRANCH  (default: main)
 *   ALLOWED_ORIGIN (CORS origin; default: *)
 */

const MAX_CONTENT_BYTES = 512 * 1024; // 512 KiB
const MIN_HASH_MODES = 3;
const MIN_SPEED_LINES = 3;
const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const HASHMODE_RE_1 = /Hashmode:\s*(\d+)\s*-\s*(.+)/;
const HASHMODE_RE_2 = /\* Hash-Mode\s*(\d+)\s*\((.+?)\)/;
const SPEED_RE = /Speed\.(?:Dev\.#\d+|#\d+|#\*)\.*:\s*([0-9\.,]+)\s*([kMGT]?H\/s)/;

// Matches the first real (non-skipped, non-warning) compute device, e.g.
//   * Device #1: NVIDIA GeForce RTX 4090, 20155/24563 MB, 128MCU
//   * Device #01: NVIDIA P102-100, 10015/10144 MB, 25MCU
//   * Device #1: Tesla V100-SXM2-16GB, 15834/16144 MB, 80MCU
const DEVICE_RE = /^\*\s*Device\s*#\d+:\s*(.+?),\s*\d+\s*\/\s*\d+\s*MB/m;

function jsonResponse(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Validate that the pasted text really is a hashcat benchmark dump.
 * Mirrors the parsing in gendata.py.
 */
function validateBenchmark(content) {
  const modes = new Set();
  let speedLines = 0;
  let currentMode = null;

  for (const line of content.split(/\r?\n/)) {
    const m1 = line.match(HASHMODE_RE_1);
    const m2 = m1 ? null : line.match(HASHMODE_RE_2);
    if (m1 || m2) {
      currentMode = (m1 || m2)[1];
      modes.add(currentMode);
    } else if (currentMode && SPEED_RE.test(line)) {
      speedLines++;
    }
  }

  return {
    modes: modes.size,
    speedLines,
    valid: modes.size >= MIN_HASH_MODES && speedLines >= MIN_SPEED_LINES,
  };
}

/**
 * Pull the GPU model string out of the benchmark output and turn it into a
 * filesystem-safe slug. Examples:
 *   "NVIDIA GeForce RTX 4090" -> "NVIDIA_GeForce_RTX_4090"
 *   "Tesla V100-SXM2-16GB"     -> "Tesla_V100-SXM2-16GB"
 */
function extractDeviceName(content) {
  const m = content.match(DEVICE_RE);
  if (!m) return null;
  const raw = m[1].trim();
  // Replace whitespace runs with underscore; drop anything that isn't a
  // letter, number, dot, dash, or underscore; collapse repeated separators.
  const slug = raw
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return slug.length >= 2 && slug.length <= 80 ? slug : null;
}

/**
 * Timestamp like 2026-08-12T14-30-45.123 — the date/time portion of an ISO 8601
 * UTC string (trailing Z stripped), with colons replaced by hyphens so the
 * result is a valid filename on Windows (where ':' is reserved).
 */
function timestampForFilename(date) {
  return date.toISOString().replace(/Z$/, '').replace(/:/g, '-'); // 2026-08-12T14-30-45.123
}

async function verifyTurnstile(token, remoteip, env) {
  if (!token) return false;

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (remoteip) form.append('remoteip', remoteip);

  const resp = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
  if (!resp.ok) return false;
  const data = await resp.json().catch(() => ({}));
  if (data.success !== true) {
    console.log('turnstile failure:', data['error-codes']);
    return false;
  }
  return true;
}

function githubAuthHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hashcat-benchmark-worker',
  };
}

function contentsUrl(env, path) {
  // Encode each path segment separately so slashes stay literal.
  const safePath = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${safePath}`;
}

async function githubFileExists(env, path) {
  const url = `${contentsUrl(env, path)}?ref=${env.GITHUB_BRANCH}`;
  const resp = await fetch(url, { headers: githubAuthHeaders(env) });
  if (resp.status === 200) return true;
  if (resp.status === 404) return false;
  const text = await resp.text();
  throw new Error(`GitHub lookup failed (${resp.status}): ${text}`);
}

async function githubCommitFile(env, path, contentBase64, message) {
  const resp = await fetch(contentsUrl(env, path), {
    method: 'PUT',
    headers: { ...githubAuthHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: contentBase64,
      branch: env.GITHUB_BRANCH,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `GitHub commit failed (${resp.status}): ${data.message || JSON.stringify(data)}`
    );
  }
  return data;
}

function base64Encode(str) {
  // Worker has btoa; encode to UTF-8 bytes first to support non-ASCII.
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function handleSubmit(request, env, ctx) {
  const origin = request.headers.get('Origin') || env.ALLOWED_ORIGIN || '*';
  const clientIp = request.headers.get('CF-Connecting-IP') || undefined;

  if (!env.TURNSTILE_SECRET) {
    return jsonResponse(
      { error: 'Server is not configured (TURNSTILE_SECRET missing).' },
      500,
      origin
    );
  }
  if (!env.GITHUB_TOKEN) {
    return jsonResponse(
      { error: 'Server is not configured (GITHUB_TOKEN missing).' },
      500,
      origin
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400, origin);
  }

  // Verify Turnstile first, before doing any real work.
  const turnstileOk = await verifyTurnstile(
    payload.turnstileToken,
    clientIp,
    env
  );
  if (!turnstileOk) {
    return jsonResponse({ error: 'Captcha verification failed.' }, 403, origin);
  }

  const content = typeof payload.content === 'string' ? payload.content : '';
  const byteLen = new TextEncoder().encode(content).length;
  if (byteLen === 0) {
    return jsonResponse({ error: 'Benchmark content is empty.' }, 400, origin);
  }
  if (byteLen > MAX_CONTENT_BYTES) {
    return jsonResponse(
      { error: `Benchmark content too large (max ${MAX_CONTENT_BYTES} bytes).` },
      413,
      origin
    );
  }

  const check = validateBenchmark(content);
  if (!check.valid) {
    return jsonResponse(
      {
        error: `Content does not look like a hashcat benchmark (found ${check.modes} hash modes, ${check.speedLines} speed lines). Run "hashcat -b --benchmark-all" and paste the full output.`,
      },
      422,
      origin
    );
  }

  const device = extractDeviceName(content);
  if (!device) {
    return jsonResponse(
      {
        error:
          'Could not detect a GPU device line in the output. Expected a line like "* Device #1: NVIDIA GeForce RTX 4090, 20155/24563 MB, 128MCU".',
      },
      422,
      origin
    );
  }

  // Timestamp comes from the CF edge so it is consistent and not client-controlled.
  // new Date() is available on Workers; the no-Date.now restriction only applies to
  // workflow scripts.
  const now = new Date(request.headers.get('CF-Date') || Date.now());
  const filename = `${device}_${timestampForFilename(now)}.txt`;
  const path = `benchmarks/${filename}`;

  try {
    const exists = await githubFileExists(env, path);
    if (exists) {
      // Extremely unlikely with millisecond timestamps; retry once with a suffix.
      return jsonResponse(
        { error: `${filename} already exists; please retry.` },
        409,
        origin
      );
    }

    const message = `Add benchmark for ${device}`;
    const result = await githubCommitFile(
      env,
      path,
      base64Encode(content),
      message
    );

    return jsonResponse(
      {
        success: true,
        device,
        filename,
        path,
        submittedAt: now.toISOString(),
        commit: {
          sha: result.commit?.sha,
          url: result.commit?.html_url,
        },
        note: 'Benchmark committed. The data regeneration workflow should start shortly.',
      },
      201,
      origin
    );
  } catch (err) {
    console.error('submit error:', err);
    return jsonResponse({ error: err.message || 'Internal error' }, 502, origin);
  }
}

function handleHealth() {
  return jsonResponse({ ok: true, service: 'hashcat-benchmark-submit' });
}

export default {
  async fetch(request, env, ctx) {
    env.GITHUB_OWNER = env.GITHUB_OWNER || 'dosoos';
    env.GITHUB_REPO = env.GITHUB_REPO || 'hashcat_speeds';
    env.GITHUB_BRANCH = env.GITHUB_BRANCH || 'main';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get('Origin') || env.ALLOWED_ORIGIN),
      });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return handleHealth();
    }

    if (request.method === 'POST' && url.pathname === '/submit') {
      return handleSubmit(request, env, ctx);
    }

    return jsonResponse({ error: 'Not found' }, 404, request.headers.get('Origin') || '*');
  },
};
