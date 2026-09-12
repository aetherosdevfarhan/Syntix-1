const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildBanAdd,
  async execute(ban) {
    await guard(ban.guild, 'ban', AuditLogEvent.MemberBanAdd, ban.user.id, 'Mass ban detected');
  }
};
