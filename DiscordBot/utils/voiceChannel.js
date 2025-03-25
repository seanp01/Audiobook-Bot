const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const { Client } = require('smb2');
const fs = require('fs');
const path = require('path');

const smbClient = new Client({
  share: 'Audiobooks',
  username: process.env.SMB_USERNAME,
  password: process.env.SMB_PASSWORD,
  domain: process.env.SMB_DOMAIN,
  host: '10.0.0.55',
});

let connection = null;
let currentPosition = 0;

async function joinUserVoiceChannel(interaction) {
  const member = interaction.member;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    return interaction.reply('You need to be in a voice channel to use this command!');
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  return interaction.reply(`Joined ${voiceChannel.name}`);
}

async function playAudiobook(filePath) {
  const resource = createAudioResource(filePath);
  const player = createAudioPlayer();

  player.play(resource);
  connection.subscribe(player);

  player.on('finish', () => {
    console.log('Finished playing the audiobook.');
  });

  player.on('error', error => {
    console.error(`Error: ${error.message}`);
  });
}

async function splitAudiobook(filePath) {
  // Logic to split the mp4 audiobook into mp3 chapters
  // This function should return an array of file paths for the mp3 chapters
}

async function listAudiobooks() {
  return new Promise((resolve, reject) => {
    smbClient.list('/', (err, files) => {
      if (err) {
        return reject(err);
      }
      const audiobooks = files.filter(file => file.endsWith('.mp4'));
      resolve(audiobooks);
    });
  });
}

module.exports = {
  joinUserVoiceChannel,
  playAudiobook,
  splitAudiobook,
  listAudiobooks,
};