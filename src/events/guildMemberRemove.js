const { Events, AuditLogEvent } = require('discord.js');
const { getGuild } = require('../database/db');
const { guard, isImmune, isModuleEnabled, guardInstant } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    // Was this a kick? (existing behavior — feeds the rate-based 'kick' guard.)
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
      return;
    }

    // Bug fix: "Anti Member Prune" has existed in the default config since the beginning, and is
    // even shown in /setup-antinuke status, but nothing ever actually checked for a prune — this
    // is the first code that does. A prune doesn't target one specific user, so it can't be
    // detected the same way a kick is; instead we look for a recent MemberPrune audit log entry,
    // which records how many members it removed in `entry.extra.removed`. One prune call already
    // IS the "mass removal" event (unlike a kick, there's nothing to rate-limit across multiple
    // calls), so this fires guardInstant() directly rather than going through the count/window
    // logic in recordAndCheck — the threshold's `count` field is reused here as "minimum members
    // removed to treat as suspicious" instead of "how many times before triggering."
    try {
      const config = getGuild(member.guild.id);
      if (!config.antinuke.enabled || !isModuleEnabled(config, 'memberPrune')) return;
      const minRemoved = config.antinuke.thresholds.memberPrune?.count ?? 10;

      const pruneLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberPrune, limit: 3 });
      const pruneMatch = pruneLogs.entries.find(e => Date.now() - e.createdTimestamp < 8000);
      if (!pruneMatch || !pruneMatch.executor) return;

      const removed = pruneMatch.extra?.removed ?? 0;
      if (removed < minRemoved) return; // small/routine prune — not treated as an attack

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
