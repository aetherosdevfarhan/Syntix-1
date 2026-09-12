const { Events, AuditLogEvent } = require('discord.js');
const { getGuild } = require('../database/db');
const { resolveExecutor, isImmune, guardInstant } = require('../utils/antinukeManager');
const { sendLog } = require('../utils/logger');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    if (!member.user.bot) return;

    const config = getGuild(member.guild.id);
    if (!config.antinuke.enabled || config.antinuke.allowBotAdd) return;

    const resolved = await resolveExecutor(member.guild, AuditLogEvent.BotAdd, member.id);
    const executorId = resolved?.executorId;
    const executorMember = executorId ? await member.guild.members.fetch(executorId).catch(() => null) : null;

    if (isImmune(member.guild, config, executorMember)) return;

    try {
      if (member.kickable) await member.kick('AETHEROS Anti-Nuke: unauthorized bot addition');
    } catch { /* missing perms */ }

    await sendLog(member.guild, config, {
      title: '🤖 Unauthorized bot removed',
      description: `**${member.user.tag}** was added by ${executorId ? `<@${executorId}>` : 'an unknown user'} and has been removed.`,
      color: 'warn'
    });

    if (executorId) {
      await guardInstant(member.guild, executorId, 'Added an unauthorized bot to the server');
    }
  }
};
