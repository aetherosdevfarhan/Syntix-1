const { Events, AuditLogEvent } = require('discord.js');
const { guard } = require('../utils/antinukeManager');

module.exports = {
  name: Events.WebhooksUpdate,
  async execute(channel) {
    await guard(channel.guild, 'webhookCreate', AuditLogEvent.WebhookCreate, null, 'Suspicious webhook activity detected');
  }
};
