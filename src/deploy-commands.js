require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const commands = [];
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  let command;
  try {
    command = require(path.join(commandsDir, file));
  } catch (err) {
    // A single broken command file (e.g. a missing/native dependency like @discordjs/voice or
    // play-dl failing to install on this host) used to crash this whole script before it ever
    // reached the try/catch below. Since `npm start` runs this with `&&` before src/index.js,
    // that crash silently prevented the bot — and its dummy HTTP server — from starting at all.
    console.error(`[SYNTIX] Failed to load command "${file}" — skipping it for deploy:`, err.message);
    continue;
  }
  if (command?.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const route = process.env.DEV_GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.DEV_GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    console.log(`[SYNTIX] Deploying ${commands.length} slash command(s)...`);
    await rest.put(route, { body: commands });
    console.log('[SYNTIX] Slash commands deployed successfully.');
  } catch (err) {
    console.error('[SYNTIX] Failed to deploy commands:', err);
  }
})();
