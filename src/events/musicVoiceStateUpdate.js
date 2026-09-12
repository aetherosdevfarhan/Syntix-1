const { Events } = require('discord.js');
const { getQueue, destroyQueue, EMPTY_CHANNEL_TIMEOUT_MS } = require('../utils/musicManager');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    const queue = getQueue(guild.id);
    if (!queue) return;

    const channel = guild.channels.cache.get(queue.voiceChannelId);
    if (!channel) return destroyQueue(guild.id);

    const humansInChannel = channel.members.filter(m => !m.user.bot).size;

    if (humansInChannel === 0) {
      if (queue.emptyTimer) return;
      queue.emptyTimer = setTimeout(() => {
        const fresh = getQueue(guild.id);
        if (!fresh) return;
        const liveChannel = guild.channels.cache.get(fresh.voiceChannelId);
        const stillEmpty = !liveChannel || liveChannel.members.filter(m => !m.user.bot).size === 0;
        if (stillEmpty) {
          fresh.textChannel?.send('👋 Left the voice channel — everyone left.').catch(() => null);
          destroyQueue(guild.id);
        }
      }, EMPTY_CHANNEL_TIMEOUT_MS);
    } else if (queue.emptyTimer) {
      clearTimeout(queue.emptyTimer);
      queue.emptyTimer = null;
    }
  }
};
