const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.GuildRoleCreate,
  async execute(role) {
    await guard(role.guild, 'roleCreate', AuditLogEvent.RoleCreate, role.id, 'Mass role creation detected');
  }
};
