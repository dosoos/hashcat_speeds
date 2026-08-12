/**
 * Cloudflare Worker: receive hashcat benchmark submissions from the frontend
 * and commit them directly to the repo's benchmarks/ directory via the GitHub
 * Contents API. A push to main then triggers the existing GitHub Action that
 * regenerates pages/datas.json and the chart images.
 *
 * Required secrets (set with `wrangler secret put`):
 *   GITHUB_TOKEN    – fine-grained PAT with Contents read/write on the repo
 * Optional vars / secrets:
 *   GITHUB_OWNER    – repo owner (default: dosoos)
 *   GITHUB_REPO     – repo name  (default: hashcat_speeds)
 *   GITHUB_BRANCH   – branch     (default: main)
 *   TURNSTILE_SECRET – if set, submissions must include a valid turnstileToken
 *   ALLOWED_ORIGIN  – CORS origin (default: *, set to your pages origin)
 */

const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONTENT_BYTES = 512 * 1024; // 512 KiB
const MIN_HASH_MODES = 3;
const MIN_SPEED_LINES = 3;

const HASHMODE_RE_1 = /Hashmode:\s*(\d+)\s*-\s*(.+)/;
const HASHMODE_RE_2 = /\* Hash-Mode\s*(\d+)\s*\((.+?)\)/;
const SPEED_RE = /Speed\.(?:Dev\.#\d+|#\d+|#\*)\.*:\s*([0-9\.,]+)\s*([kMGT]?H\/s)/;

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

function sanitizeDeviceName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\.txt$/i, '');
  return DEVICE_NAME_RE.test(name) ? name : null;
}

async function verifyTurnstile(token, remoteip, env) {
  if (!env.TURNSTILE_SECRET) return true; // Turnstile not configured
  if (!token) return false;

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (remoteip) form.append('remoteip', remoteip);

  const resp = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form }
  );
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.success === true;
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
  const url = contentsUrl(env, path);
  const body = JSON.stringify({
    message,
    content: contentBase64,
    branch: env.GITHUB_BRANCH,
  });

  const resp = await fetch(url, {
    method: 'PUT',
    headers: { ...githubAuthHeaders(env), 'Content-Type': 'application/json' },
    body,
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

async function handleSubmit(request, env) {
  const origin = request.headers.get('Origin') || env.ALLOWED_ORIGIN || '*';
  const clientIp = request.headers.get('CF-Connecting-IP') || undefined;

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
  }

  const device = sanitizeDeviceName(payload.device);
  if (!device) {
    return jsonResponse(
      {
        error:
          'Invalid device name. Use 1-64 chars: letters, numbers, dots, dashes, underscores.',
      },
      400,
      origin
    );
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
        debug: check,
      },
      422,
      origin
    );
  }

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(payload.turnstileToken, clientIp, env);
    if (!ok) {
      return jsonResponse({ error: 'Captcha verification failed.' }, 403, origin);
    }
  }

  if (!env.GITHUB_TOKEN) {
    return jsonResponse(
      { error: 'Server is not configured (GITHUB_TOKEN missing).' },
      500,
      origin
    );
  }

  const filename = `${device}.txt`;
  const path = `benchmarks/${filename}`;

  try {
    const exists = await githubFileExists(env, path);
    if (exists) {
      return jsonResponse(
        {
          error: `${filename} already exists. Please choose a different device name or ask a maintainer to update it.`,
        },
        409,
        origin
      );
    }

    const author =
      typeof payload.author === 'string'
        ? payload.author.trim().slice(0, 100)
        : '';
    const coAuthor = author ? `\n\nSubmitted by: ${author}` : '';
    const message = `Add benchmark for ${device}${coAuthor}`;

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
        commit: {
          sha: result.commit?.sha,
          url: result.commit?.html_url,
        },
        content: result.content,
        note: 'Benchmark committed. The data regeneration workflow should start shortly.',
      },
      201,
      origin
    );
  } catch (err) {
    console.error('submit error:', err);
    return jsonResponse(
      { error: err.message || 'Internal error' },
      502,
      origin
    );
  }
}

function handleHealth() {
  return jsonResponse({ ok: true, service: 'hashcat-benchmark-submit' });
}

export default {
  async fetch(request, env, _ctx) {
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
      return handleSubmit(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404, request.headers.get('Origin') || '*');
  },
};
