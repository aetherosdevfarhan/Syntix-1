require('dotenv').config();

// Bind the health-check port FIRST, before anything else (loading discord.js, connecting to
// Discord's gateway, etc). Render (and similar hosts: Railway, Fly, etc.) watch for an open port
// right after boot to decide the deploy is healthy — if that binding happens only after slower
// startup work, the host's port scanner can time out and mark the deploy unhealthy even though
// nothing actually crashed. Binding is synchronous and near-instant, so do it before anything else.
const http = require('node:http');
const PORT = process.env.PORT || 3000;
const healthServer = http.createServer((req, res) => res.end('SYNTIX is running'));
healthServer.on('error', (err) => {
  // Without this handler, a bind failure (most commonly EADDRINUSE — something already using
  // this PORT) throws as an unhandled 'error' event, which crashes the whole process. This just
  // logs it instead, so a health-check port clash can't silently take the Discord bot down with it.
  console.error(`[SYNTIX] Dummy web server failed to start on port ${PORT}:`, err.message);
});
healthServer.listen(PORT, () => {
  console.log(`[SYNTIX] Dummy web server listening on port ${PORT} (for host health checks)`);
});

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.GuildMember]
});

loadCommands(client);
loadEvents(client);

process.on('unhandledRejection', (err) => {
  console.error('[SYNTIX] Unhandled promise rejection:', err);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[SYNTIX] DISCORD_TOKEN is missing from your .env file. The bot cannot log in without it.');
  process.exit(1);
}
// NOTE: never log the token itself (even partially) — most hosts (Railway/Render/etc.)
// keep logs around and a leaked bot token lets anyone take over the bot instantly.
client.login(token).catch((err) => {
  console.error('[SYNTIX] Failed to log in. Double-check DISCORD_TOKEN is correct and hasn\'t been regenerated:', err.message);
  process.exit(1);
});
