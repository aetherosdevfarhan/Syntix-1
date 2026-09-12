const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    try {
      const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 3 });
      const match = logs.entries.find(
        e => e.target?.id === member.id && Date.now() - e.createdTimestamp < 8000
      );
      if (!match) return;
    } catch {
      return;
    }

    await guard(member.guild, 'kick', AuditLogEvent.MemberKick, member.id, 'Mass kick detected');
  }
};
