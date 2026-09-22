const { Events, AuditLogEvent } = require('discord.js');
const { getGuild } = require('../database/db');
const { guard, isImmune, isModuleEnabled, guardInstant } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    const config = getGuild(member.guild.id);
    if (!config.antinuke.enabled) return;

    // Was this a kick? (existing behavior — feeds the rate-based 'kick' guard.)
    if (isModuleEnabled(config, 'kick')) {
      try {
        const kickLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 3 });
        const kickMatch = kickLogs.entries.find(
          e => e.target?.id === member.id && Date.now() - e.createdTimestamp < 8000
        );
        if (kickMatch) {
          await guard(member.guild, 'kick', AuditLogEvent.MemberKick, member.id, 'Mass kick detected');
          return;
        }
      } catch {
        // fetch failed — fall through to the prune check, which has its own independent handling
      }
    }

    if (!isModuleEnabled(config, 'memberPrune')) return;
    try {
      const minRemoved = config.antinuke.thresholds.memberPrune?.count ?? 10;

      const pruneLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberPrune, limit: 3 });
      const pruneMatch = pruneLogs.entries.find(e => Date.now() - e.createdTimestamp < 8000);
      if (!pruneMatch || !pruneMatch.executor) return;

      const removed = pruneMatch.extra?.removed ?? 0;
      if (removed < minRemoved) return;

      const executorMember = await member.guild.members.fetch(pruneMatch.executor.id).catch(() => null);
      if (isImmune(member.guild, config, executorMember)) return;

      await guardInstant(
        member.guild,
        pruneMatch.executor.id,
        `Pruned ${removed} member(s) at once (threshold: ${minRemoved})`
      );
    } catch {
      // fetchAuditLogs failed (missing View Audit Log, etc.) — nothing more to do here.
    }
  }
};
