const { EmbedBuilder } = require('discord.js');

const COLORS = {
  info: 0x5865F2,
  success: 0x57F287,
  warn: 0xFEE75C,
  danger: 0xED4245
};

async function sendLog(guild, guildConfig, { title, description, color = 'info', fields = [] }) {
  if (!guildConfig?.antinuke?.logChannelId) return;
  const channel = guild.channels.cache.get(guildConfig.antinuke.logChannelId);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || null)
    .setColor(COLORS[color] ?? COLORS.info)
    .setTimestamp()
    .setFooter({ text: 'AETHEROS · Anti-Nuke' });

  if (fields.length) embed.addFields(fields);

  try {
    await channel.send({ embeds: [embed] });
  } catch {
    // missing perms in log channel, ignore
  }
}

module.exports = { sendLog, COLORS };
