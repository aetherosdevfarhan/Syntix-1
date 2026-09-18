const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildBanRemove,
  async execute(ban) {
    await guard(ban.guild, 'unban', AuditLogEvent.MemberBanRemove, ban.user.id, 'Mass unban detected');
  }
};
