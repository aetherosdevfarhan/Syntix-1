const fs = require('node:fs');
const path = require('node:path');

function loadEvents(client) {
  const eventsDir = path.join(__dirname, '..', 'events');
  const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.js'));
  let loaded = 0;

  for (const file of files) {
    let event;
    try {
      event = require(path.join(eventsDir, file));
    } catch (err) {
      console.error(`[SYNTIX] Failed to load event "${file}" — skipping it so the rest of the bot still boots:`, err);
      continue;
    }
    if (!event?.name || typeof event.execute !== 'function') {
      console.warn(`[SYNTIX] Skipping invalid event file: ${file}`);
      continue;
    }
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
    loaded++;
  }
  console.log(`[SYNTIX] Loaded ${loaded} event(s).`);
}

module.exports = { loadEvents };
