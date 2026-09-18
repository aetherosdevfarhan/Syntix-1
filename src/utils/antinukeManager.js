const { AuditLogEvent, PermissionsBitField, EmbedBuilder, ActionRowBuilder, UserSelectMenuBuilder } = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');
const { sendLog } = require('./logger');
const { withRetry } = require('./retry');

const WHITELIST_SELECT_ID = 'aeth_wl_select';
// Discord's own hard cap on how many values a select menu can hold/return in one interaction.
const WHITELIST_PANEL_MAX = 25;

// Builds the embed + select menu for the interactive whitelist panel (&wl with no arguments).
// The select menu is pre-ticked with everyone currently whitelisted (via setDefaultUsers) —
// ticking someone new adds them, unticking someone removes them, all in one submit. Shared
// between messageCreate.js (first render) and interactionCreate.js (re-render after a change)
// so the two never drift out of sync with each other.
function buildWhitelistPanel(config) {
  const ids = config.antinuke.whitelist;
  const shown = ids.slice(0, WHITELIST_PANEL_MAX);
  const overflowCount = ids.length - shown.length;

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Anti-Nuke Whitelist')
    .setColor(0x5865F2)
    .setDescription(
      `Tick someone to **whitelist** them, untick someone to **remove** them — changes save as soon as you pick.\n\n` +
      `Currently whitelisted: **${ids.length}**` +
      (overflowCount > 0
        ? `\n⚠️ Only the first ${WHITELIST_PANEL_MAX} are shown/editable here (Discord's limit per menu). ` +
          `${overflowCount} more exist beyond that — manage those with \`&wl remove @user\`.`
        : '')
    )
    .setFooter({ text: "The server owner is always immune and doesn't need to be added." });

  const select = new UserSelectMenuBuilder()
    .setCustomId(WHITELIST_SELECT_ID)
    .setPlaceholder('Select whitelisted members...')
    .setMinValues(0)
    .setMaxValues(WHITELIST_PANEL_MAX);

  if (shown.length) select.setDefaultUsers(shown);

  const row = new ActionRowBuilder().addComponents(select);
  return { embed, row };
}

const activity = new Map();
const punishedRecently = new Map();
// Guilds currently running a bot-initiated bulk operation (nuke wipe, &createchannels, etc).
// While a guild is in here, guard()/guardMessage() bail out instantly instead of doing an
// audit-log fetch per event. Without this, every single ban/channel-create fired during a bulk
// op triggers its own fetchAuditLogs() call, which (a) tanks the speed of the operation and
// (b) can trip the antinuke thresholds and get the admin who ran the command punished by their
// own bot mid-operation.
//
// Stores guildId -> expiry timestamp instead of just membership. This is a safety net: if
// whatever started the suppressed operation throws before it reaches its own cleanup code
// (e.g. an unhandled error partway through a wipe), the guild used to stay suppressed forever —
// anti-nuke silently stopped protecting channelDelete/ban/etc. for that server until the bot
// process restarted, with no error shown anywhere. An expiry means a bug like that degrades to
// "protection paused for a few minutes," not "protection silently disabled indefinitely."
const suppressedGuilds = new Map();
const DEFAULT_SUPPRESSION_MS = 10 * 60 * 1000; // 10 minutes — generous for even a huge server wipe

function beginSuppressedOperation(guildId, maxDurationMs = DEFAULT_SUPPRESSION_MS) {
  suppressedGuilds.set(guildId, Date.now() + maxDurationMs);
}

function endSuppressedOperation(guildId) {
  suppressedGuilds.delete(guildId);
}

function isSuppressed(guildId) {
  const expiresAt = suppressedGuilds.get(guildId);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    // Expired safety net — clear it so we don't keep checking a stale entry.
    suppressedGuilds.delete(guildId);
    return false;
  }
  return true;
}

const DANGEROUS_PERMS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers
];

function isImmune(guild, config, member) {
  if (!member) return true;
  if (member.id === guild.ownerId) return true;
  if (member.id === guild.client.user.id) return true;
  if (config.antinuke.whitelist.includes(member.id)) return true;
  if (config.antinuke.trustedRoleId && member.roles?.cache?.has(config.antinuke.trustedRoleId)) return true;
  return false;
}

async function resolveExecutor(guild, auditLogEvent, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditLogEvent, limit: 5 });
    const entry = logs.entries.find(e => {
      const recent = Date.now() - e.createdTimestamp < 15_000;
      const matches = targetId ? e.target?.id === targetId : true;
      return recent && matches;
    }) || logs.entries.first();
    if (!entry) return null;
    return { executorId: entry.executor?.id, entry };
  } catch {
    return null;
  }
}

function recordAndCheck(guildId, executorId, actionType, threshold) {
  if (!activity.has(guildId)) activity.set(guildId, new Map());
  const guildMap = activity.get(guildId);
  if (!guildMap.has(executorId)) guildMap.set(executorId, new Map());
  const userMap = guildMap.get(executorId);
  if (!userMap.has(actionType)) userMap.set(actionType, []);

  const now = Date.now();
  const windowMs = threshold.seconds * 1000;
  const timestamps = userMap.get(actionType).filter(t => now - t < windowMs);
  timestamps.push(now);
  userMap.set(actionType, timestamps);

  return timestamps.length >= threshold.count;
}

async function punish(guild, config, executorId, reason) {
  const key = `${guild.id}:${executorId}`;
  const until = punishedRecently.get(key);
  if (until && until > Date.now()) return;
  punishedRecently.set(key, Date.now() + 30_000);

  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return;
  if (isImmune(guild, config, member)) return;

  const actionsTaken = [];

  try {
    if (config.antinuke.punishment === 'strip_ban' || config.antinuke.punishment === 'strip_only') {
      const removable = member.roles.cache.filter(r => r.id !== guild.id && r.editable);
      if (removable.size) {
        await withRetry(() => member.roles.remove(removable, `AETHEROS Anti-Nuke: ${reason}`));
        actionsTaken.push('roles stripped');
      }
    }
  } catch { /* ignore */ }

  try {
    if (config.antinuke.punishment === 'strip_ban') {
      if (member.bannable) {
        await withRetry(() => member.ban({ reason: `AETHEROS Anti-Nuke: ${reason}` }));
        actionsTaken.push('banned');
      }
    } else if (config.antinuke.punishment === 'strip_kick') {
      if (member.kickable) {
        await withRetry(() => member.kick(`AETHEROS Anti-Nuke: ${reason}`));
        actionsTaken.push('kicked');
      }
    }
  } catch { /* ignore */ }

  await sendLog(guild, config, {
    title: '🛡️ Threat neutralized',
    description: `<@${executorId}> (\`${executorId}\`) triggered anti-nuke protection.`,
    color: 'danger',
    fields: [
      { name: 'Reason', value: reason, inline: false },
      { name: 'Actions taken', value: actionsTaken.length ? actionsTaken.join(', ') : 'none (missing permissions)', inline: false }
    ]
  });
}

async function guard(guild, actionKey, auditLogEvent, targetId, extraReason) {
  if (isSuppressed(guild.id)) return;
  const config = getGuild(guild.id);
  if (!config.antinuke.enabled) return;
  const threshold = config.antinuke.thresholds[actionKey];
  if (!threshold) return;

  const resolved = await resolveExecutor(guild, auditLogEvent, targetId);
  if (!resolved?.executorId) return;

  const member = await guild.members.fetch(resolved.executorId).catch(() => null);
  if (isImmune(guild, config, member)) return;

  const exceeded = recordAndCheck(guild.id, resolved.executorId, actionKey, threshold);
  if (exceeded) {
    await punish(guild, config, resolved.executorId, extraReason || `Exceeded ${actionKey} rate limit`);
  }
}

async function guardInstant(guild, executorId, reason) {
  if (isSuppressed(guild.id)) return;
  const config = getGuild(guild.id);
  if (!config.antinuke.enabled) return;
  await punish(guild, config, executorId, reason);
}

async function guardMessage(guild, member, actionKey, reason) {
  if (isSuppressed(guild.id)) return;
  const config = getGuild(guild.id);
  if (!config.antinuke.enabled) return;
  const threshold = config.antinuke.thresholds[actionKey];
  if (!threshold) return;
  if (isImmune(guild, config, member)) return;

  const exceeded = recordAndCheck(guild.id, member.id, actionKey, threshold);
  if (exceeded) {
    await punish(guild, config, member.id, reason);
  }
}

module.exports = {
  guard,
  guardInstant,
  guardMessage,
  resolveExecutor,
  isImmune,
  DANGEROUS_PERMS,
  beginSuppressedOperation,
  endSuppressedOperation,
  isSuppressed,
  buildWhitelistPanel,
  WHITELIST_SELECT_ID,
  WHITELIST_PANEL_MAX
};
