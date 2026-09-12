// Retries a Discord API call ONCE (by default) on failures that are actually worth retrying:
// network blips and Discord-side 5xx errors. Never retries permission errors (50013), "already
// gone" errors (10003 unknown channel, 10007 unknown member, 10011 unknown role), or anything
// else that will fail identically the second time — retrying those just wastes time and makes
// bulk operations feel slower for no benefit.
const RETRYABLE_NODE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN']);

function isRetryable(err) {
  if (!err) return false;
  if (RETRYABLE_NODE_CODES.has(err.code)) return true;
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
