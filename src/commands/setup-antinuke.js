const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder
} = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-antinuke')
    .setDescription('Configure AETHEROS Anti-Nuke protection.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('enable')
        .setDescription('Enable anti-nuke protection.')
        .addChannelOption(opt =>
          opt.setName('log_channel')
            .setDescription('Where anti-nuke alerts are logged')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('punishment')
            .setDescription('Action taken against offenders')
            .addChoices(
              { name: 'Strip roles + Ban', value: 'strip_ban' },
              { name: 'Strip roles + Kick', value: 'strip_kick' },
              { name: 'Strip roles only', value: 'strip_only' }
            )
            .setRequired(false))
    )
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable anti-nuke protection.'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show current anti-nuke configuration.'))
    .addSubcommandGroup(group =>
      group.setName('whitelist')
        .setDescription('Manage trusted users who bypass anti-nuke checks.')
        .addSubcommand(sub =>
          sub.setName('add').setDescription('Whitelist a user.')
            .addUserOption(opt => opt.setName('user').setDescription('User to whitelist').setRequired(true)))
        .addSubcommand(sub =>
          sub.setName('remove').setDescription('Remove a user from the whitelist.')
            .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('List whitelisted users.'))
    )
    .addSubcommand(sub =>
      sub.setName('trusted-role')
        .setDescription('Set a role that is always immune to anti-nuke punishment.')
        .addRoleOption(opt => opt.setName('role').setDescription('Trusted role').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('threshold')
        .setDescription('Adjust how sensitive a protection is.')
        .addStringOption(opt =>
          opt.setName('action')
            .setDescription('Which protection to tune')
            .setRequired(true)
            .addChoices(
              { name: 'Channel Delete', value: 'channelDelete' },
              { name: 'Channel Create', value: 'channelCreate' },
              { name: 'Role Delete', value: 'roleDelete' },
              { name: 'Role Create', value: 'roleCreate' },
              { name: 'Ban', value: 'ban' },
              { name: 'Kick', value: 'kick' },
              { name: 'Webhook Create', value: 'webhookCreate' }
            ))
        .addIntegerOption(opt => opt.setName('count').setDescription('Number of actions').setRequired(true).setMinValue(1))
        .addIntegerOption(opt => opt.setName('seconds').setDescription('Time window in seconds').setRequired(true).setMinValue(2))
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const config = getGuild(interaction.guild.id);

    if (group === 'whitelist') {
      if (sub === 'add') {
        const user = interaction.options.getUser('user');

        if (user.id === interaction.guild.ownerId) {
          return interaction.reply({
            content: `ℹ️ ${user} is the server owner and is already always immune — no need to whitelist them.`,
            ephemeral: true
          });
        }
        if (config.antinuke.whitelist.includes(user.id)) {
          return interaction.reply({ content: `⚠️ ${user} is already whitelisted.`, ephemeral: true });
        }

        config.antinuke.whitelist.push(user.id);
        saveGuild(interaction.guild.id, config);

        const embed = new EmbedBuilder()
          .setColor(0x57F287)
          .setDescription(`✅ ${user} added to the anti-nuke whitelist.`)
          .setFooter({ text: `${config.antinuke.whitelist.length} user(s) whitelisted` });
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'remove') {
        const user = interaction.options.getUser('user');
        if (!config.antinuke.whitelist.includes(user.id)) {
          return interaction.reply({ content: `⚠️ ${user} isn't on the whitelist.`, ephemeral: true });
        }

        config.antinuke.whitelist = config.antinuke.whitelist.filter(id => id !== user.id);
        saveGuild(interaction.guild.id, config);

        const embed = new EmbedBuilder()
          .setColor(0xED4245)
          .setDescription(`🗑️ ${user} removed from the anti-nuke whitelist.`)
          .setFooter({ text: `${config.antinuke.whitelist.length} user(s) whitelisted` });
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'list') {
        const ids = config.antinuke.whitelist;

        if (!ids.length) {
          return interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🛡️ Anti-Nuke Whitelist').setDescription('No one whitelisted yet.')],
            ephemeral: true
          });
        }

        const CHUNK = 25;
        const fields = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          fields.push({
            name: `Members ${i + 1}–${i + chunk.length}`,
            value: chunk.map(id => `<@${id}>`).join('\n'),
            inline: true
          });
        }

        const embeds = [];
        for (let i = 0; i < fields.length; i += 25) {
          const batch = fields.slice(i, i + 25);
          embeds.push(
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle(i === 0 ? `🛡️ Anti-Nuke Whitelist (${ids.length})` : '🛡️ Anti-Nuke Whitelist (cont.)')
              .addFields(batch)
          );
        }

        return interaction.reply({ embeds, ephemeral: true });
      }
    }

    if (sub === 'enable') {
      const logChannel = interaction.options.getChannel('log_channel');
      config.antinuke.enabled = true;
      config.antinuke.logChannelId = logChannel.id;
      config.antinuke.punishment = interaction.options.getString('punishment') ?? config.antinuke.punishment;
      saveGuild(interaction.guild.id, config);

      const embed = new EmbedBuilder()
        .setTitle('🛡️ Anti-Nuke enabled')
        .setColor(0x57F287)
        .setDescription(
          `AETHEROS is now guarding this server against mass-ban, mass-kick, channel/role nuking, ` +
          `unauthorized webhooks, and unauthorized bot additions.\nAlerts will be posted in ${logChannel}.`
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'disable') {
      config.antinuke.enabled = false;
      saveGuild(interaction.guild.id, config);
      return interaction.reply({ content: '🛑 Anti-Nuke protection disabled.' });
    }

    if (sub === 'status') {
      const an = config.antinuke;
      const t = an.thresholds;
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Anti-Nuke Status')
        .setColor(0x5865F2)
        .addFields(
          { name: 'Enabled', value: an.enabled ? 'Yes' : 'No', inline: true },
          { name: 'Punishment', value: an.punishment, inline: true },
          { name: 'Log Channel', value: an.logChannelId ? `<#${an.logChannelId}>` : 'Not set', inline: true },
          { name: 'Trusted Role', value: an.trustedRoleId ? `<@&${an.trustedRoleId}>` : 'None', inline: true },
          { name: 'Whitelisted Users', value: `${an.whitelist.length}`, inline: true },
          {
            name: 'Thresholds',
            value: Object.entries(t).map(([k, v]) => `\`${k}\`: ${v.count} / ${v.seconds}s`).join('\n')
          }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'trusted-role') {
      const role = interaction.options.getRole('role');
      config.antinuke.trustedRoleId = role.id;
      saveGuild(interaction.guild.id, config);
      return interaction.reply({ content: `✅ ${role} is now immune to anti-nuke punishment.` });
    }

    if (sub === 'threshold') {
      const action = interaction.options.getString('action');
      const count = interaction.options.getInteger('count');
      const seconds = interaction.options.getInteger('seconds');
      config.antinuke.thresholds[action] = { count, seconds };
      saveGuild(interaction.guild.id, config);
      return interaction.reply({ content: `✅ \`${action}\` threshold set to **${count} actions / ${seconds}s**.` });
    }
  }
};
