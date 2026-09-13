
const { Events, ActivityType } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`[SYNTIX] Logged in as ${client.user.tag} — serving ${client.guilds.cache.size} server(s).`);
    client.user.setPresence({
      activities: [{ name: 'over your server', type: ActivityType.Watching }],
      status: 'online'
    });
  }
};
