const { Events, ChannelType, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');
const { PANEL_ID } = require('../utils/tempVCManager');
const { beginSuppressedOperation, endSuppressedOperation } = require('../utils/antinukeManager');

function findOwnedChannel(interaction) {
  const config = getGuild(interaction.guild.id);
  const entry = Object.entries(config.tempvc.channels).find(
    ([, rec]) => rec.panelMessageId === interaction.message?.id
  );
  if (!entry) return { error: 'This control panel is no longer linked to an active channel.' };
  const [channelId, record] = entry;
  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel) return { error: 'That voice channel no longer exists.' };
  if (record.ownerId !== interaction.user.id) return { error: 'Only the channel owner can use these controls.' };
  return { config, channel, record, channelId };
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction);
      } catch (err) {
        console.error(`[AETHEROS] Error in /${interaction.commandName}:`, err);
        const payload = { content: '⚠️ Something went wrong running that command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
        else await interaction.reply(payload).catch(() => null);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'aeth_modal_rename') {
        const config = getGuild(interaction.guild.id);
        const entry = Object.entries(config.tempvc.channels).find(([, r]) => r.ownerId === interaction.user.id);
        if (!entry) return interaction.reply({ content: '❌ No owned channel found.', ephemeral: true });
        const channel = interaction.guild.channels.cache.get(entry[0]);
        const newName = interaction.fields.getTextInputValue('name');
        await channel.setName(newName).catch(() => null);
        return interaction.reply({ content: `✏️ Renamed to **${newName}**.`, ephemeral: true });
      }
      if (interaction.customId === 'aeth_modal_limit') {
        const config = getGuild(interaction.guild.id);
        const entry = Object.entries(config.tempvc.channels).find(([, r]) => r.ownerId === interaction.user.id);
        if (!entry) return interaction.reply({ content: '❌ No owned channel found.', ephemeral: true });
        const channel = interaction.guild.channels.cache.get(entry[0]);
        const raw = interaction.fields.getTextInputValue('limit');
        const num = Math.max(0, Math.min(99, parseInt(raw, 10) || 0));
        await channel.setUserLimit(num).catch(() => null);
        return interaction.reply({ content: `🔢 Limit set to ${num === 0 ? 'unlimited' : num}.`, ephemeral: true });
      }
      return;
    }

    // ---- owner-only server wipe confirmation ----
    if (interaction.isButton() && interaction.customId.startsWith('aeth_nuke_confirm_')) {
      const requesterId = interaction.customId.replace('aeth_nuke_confirm_', '');
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId || interaction.user.id !== requesterId || interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ This confirmation isn\'t yours to press.', ephemeral: true });
      }

      await interaction.update({ content: '💥 Wipe in progress...', embeds: [], components: [] });
      const guild = interaction.guild;
      const botMember = guild.members.me;

      // Stop anti-nuke from reacting to the flood of bans/channel-deletes/role-deletes this is
      // about to cause — otherwise every single event fetches audit logs (slow) and can even get
      // the bot to punish itself/whoever confirmed the wipe mid-operation.
      beginSuppressedOperation(guild.id);

      // Run a batch of promises with limited concurrency so we don't await each API call
      // one-by-one (slow) but also don't fire hundreds at once (hits Discord rate limits harder
      // than necessary). discord.js's REST manager still queues/throttles per-route under the hood.
      async function runBatched(items, concurrency, task) {
        let i = 0;
        async function worker() {
          while (i < items.length) {
            const item = items[i++];
            await task(item);
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
      }

      let bannedCount = 0;
      let failedCount = 0;
      let roleFailCount = 0;
      const failedNames = [];

      // Fetch members/roles/channels in parallel instead of one after another — these are three
      // independent read calls, no reason to wait on them sequentially.
      const [members, roles, channels] = await Promise.all([
        guild.members.fetch(),
        guild.roles.fetch(),
        guild.channels.fetch()
      ]);

      const banTargets = [...members.values()].filter(
        (member) => member.id !== interaction.user.id && member.id !== guild.client.user.id && member.id !== guild.ownerId
      );
      const roleTargets = [...roles.values()].filter((role) => role.id !== guild.id && !role.managed);
      const channelTargets = [...channels.values()].filter(Boolean);

      // Bulk-ban (POST /guilds/{id}/bulk-ban, up to 200 IDs per call) needs Ban Members AND
      // Manage Server on the bot. Check this ONCE up front instead of discovering it by letting
      // every 200-user chunk fail and fall back individually — that wastes a full round trip per
      // chunk before the slow path even starts. If it's missing, go straight to the per-user path
      // so we don't waste time on doomed bulk-ban attempts.
      const canBulkBan = botMember.permissions.has(PermissionFlagsBits.BanMembers) &&
        botMember.permissions.has(PermissionFlagsBits.ManageGuild);

      // Live progress: edit the reply every few seconds so it's obvious the wipe is actually
      // moving instead of looking stuck on a big server. Silently stops mattering once the
      // channel is deleted — the edit just fails and we ignore it.
      let stopProgress = false;
      const progressTimer = setInterval(() => {
        if (stopProgress) return;
        const total = banTargets.length;
        const channelsGone = channelTargets.filter((c) => !guild.channels.cache.has(c.id)).length;
        interaction.editReply({
          content: `💥 Wipe in progress... **${bannedCount + failedCount}/${total}** member(s) processed, ` +
            `**${channelsGone}/${channelTargets.length}** channels gone.`
        }).catch(() => null);
      }, 4000);

      const BULK_BAN_CHUNK = 200;
      const banIdChunks = [];
      for (let i = 0; i < banTargets.length; i += BULK_BAN_CHUNK) {
        banIdChunks.push(banTargets.slice(i, i + BULK_BAN_CHUNK).map((m) => m.id));
      }
      const idToTag = new Map(banTargets.map((m) => [m.id, m.user.tag]));

      try {
        await Promise.all([
          (async () => {
            if (!canBulkBan) {
              // Straight to per-user bans — Discord's normal ban route is rate-limited to a
              // handful of requests per few seconds per guild regardless of concurrency, so this
              // is inherently the slow path, but it's the only one available without Manage Server.
              await runBatched(banTargets.map((m) => m.id), 10, async (id) => {
                try {
                  await guild.members.ban(id, { reason: 'AETHEROS: owner-triggered wipe' });
                  bannedCount++;
                } catch (banErr) {
                  failedCount++;
                  failedNames.push(idToTag.get(id) || id);
                }
              });
              return;
            }
            for (const chunk of banIdChunks) {
              try {
                const result = await guild.members.bulkBan(chunk, { reason: 'AETHEROS: owner-triggered wipe' });
                bannedCount += result.bannedUsers.length;
                failedCount += result.failedUsers.length;
                for (const id of result.failedUsers) failedNames.push(idToTag.get(id) || id);
              } catch (err) {
                // Unexpected failure on a chunk that should have worked (e.g. transient API
                // error) — fall back to per-user ban for just that chunk rather than losing it.
                console.error('[AETHEROS] bulkBan chunk failed, falling back to individual bans:', err.message);
                await runBatched(chunk, 10, async (id) => {
                  try {
                    await guild.members.ban(id, { reason: 'AETHEROS: owner-triggered wipe' });
                    bannedCount++;
                  } catch (banErr) {
                    failedCount++;
                    failedNames.push(idToTag.get(id) || id);
                    console.error(`[AETHEROS] Failed to ban ${id} during nuke:`, banErr.message);
                  }
                });
              }
            }
          })(),
          runBatched(roleTargets, 10, async (role) => {
            try {
              await role.delete('AETHEROS: owner-triggered wipe');
            } catch {
              roleFailCount++;
            }
          }),
          runBatched(channelTargets, 10, (channel) =>
            channel.delete('AETHEROS: owner-triggered wipe').catch(() => null)
          )
        ]);
      } finally {
        stopProgress = true;
        clearInterval(progressTimer);
        endSuppressedOperation(guild.id);
      }

      // Sent via DM, not followUp() — every channel this could have posted to was just deleted
      // as part of the wipe, so a channel-based report would silently vanish. DM always survives.
      let report = `✅ Wipe of **${guild.name}** complete.\n**Banned:** ${bannedCount} member(s).`;
      if (!canBulkBan) {
        report += `\n⚠️ Banned one-by-one because I'm missing **Manage Server** — give me that permission ` +
          `alongside Ban Members next time for the much faster bulk-ban path.`;
      }
      if (roleFailCount > 0) report += `\n⚠️ **${roleFailCount} role(s) failed to delete** — my role was positioned below them.`;
      if (failedCount > 0) {
        report += `\n⚠️ **Failed to ban ${failedCount}:** ${failedNames.slice(0, 15).join(', ')}${failedNames.length > 15 ? '...' : ''}\n` +
          `This means my role was positioned too low to act on them (Administrator does not bypass role hierarchy). Next time, drag my bot's role to the top of Server Settings -> Roles before running this.`;
      }
      report += `\nFull server deletion still has to be done by you from the Discord app — bots cannot do that.`;

      await interaction.user.send(report).catch(() => null);
      await interaction.followUp({ content: report }).catch(() => null);
      return;
    }

    // ---- Temp VC panel buttons ----
    if (interaction.isButton() && Object.values(PANEL_ID).includes(interaction.customId)) {
      if (interaction.customId === PANEL_ID.RENAME) {
        const modal = new ModalBuilder().setCustomId('aeth_modal_rename').setTitle('Rename your channel');
        const input = new TextInputBuilder().setCustomId('name').setLabel('New channel name').setStyle(TextInputStyle.Short).setMaxLength(90).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.customId === PANEL_ID.LIMIT) {
        const modal = new ModalBuilder().setCustomId('aeth_modal_limit').setTitle('Set user limit');
        const input = new TextInputBuilder().setCustomId('limit').setLabel('Limit (0 = unlimited, max 99)').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId === PANEL_ID.CLAIM) {
        const config = getGuild(interaction.guild.id);
        const entry = Object.entries(config.tempvc.channels).find(
          ([, rec]) => rec.panelMessageId === interaction.message.id
        );
        if (!entry) return interaction.reply({ content: '❌ Channel no longer exists.', ephemeral: true });
        const [channelId, record] = entry;
        const channel = interaction.guild.channels.cache.get(channelId);
        if (channel.members.has(record.ownerId)) {
          return interaction.reply({ content: 'The current owner is still connected.', ephemeral: true });
        }
        record.ownerId = interaction.user.id;
        saveGuild(interaction.guild.id, config);
        await channel.permissionOverwrites.edit(interaction.user.id, {
          ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true
        }).catch(() => null);
        return interaction.reply({ content: `👑 <@${interaction.user.id}> is now the owner of this channel.` });
      }

      const result = findOwnedChannel(interaction);
      if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      const { channel } = result;

      if (interaction.customId === PANEL_ID.LOCK) {
        await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
        return interaction.reply({ content: '🔒 Channel locked.', ephemeral: true });
      }
      if (interaction.customId === PANEL_ID.UNLOCK) {
        await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: true });
        return interaction.reply({ content: '🔓 Channel unlocked.', ephemeral: true });
      }
      if (interaction.customId === PANEL_ID.HIDE) {
        await channel.permissionOverwrites.edit(interaction.guild.id, { ViewChannel: false });
        return interaction.reply({ content: '🙈 Channel hidden.', ephemeral: true });
      }
      if (interaction.customId === PANEL_ID.UNHIDE) {
        await channel.permissionOverwrites.edit(interaction.guild.id, { ViewChannel: true });
        return interaction.reply({ content: '👁️ Channel visible again.', ephemeral: true });
      }
      return;
    }

    // ---- Temp VC panel user-select menus (kick / permit / reject / transfer) ----
    if (interaction.isUserSelectMenu() && Object.values(PANEL_ID).includes(interaction.customId)) {
      const result = findOwnedChannel(interaction);
      if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      const { channel, config, record } = result;
      const targetId = interaction.values[0];

      if (interaction.customId === PANEL_ID.KICK) {
        const targetMember = channel.members.get(targetId);
        if (!targetMember) return interaction.reply({ content: 'That user is not in your channel.', ephemeral: true });
        await targetMember.voice.disconnect('Kicked by channel owner').catch(() => null);
        return interaction.reply({ content: `🥾 Removed <@${targetId}> from the channel.`, ephemeral: true });
      }
      if (interaction.customId === PANEL_ID.PERMIT) {
        await channel.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true }).catch(() => null);
        return interaction.reply({ content: `✅ <@${targetId}> can now join even if locked.`, ephemeral: true });
      }
      if (interaction.customId === PANEL_ID.REJECT) {
        await channel.permissionOverwrites.edit(targetId, { Connect: false, ViewChannel: false }).catch(() => null);
        const targetMember = channel.members.get(targetId);
        if (targetMember) await targetMember.voice.disconnect('Rejected by channel owner').catch(() => null);
        if (!record.rejected.includes(targetId)) record.rejected.push(targetId);
        saveGuild(interaction.guild.id, config);
        return interaction.reply({ content: `⛔ <@${targetId}> can no longer join this channel.`, ephemeral: true });
      }
      if (interaction.customId === PANEL_ID.TRANSFER) {
        record.ownerId = targetId;
        saveGuild(interaction.guild.id, config);
        await channel.permissionOverwrites.edit(targetId, {
          ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true
        }).catch(() => null);
        return interaction.reply({ content: `👑 Ownership transferred to <@${targetId}>.` });
      }
    }
  }
};
