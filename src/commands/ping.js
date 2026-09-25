const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if SYNTIX is online and responsive.'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('SYNTIX is online')
      .setDescription(`Gateway latency: **${interaction.client.ws.ping}ms**`)
      .setColor(0x5865F2);
    await interaction.reply({ embeds: [embed] });
  }
};
