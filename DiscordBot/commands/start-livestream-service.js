const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
  name: 'start-livestream-service',
  data: new SlashCommandBuilder()
    .setName('start-livestream-service')
    .setDescription('Initiates the livestream service')
}