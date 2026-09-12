const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');
const { getGuild, saveGuild } = require('../database/db');

module.exports = {
  name: Events.ChannelDelete,
  async execute(channel) {
    if (!channel.guild) return;

    const config = getGuild(channel.guild.id);
    if (config.tempvc.channels[channel.id]) {
      delete config.tempvc.channels[channel.id];
      saveGuild(channel.guild.id, config);
    }

    await guard(channel.guild, 'channelDelete', AuditLogEvent.ChannelDelete, channel.id, 'Mass channel deletion detected');
  }
};
