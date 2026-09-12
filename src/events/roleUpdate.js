const { Events, AuditLogEvent } = require('discord.js');
const { getGuild } = require('../database/db');
const { resolveExecutor, isImmune, guardInstant, DANGEROUS_PERMS } = require('../utils/antinukeManager');
const { sendLog } = require('../utils/logger');

module.exports = {
  name: Events.GuildRoleUpdate,
  async execute(oldRole, newRole) {
    const config = getGuild(newRole.guild.id);
    if (!config.antinuke.enabled || config.antinuke.allowDangerousPerms) return;

    const gainedDangerous = DANGEROUS_PERMS.some(
      perm => !oldRole.permissions.has(perm) && newRole.permissions.has(perm)
    );
    if (!gainedDangerous) return;

    const resolved = await resolveExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    if (!resolved?.executorId) return;

    const member = await newRole.guild.members.fetch(resolved.executorId).catch(() => null);
    if (isImmune(newRole.guild, config, member)) return;

    try {
      await newRole.setPermissions(oldRole.permissions, 'AETHEROS Anti-Nuke: reverted dangerous permission grant');
    } catch { /* missing perms to fix the role */ }

    await sendLog(newRole.guild, config, {
      title: '⚠️ Dangerous permission grant reverted',
      description: `<@${resolved.executorId}> attempted to grant dangerous permissions to **${newRole.name}**.`,
      color: 'warn'
    });

    await guardInstant(newRole.guild, resolved.executorId, 'Granted dangerous permissions to a role');
  }
};
