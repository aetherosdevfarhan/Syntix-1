function normalize(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:~*_`]+$/g, '')
    .replace(/\s+/g, ' ');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchAutoResponse(config, guildId, userId, content) {
  if (!config?.autoresponder?.enabled) return null;
  const normalized = normalize(content);
  if (!normalized) return null;

  for (const trigger of config.autoresponder.triggers || []) {
    for (const phrase of trigger.match || []) {
      if (!phrase) continue;
      const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
      if (re.test(normalized)) return trigger.response;
    }
  }
  return null;
}

const CUSTOM_EMOJI_RE = /<a?:\w{2,32}:\d+>/g;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/gu;

function findAutoReactEmojis(config, content) {
  if (!config?.autoreact?.enabled || !content) return [];
  const found = new Set();

  for (const m of content.match(CUSTOM_EMOJI_RE) || []) found.add(m);
  for (const m of content.match(UNICODE_EMOJI_RE) || []) found.add(m);

  // Keep this small — reacting with every emoji in a long message looks spammy
  // and Discord caps unique reactions per message at 20 anyway.
  return [...found].slice(0, 5);
}

module.exports = { normalize, matchAutoResponse, findAutoReactEmojis };
