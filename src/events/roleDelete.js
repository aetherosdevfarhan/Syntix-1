const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildRoleDelete,
  async execute(role) {
    await guard(role.guild, 'roleDelete', AuditLogEvent.RoleDelete, role.id, 'Mass role deletion detected');
  }
};
