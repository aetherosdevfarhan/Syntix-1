const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.ChannelCreate,
  async execute(channel) {
    if (!channel.guild) return;
    await guard(channel.guild, 'channelCreate', AuditLogEvent.ChannelCreate, channel.id, 'Mass channel creation detected');
  }
};
