const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');
const { isChannelOwner } = require('../utils/tempVCManager');

function requireOwnedChannel(interaction) {
  const config = getGuild(interaction.guild.id);
  const channel = interaction.member.voice.channel;
  if (!channel || !config.tempvc.channels[channel.id]) {
    return { error: "You're not in a temp voice channel managed by AETHEROS." };
  }
  const record = config.tempvc.channels[channel.id];
  if (record.ownerId !== interaction.user.id) {
    return { error: 'Only the channel owner can do that. Use `/vc claim` if the owner left.' };
  }
  return { config, channel, record };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vc')
    .setDescription('Manage your temporary voice channel.')
    .addSubcommand(s => s.setName('lock').setDescription('Lock your voice channel.'))
    .addSubcommand(s => s.setName('unlock').setDescription('Unlock your voice channel.'))
    .addSubcommand(s =>
      s.setName('limit').setDescription('Set a user limit.')
        .addIntegerOption(o => o.setName('count').setDescription('0 = unlimited').setRequired(true).setMinValue(0).setMaxValue(99)))
    .addSubcommand(s =>
      s.setName('rename').setDescription('Rename your voice channel.')
        .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)))
    .addSubcommand(s => s.setName('claim').setDescription('Claim ownership if the previous owner left.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'claim') {
      const config = getGuild(interaction.guild.id);
      const channel = interaction.member.voice.channel;
      if (!channel || !config.tempvc.channels[channel.id]) {
        return interaction.reply({ content: "You're not in an AETHEROS temp voice channel.", ephemeral: true });
      }
      const record = config.tempvc.channels[channel.id];
      const ownerStillIn = channel.members.has(record.ownerId);
      if (ownerStillIn) {
        return interaction.reply({ content: 'The current owner is still in the channel.', ephemeral: true });
      }
      record.ownerId = interaction.user.id;
      saveGuild(interaction.guild.id, config);
      await channel.permissionOverwrites.edit(interaction.user.id, {
        ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true
      }).catch(() => null);
      return interaction.reply({ content: `👑 You are now the owner of **${channel.name}**.` });
    }

    const result = requireOwnedChannel(interaction);
    if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    const { channel } = result;

    if (sub === 'lock') {
      await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
      return interaction.reply({ content: '🔒 Channel locked.' });
    }
    if (sub === 'unlock') {
      await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: true });
      return interaction.reply({ content: '🔓 Channel unlocked.' });
    }
    if (sub === 'limit') {
      const count = interaction.options.getInteger('count');
      await channel.setUserLimit(count);
      return interaction.reply({ content: `🔢 User limit set to ${count === 0 ? 'unlimited' : count}.` });
    }
    if (sub === 'rename') {
      const name = interaction.options.getString('name');
      await channel.setName(name);
      return interaction.reply({ content: `✏️ Channel renamed to **${name}**.` });
    }
   
  }
};
