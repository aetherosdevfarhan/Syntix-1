// Retries a Discord API call ONCE (by default) on failures that are actually worth retrying:
// network blips and Discord-side 5xx errors. Never retries permission errors (50013), "already
// gone" errors (10003 unknown channel, 10007 unknown member, 10011 unknown role), or anything
// else that will fail identically the second time — retrying those just wastes time and makes
// bulk operations feel slower for no benefit.
const RETRYABLE_NODE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
  // undici (the HTTP client discord.js's REST layer sits on) uses its own codes for the same
  // class of transient failure — a connect/header/body timeout or a socket-level error, none of
  // which are Node's classic errno strings above.
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
]);

function isRetryable(err) {
  if (!err) return false;
  // fetch/undici-style clients commonly wrap the real network error one level deep: the error
  // you catch is a generic one, and the actual ECONNRESET/timeout code lives on `err.cause.code`,
  // not `err.code` directly. Checking only the top-level `.code` (as before) silently misses
  // exactly the transient blips this function exists to retry. Check both.
  const code = err.code || err.cause?.code;
  if (RETRYABLE_NODE_CODES.has(code)) return true;
  // discord.js DiscordAPIError/HTTPError expose the HTTP status as `.status` (v14).
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return false;
}

async function withRetry(task, { retries = 1, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryable };
