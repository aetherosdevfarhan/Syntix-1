require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const commands = [];
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command?.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const route = process.env.DEV_GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.DEV_GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    console.log(`[AETHEROS] Deploying ${commands.length} slash command(s)...`);
    await rest.put(route, { body: commands });
    console.log('[AETHEROS] Slash commands deployed successfully.');
  } catch (err) {
    console.error('[AETHEROS] Failed to deploy commands:', err);
  }
})();
