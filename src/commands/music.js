const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const music = require('../utils/musicManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Play music in your voice channel.')
    .addSubcommand(s =>
      s.setName('play').setDescription('Play a song or add it to the queue.')
        .addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setRequired(true)))
    .addSubcommand(s => s.setName('skip').setDescription('Skip the current song.'))
    .addSubcommand(s => s.setName('stop').setDescription('Stop playback and clear the queue.'))
    .addSubcommand(s => s.setName('pause').setDescription('Pause playback.'))
    .addSubcommand(s => s.setName('resume').setDescription('Resume playback.'))
    .addSubcommand(s => s.setName('queue').setDescription('Show the current queue.'))
    .addSubcommand(s => s.setName('nowplaying').setDescription('Show the currently playing song.'))
    .addSubcommand(s =>
      s.setName('volume').setDescription('Set playback volume.')
        .addIntegerOption(o => o.setName('percent').setDescription('0-200').setRequired(true).setMinValue(0).setMaxValue(200)))
    .addSubcommand(s =>
      s.setName('loop').setDescription('Set loop mode.')
        .addStringOption(o =>
          o.setName('mode').setDescription('Loop mode').setRequired(true)
            .addChoices(
              { name: 'Off', value: 'off' },
              { name: 'Track', value: 'track' },
              { name: 'Queue', value: 'queue' }
            ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('query');
      try {
        const result = await music.addToQueue({
          guild: interaction.guild,
          member: interaction.member,
          textChannel: interaction.channel,
          query
        });
        const embed = new EmbedBuilder().setColor(0x5865F2);
        if (result.startedPlaying) {
          embed.setTitle('🎶 Now playing').setDescription(`**${result.track.title}**`)
            .setThumbnail(result.track.thumbnail || null)
            .addFields({ name: 'Duration', value: music.formatDuration(result.track.durationSeconds), inline: true });
        } else {
          embed.setTitle('➕ Added to queue').setDescription(`**${result.track.title}**`)
            .setThumbnail(result.track.thumbnail || null)
            .addFields(
              { name: 'Duration', value: music.formatDuration(result.track.durationSeconds), inline: true },
              { name: 'Position', value: `${result.position}`, inline: true }
            );
        }
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ ${err.message}`);
      }
    }

    if (sub === 'skip') {
      try {
        const skipped = music.skip(interaction.guild.id);
        return interaction.reply(`⏭️ Skipped **${skipped.title}**.`);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (sub === 'stop') {
      try {
        music.stop(interaction.guild.id);
        return interaction.reply('⏹️ Stopped playback and cleared the queue.');
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (sub === 'pause') {
      try {
        music.pause(interaction.guild.id);
        return interaction.reply('⏸️ Paused.');
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (sub === 'resume') {
      try {
        music.resume(interaction.guild.id);
        return interaction.reply('▶️ Resumed.');
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (sub === 'volume') {
      try {
        const percent = interaction.options.getInteger('percent');
        music.setVolume(interaction.guild.id, percent);
        return interaction.reply(`🔊 Volume set to ${percent}%.`);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (sub === 'loop') {
      try {
        const mode = interaction.options.getString('mode');
        music.setLoop(interaction.guild.id, mode);
        return interaction.reply(`🔁 Loop mode set to **${mode}**.`);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (sub === 'nowplaying') {
      const queue = music.getQueue(interaction.guild.id);
      if (!queue?.nowPlaying) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle('🎶 Now playing')
        .setDescription(`**${queue.nowPlaying.title}**`)
        .setThumbnail(queue.nowPlaying.thumbnail || null)
        .setColor(0x5865F2)
        .addFields(
          { name: 'Duration', value: music.formatDuration(queue.nowPlaying.durationSeconds), inline: true },
          { name: 'Requested by', value: `<@${queue.nowPlaying.requestedBy}>`, inline: true },
          { name: 'Loop', value: queue.loop, inline: true }
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'queue') {
      const queue = music.getQueue(interaction.guild.id);
      if (!queue || (!queue.nowPlaying && queue.songs.length === 0)) {
        return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
      }
      const lines = queue.songs.slice(0, 10).map((s, i) => `**${i + 1}.** ${s.title} — ${music.formatDuration(s.durationSeconds)}`);
      const embed = new EmbedBuilder()
        .setTitle('📜 Queue')
        .setColor(0x5865F2)
        .setDescription(
          `**Now playing:** ${queue.nowPlaying ? queue.nowPlaying.title : 'Nothing'}\n\n` +
          (lines.length ? lines.join('\n') : '_Queue is empty._') +
          (queue.songs.length > 10 ? `\n...and ${queue.songs.length - 10} more` : '')
        );
      return interaction.reply({ embeds: [embed] });
    }
  }
};
