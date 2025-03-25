const { SlashCommandBuilder } = require('@discordjs/builders');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const { getAudiobookFiles, getAudiobook } = require('../utils/smbAccess');
const { splitAudiobook, storeUserPosition } = require('../utils/audioProcessing');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('audiobook')
        .setDescription('Plays an audiobook from the SMB folder'),
    async execute(interaction) {
        const user = interaction.user;
        const member = interaction.member;

        // Check if the user is in a voice channel
        if (!member.voice.channel) {
            return interaction.reply('You need to be in a voice channel to use this command!');
        }

        const voiceChannel = member.voice.channel;

        // Join the voice channel
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        // Retrieve audiobook files from SMB
        const audiobookFiles = await getAudiobookFiles('//10.0.0.55/Audiobooks');
        if (audiobookFiles.length === 0) {
            return interaction.reply('No audiobooks found in the SMB folder.');
        }

        // Select the first audiobook file for simplicity
        const selectedAudiobook = audiobookFiles[0];
        const audiobookPath = await getAudiobook(selectedAudiobook);

        // Split the audiobook into chapters
        const chapters = await splitAudiobook(audiobookPath);

        // Store the user's current position (for example, start at the first chapter)
        storeUserPosition(user.id, 0);

        // Play the first chapter
        const player = createAudioPlayer();
        const resource = createAudioResource(chapters[0]);
        player.play(resource);
        connection.subscribe(player);

        player.on('finish', () => {
            // Handle playing the next chapter or finishing the audiobook
            console.log('Finished playing chapter');
        });

        await interaction.reply(`Now playing: ${selectedAudiobook}`);
    },
};