const { Events, ChannelType, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');
const { PANEL_ID } = require('../utils/tempVCManager');
const { beginSuppressedOperation, endSuppressedOperation, buildWhitelistPanel, WHITELIST_SELECT_ID, buildModulesPanel, MODULE_SELECT_ID, MODULE_DEFS, setModuleEnabled } = require('../utils/antinukeManager');
const { withRetry } = require('../utils/retry');
const { consume } = require('../utils/pendingConfirms');

const activeWipes = new Set();
const activeExecutions = new Set();

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
        console.error(`[SYNTIX] Error in /${interaction.commandName}:`, err);
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

    if (interaction.isUserSelectMenu() && interaction.customId === WHITELIST_SELECT_ID) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ You need **Administrator** to manage the whitelist.', ephemeral: true });
      }

      const config = getGuild(interaction.guild.id);
      const ids = config.antinuke.whitelist;
      const overflow = ids.slice(25);
      const newlySelected = interaction.values.filter((id) => id !== interaction.guild.ownerId);
      config.antinuke.whitelist = [...new Set([...overflow, ...newlySelected])];
      saveGuild(interaction.guild.id, config);

      const { embed, row } = buildWhitelistPanel(config);
      return interaction.update({ embeds: [embed], components: [row] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === MODULE_SELECT_ID) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ You need **Administrator** to manage anti-nuke modules.', ephemeral: true });
      }

      const config = getGuild(interaction.guild.id);
      const selected = new Set(interaction.values);
      for (const def of MODULE_DEFS) {
        setModuleEnabled(config, def.key, selected.has(def.key));
      }
      saveGuild(interaction.guild.id, config);

      const { embed, row } = buildModulesPanel(config);
      return interaction.update({ embeds: [embed], components: [row] });
    }

    // ---- owner-only server wipe confirmation ----
    if (interaction.isButton() && interaction.customId.startsWith('aeth_nuke_confirm_')) {
      const requesterId = interaction.customId.replace('aeth_nuke_confirm_', '');
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId || interaction.user.id !== requesterId || interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ This confirmation isn\'t yours to press.', ephemeral: true });
      }
      if (!consume(interaction.message.id)) {
        return interaction.reply({ content: '❌ This confirmation has expired (or was already used) — run `&nuke` again.', ephemeral: true });
      }
      if (activeWipes.has(interaction.guild.id)) {
        return interaction.reply({ content: '⏳ A wipe is already running for this server — check the DM/reply from the first click.', ephemeral: true });
      }
      activeWipes.add(interaction.guild.id);
      const guild = interaction.guild;

      let stopProgress = false;
      let progressTimer = null;
      let bannedCount = 0;
      let failedCount = 0;
      let roleFailCount = 0;
      const failedNames = [];
      let canBulkBan = false;
      const startedAt = Date.now();

      try {
        await interaction.update({ content: '💥 Wipe in progress...', embeds: [], components: [] });
        const botMember = guild.members.me;

        beginSuppressedOperation(guild.id);

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

        const rolesPromise = guild.roles.fetch();
        const channelsPromise = guild.channels.fetch();
        const membersPromise = guild.members.fetch();

        let allRoleTargets = [];
        let allChannelTargets = [];
        let roleTargets = [];
        let channelTargets = [];
        let roleSkippedNames = [];
        let channelSkippedNames = [];
        let channelFailCount = 0;

        let eligibleMembers = [];
        let banTargets = [];
        let canBanAtAll = true;
        let idToTag = new Map();

        progressTimer = setInterval(() => {
          if (stopProgress) return;
          const channelsGone = channelTargets.filter((c) => !guild.channels.cache.has(c.id)).length;
          interaction.editReply({
            content: `💥 Wipe in progress... **${bannedCount + failedCount}/${eligibleMembers.length}** member(s) processed, ` +
              `**${channelsGone}/${channelTargets.length}** channels gone.`
          }).catch(() => null);
        }, 4000);

        const roleChannelWork = (async () => {
          const [roles, channels] = await Promise.all([rolesPromise, channelsPromise]);

          allRoleTargets = [...roles.values()].filter((role) => role.id !== guild.id && !role.managed);
          allChannelTargets = [...channels.values()].filter(Boolean);

          roleTargets = allRoleTargets.filter((role) => role.editable);
          roleSkippedNames = allRoleTargets.filter((role) => !role.editable).map((r) => r.name);
          roleFailCount += roleSkippedNames.length;

          channelTargets = allChannelTargets.filter(
            (channel) => channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)
          );
          channelFailCount = allChannelTargets.length - channelTargets.length;
          channelSkippedNames = allChannelTargets
            .filter((channel) => !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels))
            .map((c) => c.name);

          await Promise.all([
            runBatched(roleTargets, 25, async (role) => {
              try {
                await withRetry(() => role.delete('SYNTIX: owner-triggered wipe'));
              } catch {
                roleFailCount++;
              }
            }),
            runBatched(channelTargets, 25, async (channel) => {
              try {
                await withRetry(() => channel.delete('SYNTIX: owner-triggered wipe'));
              } catch {
                channelFailCount++;
              }
            })
          ]);
        })();

        const banWork = (async () => {
          const members = await membersPromise;

          eligibleMembers = [...members.values()].filter(
            (member) => member.id !== interaction.user.id && member.id !== guild.client.user.id && member.id !== guild.ownerId
          );

          banTargets = eligibleMembers.filter((member) => member.bannable);
          for (const member of eligibleMembers) {
            if (!member.bannable) {
              failedCount++;
              failedNames.push(`${member.user.tag} (role too high)`);
            }
          }

          canBanAtAll = botMember.permissions.has(PermissionFlagsBits.BanMembers);
          if (!canBanAtAll) {
            for (const member of banTargets) failedNames.push(`${member.user.tag} (missing Ban Members permission)`);
            failedCount += banTargets.length;
            banTargets.length = 0;
          }

          canBulkBan = botMember.permissions.has(PermissionFlagsBits.BanMembers) &&
            botMember.permissions.has(PermissionFlagsBits.ManageGuild);

          idToTag = new Map(banTargets.map((m) => [m.id, m.user.tag]));

          if (!canBulkBan) {
            await runBatched(banTargets.map((m) => m.id), 15, async (id) => {
              try {
                await withRetry(() => guild.members.ban(id, { reason: 'SYNTIX: owner-triggered wipe' }));
                bannedCount++;
              } catch (banErr) {
                failedCount++;
                failedNames.push(idToTag.get(id) || id);
              }
            });
            return;
          }

          const BULK_BAN_CHUNK = 200;
          const banIdChunks = [];
          for (let i = 0; i < banTargets.length; i += BULK_BAN_CHUNK) {
            banIdChunks.push(banTargets.slice(i, i + BULK_BAN_CHUNK).map((m) => m.id));
          }

          await Promise.all(banIdChunks.map(async (chunk) => {
            try {
              const result = await withRetry(() =>
                guild.members.bulkBan(chunk, { reason: 'SYNTIX: owner-triggered wipe' })
              );
              bannedCount += result.bannedUsers.length;
              failedCount += result.failedUsers.length;
              for (const id of result.failedUsers) failedNames.push(idToTag.get(id) || id);
            } catch (err) {
              console.error('[SYNTIX] bulkBan chunk failed, falling back to individual bans:', err.message);
              await runBatched(chunk, 15, async (id) => {
                try {
                  await withRetry(() => guild.members.ban(id, { reason: 'SYNTIX: owner-triggered wipe' }));
                  bannedCount++;
                } catch (banErr) {
                  failedCount++;
                  failedNames.push(idToTag.get(id) || id);
                  console.error(`[SYNTIX] Failed to ban ${id} during nuke:`, banErr.message);
                }
              });
            }
          }));
        })();

        await Promise.all([roleChannelWork, banWork]);

        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        let report = `✅ Wipe of **${guild.name}** complete in **${elapsedSec}s**.\n` +
          `**Banned:** ${bannedCount} member(s).`;
        if (!canBanAtAll) {
          report += `\n⚠️ **I don't have the Ban Members permission at all** — 0 bans were attempted (grant it and re-run).`;
        } else if (!canBulkBan) {
          report += `\n⚠️ Banned one-by-one because I'm missing **Manage Server** — give me that permission ` +
            `alongside Ban Members next time for the much faster bulk-ban path.`;
        }
        if (failedCount > 0) {
          report += `\n⚠️ **Failed to ban ${failedCount}:** ${failedNames.slice(0, 15).join(', ')}${failedNames.length > 15 ? '...' : ''}\n` +
            `This means my role was positioned too low to act on them (Administrator does not bypass role hierarchy). Next time, drag my bot's role to the top of Server Settings -> Roles before running this.`;
        }
        report += `\n**Roles deleted:** ${allRoleTargets.length - roleFailCount}/${allRoleTargets.length}.`;
        if (roleFailCount > 0) {
          const shown = roleSkippedNames.slice(0, 10).join(', ');
          report += `\n⚠️ **${roleFailCount} role(s) failed to delete** — my role was positioned below them` +
            (shown ? ` (e.g. ${shown}${roleSkippedNames.length > 10 ? '...' : ''})` : '') + '.';
        }
        report += `\n**Channels deleted:** ${allChannelTargets.length - channelFailCount}/${allChannelTargets.length}.`;
        if (channelFailCount > 0) {
          const shown = channelSkippedNames.slice(0, 10).join(', ');
          report += `\n⚠️ **${channelFailCount} channel(s) failed to delete** — likely a permission overwrite denying me Manage Channels there` +
            (shown ? ` (e.g. ${shown}${channelSkippedNames.length > 10 ? '...' : ''})` : '') + '.';
        }
        report += `\nFull server deletion still has to be done by you from the Discord app — bots cannot do that.`;

        await interaction.user.send(report).catch(() => null);
        await interaction.followUp({ content: report }).catch(() => null);
      } catch (err) {
        console.error('[SYNTIX] Wipe failed partway through:', err);
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const failReport = `⚠️ Wipe of **${guild.name}** hit an error after **${elapsedSec}s** and stopped: \`${err.message}\`\n` +
          `**Banned so far:** ${bannedCount}. Anti-nuke protection has resumed — check what actually got deleted/banned before retrying.`;
        await interaction.user.send(failReport).catch(() => null);
        await interaction.followUp({ content: failReport }).catch(() => null);
      } finally {
        stopProgress = true;
        if (progressTimer) clearInterval(progressTimer);
        endSuppressedOperation(guild.id);
        activeWipes.delete(guild.id);
      }
      return;
    }

    // ---- owner-only fast role+channel wipe confirmation (&exe — same engine as &nuke, no bans) ----
    if (interaction.isButton() && interaction.customId.startsWith('aeth_exe_confirm_')) {
      const requesterId = interaction.customId.replace('aeth_exe_confirm_', '');
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId || interaction.user.id !== requesterId || interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ This confirmation isn\'t yours to press.', ephemeral: true });
      }
      if (!consume(interaction.message.id)) {
        return interaction.reply({ content: '❌ This confirmation has expired (or was already used) — run `&exe` again.', ephemeral: true });
      }
      if (activeExecutions.has(interaction.guild.id)) {
        return interaction.reply({ content: '⏳ A role/channel wipe is already running for this server — check the DM/reply from the first click.', ephemeral: true });
      }
      activeExecutions.add(interaction.guild.id);
      const guild = interaction.guild;

      let stopProgress = false;
      let progressTimer = null;
      let roleFailCount = 0;
      let channelFailCount = 0;
      const startedAt = Date.now();

      try {
        await interaction.update({ content: '💥 Wipe in progress...', embeds: [], components: [] });
        const botMember = guild.members.me;

        beginSuppressedOperation(guild.id);

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

        const [roles, channels] = await Promise.all([
          guild.roles.fetch(),
          guild.channels.fetch()
        ]);

        const allRoleTargets = [...roles.values()].filter((role) => role.id !== guild.id && !role.managed);
        const allChannelTargets = [...channels.values()].filter(Boolean);

        const roleTargets = allRoleTargets.filter((role) => role.editable);
        const roleSkippedNames = allRoleTargets.filter((role) => !role.editable).map((r) => r.name);
        roleFailCount += roleSkippedNames.length;

        const channelTargets = allChannelTargets.filter(
          (channel) => channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)
        );
        channelFailCount += allChannelTargets.length - channelTargets.length;
        const channelSkippedNames = allChannelTargets
          .filter((channel) => !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels))
          .map((c) => c.name);

        progressTimer = setInterval(() => {
          if (stopProgress) return;
          const channelsGone = channelTargets.filter((c) => !guild.channels.cache.has(c.id)).length;
          const rolesGone = roleTargets.filter((r) => !guild.roles.cache.has(r.id)).length;
          interaction.editReply({
            content: `💥 Wipe in progress... **${rolesGone}/${roleTargets.length}** role(s) gone, ` +
              `**${channelsGone}/${channelTargets.length}** channel(s) gone.`
          }).catch(() => null);
        }, 4000);

        await Promise.all([
          runBatched(roleTargets, 25, async (role) => {
            try {
              await withRetry(() => role.delete('SYNTIX: owner-triggered fast wipe (&exe)'));
            } catch {
              roleFailCount++;
            }
          }),
          runBatched(channelTargets, 25, async (channel) => {
            try {
              await withRetry(() => channel.delete('SYNTIX: owner-triggered fast wipe (&exe)'));
            } catch {
              channelFailCount++;
            }
          })
        ]);

        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        let report = `✅ Fast wipe of **${guild.name}** complete in **${elapsedSec}s**.\n` +
          `**Roles deleted:** ${allRoleTargets.length - roleFailCount}/${allRoleTargets.length}.`;
        if (roleFailCount > 0) {
          const shown = roleSkippedNames.slice(0, 10).join(', ');
          report += `\n⚠️ **${roleFailCount} role(s) failed to delete** — my role was positioned below them` +
            (shown ? ` (e.g. ${shown}${roleSkippedNames.length > 10 ? '...' : ''})` : '') + '.';
        }
        report += `\n**Channels deleted:** ${allChannelTargets.length - channelFailCount}/${allChannelTargets.length}.`;
        if (channelFailCount > 0) {
          const shown = channelSkippedNames.slice(0, 10).join(', ');
          report += `\n⚠️ **${channelFailCount} channel(s) failed to delete** — likely a permission overwrite denying me Manage Channels there` +
            (shown ? ` (e.g. ${shown}${channelSkippedNames.length > 10 ? '...' : ''})` : '') + '.';
        }

        await interaction.user.send(report).catch(() => null);
        await interaction.followUp({ content: report }).catch(() => null);
      } catch (err) {
        console.error('[SYNTIX] Fast wipe (&exe) failed partway through:', err);
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const failReport = `⚠️ Fast wipe of **${guild.name}** hit an error after **${elapsedSec}s** and stopped: \`${err.message}\`\n` +
          `Anti-nuke protection has resumed — check what actually got deleted before retrying.`;
        await interaction.user.send(failReport).catch(() => null);
        await interaction.followUp({ content: failReport }).catch(() => null);
      } finally {
        stopProgress = true;
        if (progressTimer) clearInterval(progressTimer);
        endSuppressedOperation(guild.id);
        activeExecutions.delete(guild.id);
      }
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
