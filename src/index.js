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

// Previously nothing listened for these — gateway-level failures (a rejected privileged intent,
// a dropped connection, an invalid session) fire here, not through client.login().catch(). With
// no listener, that failure reason was getting lost, which is exactly the kind of silent restart
// loop with no error text you're seeing. These make the real cause show up in logs every time.
client.on('error', (err) => {
  console.error('[SYNTIX] Discord client error:', err);
});
client.on('shardError', (err, shardId) => {
  console.error(`[SYNTIX] Shard ${shardId} error:`, err);
});
client.on('warn', (info) => {
  console.warn('[SYNTIX] Discord client warning:', info);
});
client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[SYNTIX] Shard ${shardId} disconnected (code ${event?.code}).`);
});
client.on('shardReconnecting', (shardId) => {
  console.warn(`[SYNTIX] Shard ${shardId} reconnecting...`);
});

process.on('unhandledRejection', (err) => {
  console.error('[SYNTIX] Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  // Log fully before the process dies instead of an ambiguous exit with no explanation.
  console.error('[SYNTIX] Uncaught exception:', err);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[SYNTIX] DISCORD_TOKEN is missing from your environment. On Render this must be set under Settings -> Environment -- a local .env file is NOT read on Render. The bot cannot log in without it.');
  process.exit(1);
}
console.log('[SYNTIX] Attempting to log in to Discord...');
// NOTE: never log the token itself (even partially) — most hosts (Railway/Render/etc.)
// keep logs around and a leaked bot token lets anyone take over the bot instantly.
client.login(token).catch((err) => {
  console.error('[SYNTIX] Failed to log in. Common causes: wrong/regenerated DISCORD_TOKEN, or a privileged intent (Server Members / Message Content) not enabled in the Discord Developer Portal under Bot -> Privileged Gateway Intents. Actual error:', err);
  process.exit(1);
});

// If login() resolves but the 'ready' event never fires within a reasonable window, something
// is stuck (rare, but happens on flaky connections) — surface that instead of looking hung forever.
const readyWatchdog = setTimeout(() => {
  if (!client.isReady()) {
    console.warn('[SYNTIX] Still not ready 30s after login — connection may be stuck. Check network/firewall on this host.');
  }
}, 30_000);
readyWatchdog.unref();
