const {
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  UserSelectMenuBuilder
} = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');

const PANEL_ID = {
  LOCK: 'aeth_vc_lock',
  UNLOCK: 'aeth_vc_unlock',
  HIDE: 'aeth_vc_hide',
  UNHIDE: 'aeth_vc_unhide',
  LIMIT: 'aeth_vc_limit',
  RENAME: 'aeth_vc_rename',
  CLAIM: 'aeth_vc_claim',
  KICK: 'aeth_vc_kick',
  PERMIT: 'aeth_vc_permit',
  REJECT: 'aeth_vc_reject',
  TRANSFER: 'aeth_vc_transfer'
};

function formatName(format, member) {
  return format
    .replace('{user}', member.displayName)
    .replace('{tag}', member.user.username);
}

function buildControlRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_ID.LOCK).setEmoji('🔒').setLabel('Lock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PANEL_ID.UNLOCK).setEmoji('🔓').setLabel('Unlock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PANEL_ID.HIDE).setEmoji('🙈').setLabel('Hide').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PANEL_ID.UNHIDE).setEmoji('👁️').setLabel('Unhide').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_ID.LIMIT).setEmoji('🔢').setLabel('Set Limit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PANEL_ID.RENAME).setEmoji('✏️').setLabel('Rename').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PANEL_ID.CLAIM).setEmoji('👑').setLabel('Claim').setStyle(ButtonStyle.Success)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(PANEL_ID.KICK).setPlaceholder('🥾 Kick a member from your channel').setMaxValues(1)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(PANEL_ID.PERMIT).setPlaceholder('✅ Permit a member (bypass lock)').setMaxValues(1)
  );
  const row5 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(PANEL_ID.REJECT).setPlaceholder('⛔ Reject/ban a member from your channel').setMaxValues(1)
  );
  const row6 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(PANEL_ID.TRANSFER).setPlaceholder('👑 Transfer ownership').setMaxValues(1)
  );
  return [row1, row2, row3, row4, row5, row6];
}

function buildPanelEmbed(channel, ownerId) {
  return new EmbedBuilder()
    .setTitle(`🔊 ${channel.name}`)
    .setDescription(
      `Owner: <@${ownerId}>\n\nUse the controls below to manage your temporary voice channel.\n` +
      `Only the owner (or a claimant, if the owner leaves) can use these controls.`
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'AETHEROS · Temp Voice' });
}

async function handleJoinCreate(member, joinChannel) {
  const guild = member.guild;
  const config = getGuild(guild.id);
  const tvc = config.tempvc;
  if (!tvc.enabled || joinChannel.id !== tvc.joinChannelId) return;

  const category = joinChannel.parent;
  const name = formatName(tvc.nameFormat, member);

  const newChannel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category ?? undefined,
    userLimit: tvc.defaultLimit || 0,
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
      },
      {
        id: member.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.MoveMembers,
          PermissionsBitField.Flags.MuteMembers,
          PermissionsBitField.Flags.DeafenMembers
        ]
      }
    ]
  });

  await member.voice.setChannel(newChannel).catch(() => null);

  tvc.channels[newChannel.id] = { ownerId: member.id, createdAt: Date.now(), rejected: [] };
  saveGuild(guild.id, config);

  try {
    const panelChannel = tvc.panelChannelId
      ? guild.channels.cache.get(tvc.panelChannelId)
      : newChannel;

    if (panelChannel && panelChannel.isTextBased()) {
      const msg = await panelChannel.send({
        content: `<@${member.id}>`,
        embeds: [buildPanelEmbed(newChannel, member.id)],
        components: buildControlRows()
      });
      tvc.channels[newChannel.id].panelMessageId = msg.id;
      tvc.channels[newChannel.id].panelChannelId = panelChannel.id;
      saveGuild(guild.id, config);
    }
  } catch { /* non-fatal */ }

  return newChannel;
}

async function handleAutoDelete(guild, channel) {
  const config = getGuild(guild.id);
  const tvc = config.tempvc;
  const record = tvc.channels[channel.id];
  if (!record) return;
  if (record.persistent) return; // 24/7 channel — never auto-deletes
  if (channel.members.size > 0) return;

  try {
    if (record.panelChannelId && record.panelMessageId) {
      const pc = guild.channels.cache.get(record.panelChannelId);
      const msg = pc && (await pc.messages.fetch(record.panelMessageId).catch(() => null));
      if (msg) await msg.delete().catch(() => null);
    }
    await channel.delete('AETHEROS: temp voice channel empty');
  } catch { /* already gone */ }

  delete tvc.channels[channel.id];
  saveGuild(guild.id, config);
}

function getOwnerRecord(guild, channelId) {
  const config = getGuild(guild.id);
  return { config, record: config.tempvc.channels[channelId] };
}

function isChannelOwner(guild, channelId, userId) {
  const { record } = getOwnerRecord(guild, channelId);
  return record && record.ownerId === userId;
}

module.exports = {
  PANEL_ID,
  handleJoinCreate,
  handleAutoDelete,
  buildControlRows,
  buildPanelEmbed,
  getOwnerRecord,
  isChannelOwner,
  formatName
};
