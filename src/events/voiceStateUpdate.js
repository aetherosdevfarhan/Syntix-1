const { Events } = require('discord.js');
const { getGuild } = require('../database/db');
const { handleJoinCreate, handleAutoDelete } = require('../utils/tempVCManager');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    const config = getGuild(guild.id);
    if (!config.tempvc.enabled) return;

    if (newState.channelId && newState.channelId !== oldState.channelId) {
      if (newState.channelId === config.tempvc.joinChannelId) {
        try {
          await handleJoinCreate(newState.member, newState.channel);
        } catch (err) {
          console.error('[AETHEROS] Failed to create temp voice channel:', err);
        }
      }
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const oldChannel = oldState.channel;
      if (oldChannel && config.tempvc.channels[oldChannel.id]) {
        setTimeout(() => {
          const fresh = getGuild(guild.id);
          if (!fresh.tempvc.channels[oldChannel.id]) return;
          const liveChannel = guild.channels.cache.get(oldChannel.id);
          if (!liveChannel) return;
          handleAutoDelete(guild, liveChannel).catch(() => null);
        }, 3000);
      }
    }
  }
};
