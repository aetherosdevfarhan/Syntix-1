const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder
} = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-tempvc')
    .setDescription('Configure the Join-to-Create temporary voice channel system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('enable')
        .setDescription('Create and enable the join-to-create system.')
        .addChannelOption(opt =>
          opt.setName('category')
            .setDescription('Category to create temp channels in')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false))
        .addChannelOption(opt =>
          opt.setName('panel_channel')
            .setDescription('Text channel where owner control panels are posted')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('name_format')
            .setDescription("Channel name format, e.g. \"{user}'s Channel\"")
            .setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('disable').setDescription('Disable the temp voice system.')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show current temp voice configuration.')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const config = getGuild(interaction.guild.id);

    if (sub === 'enable') {
      const category = interaction.options.getChannel('category')
        ?? await interaction.guild.channels.create({ name: 'Voice Channels', type: ChannelType.GuildCategory });

      const joinChannel = await interaction.guild.channels.create({
        name: '➕ Join to Create',
        type: ChannelType.GuildVoice,
        parent: category.id
      });

      const panelChannel = interaction.options.getChannel('panel_channel')
        ?? await interaction.guild.channels.create({
          name: 'voice-controls',
          type: ChannelType.GuildText,
          parent: category.id
        });

      config.tempvc.enabled = true;
      config.tempvc.categoryId = category.id;
      config.tempvc.joinChannelId = joinChannel.id;
      config.tempvc.panelChannelId = panelChannel.id;
      if (interaction.options.getString('name_format')) {
        config.tempvc.nameFormat = interaction.options.getString('name_format');
      }
      saveGuild(interaction.guild.id, config);

      const embed = new EmbedBuilder()
        .setTitle('✅ Temp Voice enabled')
        .setColor(0x57F287)
        .setDescription(
          `Join **${joinChannel}** to instantly get your own voice channel.\n` +
          `Owner control panels will be posted in ${panelChannel}.`
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'disable') {
      config.tempvc.enabled = false;
      saveGuild(interaction.guild.id, config);
      return interaction.reply({ content: '🛑 Temp voice system disabled. Existing channels will not be auto-created anymore.' });
    }

    if (sub === 'status') {
      const tvc = config.tempvc;
      const embed = new EmbedBuilder()
        .setTitle('🔊 Temp Voice Status')
        .setColor(0x5865F2)
        .addFields(
          { name: 'Enabled', value: tvc.enabled ? 'Yes' : 'No', inline: true },
          { name: 'Join Channel', value: tvc.joinChannelId ? `<#${tvc.joinChannelId}>` : 'Not set', inline: true },
          { name: 'Panel Channel', value: tvc.panelChannelId ? `<#${tvc.panelChannelId}>` : 'Not set', inline: true },
          { name: 'Name Format', value: `\`${tvc.nameFormat}\``, inline: true },
          { name: 'Active Channels', value: `${Object.keys(tvc.channels).length}`, inline: true }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
};
