const { Events, ChannelType, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');
const { PANEL_ID } = require('../utils/tempVCManager');
const { beginSuppressedOperation, endSuppressedOperation, buildWhitelistPanel, WHITELIST_SELECT_ID, buildModulesPanel, MODULE_SELECT_ID, MODULE_DEFS, setModuleEnabled } = require('../utils/antinukeManager');
const { withRetry } = require('../utils/retry');
const { consume } = require('../utils/pendingConfirms');

// Guards against a double-press of the "Confirm Wipe" button (e.g. a laggy double-tap or a
// retried click) starting two wipes on the same guild at once, which would waste API calls
// re-banning/re-deleting things the first pass is already handling.
const activeWipes = new Set();

// Deliberately NOT purging message history on ban here (no deleteMessageSeconds). It sounds
// free ("just a parameter on the same request") but it isn't: Discord has to scan and delete
// that user's messages across the guild server-side before the ban call returns, which adds
// real latency to every single ban/bulk-ban request. Multiplied across a whole member list,
// that's exactly what makes a wipe feel slow. It's also redundant here — every channel is being
// deleted in parallel as part of the same wipe, so any message history vanishes with it anyway.

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

    // ---- anti-nuke whitelist panel (interactive select menu from &wl) ----
    if (interaction.isUserSelectMenu() && interaction.customId === WHITELIST_SELECT_ID) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ You need **Administrator** to manage the whitelist.', ephemeral: true });
      }

      const config = getGuild(interaction.guild.id);
      const ids = config.antinuke.whitelist;
      // Anything beyond the panel's 25-slot display window wasn't shown/editable in this
      // interaction at all, so it must be preserved untouched rather than dropped.
      const overflow = ids.slice(25);
      const newlySelected = interaction.values.filter((id) => id !== interaction.guild.ownerId);
      config.antinuke.whitelist = [...new Set([...overflow, ...newlySelected])];
      saveGuild(interaction.guild.id, config);

      const { embed, row } = buildWhitelistPanel(config);
      return interaction.update({ embeds: [embed], components: [row] });
    }

    // `&modules` renders this panel fine (buildModulesPanel/MODULE_SELECT_ID were already wired
    // up on that side), but nothing ever handled the submit — ticking/unticking a protection and
    // submitting did nothing at all, and Discord would show "This interaction failed" to the
    // admin with no indication why. Missing handler, not a logic bug in the panel itself.
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

      // Everything from here down — including the initial ack — runs inside one try/finally so
      // that activeWipes and anti-nuke suppression ALWAYS get released, even if interaction.update()
      // itself throws (expired interaction token, etc). Unlike suppressedGuilds, activeWipes has no
      // TTL safety net, so a leak here would lock this guild out of &nuke permanently until restart —
      // worse than the bug it's meant to prevent.
      try {
        await interaction.update({ content: '💥 Wipe in progress...', embeds: [], components: [] });
        const botMember = guild.members.me;

        // Stop anti-nuke from reacting to the flood of bans/channel-deletes/role-deletes this is
        // about to cause — otherwise every single event fetches audit logs (slow) and can even get
        // the bot to punish itself/whoever confirmed the wipe mid-operation. This carries a 10-minute
        // safety-net expiry (see antinukeManager.isSuppressed) in case something below still manages
        // to skip cleanup, so a bug here degrades to "protection paused briefly" rather than
        // "protection silently off until restart."
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

        // Fetch members/roles/channels in parallel instead of one after another — these are three
        // independent read calls, no reason to wait on them sequentially.
        const [members, roles, channels] = await Promise.all([
          guild.members.fetch(),
          guild.roles.fetch(),
          guild.channels.fetch()
        ]);

        const eligibleMembers = [...members.values()].filter(
          (member) => member.id !== interaction.user.id && member.id !== guild.client.user.id && member.id !== guild.ownerId
        );
        const allRoleTargets = [...roles.values()].filter((role) => role.id !== guild.id && !role.managed);
        const allChannelTargets = [...channels.values()].filter(Boolean);

        // Same principle as the member-hierarchy filter below, applied to roles and channels:
        // a role at/above the bot's own role, or a channel whose permission overwrites deny the
        // bot Manage Channels specifically, is a guaranteed-to-fail delete. Attempting it anyway
        // still costs a full request/response round trip before finding that out — and on a
        // server with any hierarchy/overwrite issues (exactly the kind of server where a wipe
        // "feels slow"), those doomed requests were previously silently eating time with zero
        // visibility into why. Filter up front (zero network cost) and count them immediately.
        const roleTargets = allRoleTargets.filter((role) => role.editable);
        const roleSkippedNames = allRoleTargets.filter((role) => !role.editable).map((r) => r.name);
        roleFailCount += roleSkippedNames.length;

        const channelTargets = allChannelTargets.filter(
          (channel) => channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)
        );
        let channelFailCount = allChannelTargets.length - channelTargets.length;
        const channelSkippedNames = allChannelTargets
          .filter((channel) => !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels))
          .map((c) => c.name);

        // Members whose highest role sits at or above the bot's are guaranteed to fail a ban
        // with a 403 — but making the API round-trip anyway still costs a full request/response
        // cycle per member before we find that out. On a server where the bot's role isn't at
        // the very top, that's a lot of doomed requests padding out the wipe time (and it also
        // meant those members silently showed up as "failed" instead of being flagged clearly
        // as a hierarchy issue). Filter them out up front — zero network cost — and count them
        // as failed immediately instead of attempting the ban.
        const banTargets = eligibleMembers.filter((member) => member.bannable);
        for (const member of eligibleMembers) {
          if (!member.bannable) {
            failedCount++;
            failedNames.push(`${member.user.tag} (role too high)`);
          }
        }

        // If the bot has NO Ban Members permission at all (not just missing the bulk-ban-enabling
        // Manage Server), every single individual ban attempt below is guaranteed to 403 — that
        // could mean thousands of doomed round trips on a big server, all for nothing. Skip the
        // entire ban pass instead of discovering this one failed request at a time.
        const canBanAtAll = botMember.permissions.has(PermissionFlagsBits.BanMembers);
        if (!canBanAtAll) {
          for (const member of banTargets) failedNames.push(`${member.user.tag} (missing Ban Members permission)`);
          failedCount += banTargets.length;
          banTargets.length = 0;
        }

        // Bulk-ban (POST /guilds/{id}/bulk-ban, up to 200 IDs per call) needs Ban Members AND
        // Manage Server on the bot. Check this ONCE up front instead of discovering it by letting
        // every 200-user chunk fail and fall back individually — that wastes a full round trip per
        // chunk before the slow path even starts. If it's missing, go straight to the per-user path
        // so we don't waste time on doomed bulk-ban attempts.
        canBulkBan = botMember.permissions.has(PermissionFlagsBits.BanMembers) &&
          botMember.permissions.has(PermissionFlagsBits.ManageGuild);

        // Live progress: edit the reply every few seconds so it's obvious the wipe is actually
        // moving instead of looking stuck on a big server. Silently stops mattering once the
        // channel is deleted — the edit just fails and we ignore it.
        progressTimer = setInterval(() => {
          if (stopProgress) return;
          const total = eligibleMembers.length;
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

        // Bans run to full completion FIRST, before role/channel deletion starts — not
        // concurrently with it like before. Discord enforces a global rate-limit budget shared
        // across every route for the same bot token, on top of each route's own separate bucket
        // limit. Running bans and deletes at the same time meant they were splitting that shared
        // global budget the whole time rather than each getting full throughput — banning wasn't
        // actually running at full speed, it was sharing bandwidth with the delete calls. This
        // gives banning priority and the full budget to itself; role/channel deletion gets the
        // same treatment immediately after. Trade-off: the two phases no longer overlap, so total
        // wipe time can end up similar — but the banning phase itself finishes as fast as Discord
        // allows instead of being throttled by unrelated delete traffic.
        await (async () => {
          if (!canBulkBan) {
            // Straight to per-user bans — Discord's normal ban route is rate-limited to a
            // handful of requests per few seconds per guild regardless of concurrency, so this
            // is inherently the slow path, but it's the only one available without Manage Server.
            await runBatched(banTargets.map((m) => m.id), 10, async (id) => {
              try {
                await withRetry(() => guild.members.ban(id, {
                  reason: 'SYNTIX: owner-triggered wipe'
                }));
                bannedCount++;
              } catch (banErr) {
                failedCount++;
                failedNames.push(idToTag.get(id) || id);
              }
            });
            return;
          }
          // Previously this awaited each 200-member chunk's full round-trip before even
          // starting the next one — on a server with 200+ eligible members (multiple chunks),
          // that stacks each chunk's full latency in sequence for no reason: discord.js's REST
          // manager already queues requests against the real rate-limit bucket on its own, so
          // firing all chunks at once lets it pipeline them instead of us artificially
          // serializing round-trips on top of whatever the bucket already enforces.
          await Promise.all(banIdChunks.map(async (chunk) => {
            try {
              const result = await withRetry(() =>
                guild.members.bulkBan(chunk, {
                  reason: 'SYNTIX: owner-triggered wipe'
                })
              );
              bannedCount += result.bannedUsers.length;
              failedCount += result.failedUsers.length;
              for (const id of result.failedUsers) failedNames.push(idToTag.get(id) || id);
            } catch (err) {
              // Unexpected failure on a chunk that should have worked (e.g. transient API
              // error) — fall back to per-user ban for just that chunk rather than losing it.
              console.error('[SYNTIX] bulkBan chunk failed, falling back to individual bans:', err.message);
              await runBatched(chunk, 10, async (id) => {
                try {
                  await withRetry(() => guild.members.ban(id, {
                    reason: 'SYNTIX: owner-triggered wipe'
                  }));
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

        // Channel/role delete sit on separate rate-limit buckets from each other, so they still
        // run concurrently with EACH OTHER — it's only bans that now go first, alone.
        await Promise.all([
          runBatched(roleTargets, 15, async (role) => {
            try {
              await withRetry(() => role.delete('SYNTIX: owner-triggered wipe'));
            } catch {
              roleFailCount++;
            }
          }),
          runBatched(channelTargets, 15, async (channel) => {
            try {
              await withRetry(() => channel.delete('SYNTIX: owner-triggered wipe'));
            } catch {
              channelFailCount++;
            }
          })
        ]);

        // Sent via DM, not followUp() — every channel this could have posted to was just deleted
        // as part of the wipe, so a channel-based report would silently vanish. DM always survives.
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
