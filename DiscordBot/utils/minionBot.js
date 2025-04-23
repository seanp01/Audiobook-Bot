const { processFile, getUserBooksInProgress, loadUserPositions, scheduleUserPositionSaving, getChapterCount, listAudiobooks, findClosestMatch, getFileNameFromTitle, skipAudiobook, retrieveAudiobookFilePaths, selectAudiobookAndRetrievePaths, updateAudiobookCache, getUserPosition, deleteTempFile} = require('./smbAccess');
const { Client, Collection, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, getVoiceConnection, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { v4: uuidv4 } = require('uuid');
require('@discordjs/opus');
const { setInterval, clearInterval } = require('timers');
const { exec, spawn, fork, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');

// Retrieve minionId and minionToken from command-line arguments
const [minionId, minionToken] = process.argv.slice(2);

const tempFiles = new Set(); // Track temporary files created by this minion
const audioDurationCache = new Map();
const userCoverImages = new Map();
const chapterDurationCache = new Map(); // Cache for chapter durations
const bookChapterCountCache = new Map(); // Cache for book chapter counts
const userPositionsCache = new Map(); // Cache for user positions
const tempFilenameToOriginalMap = new Map(); // Map temporary file paths to original file paths
const userPositionFilePath = path.join(__dirname, 'userPosition.json');

const dvrAddress = process.env.DVR_ADDRESS;
const dvrPort = process.env.DVR_PORT;
const hostServiceUrl = `http://${dvrAddress}:${dvrPort}`;
const dvrDriveLetter = process.env.LOCAL_DRIVE_LETTER;
const smbDrive = process.env.REMOTE_DRIVE_LETTER || 'Z:'; // Default to Z: drive if not set
const platform = os.platform();
const baseDir = platform === 'win32' 
? `${smbDrive}` // Windows UNC path
: '/mnt/audiobooks'; // Linux mount point

let isUpdatingPlaybackUI = false; // Lock flag for updateSeekUI
let playbackData = null;
let player = null;
let connection = null;
let storeInterval = null;
let syncFileInterval = null;
let updateInterval = null;
let guild = null;
let playbackUiMessage = null; 
let currentAudiobook = null;
let audiobookCache = null; // Cache for audio durations

let initialTimestamp = 0;
let initialPartIndex = 0;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', async () => {
  console.log(`${minionId} is ready!`);
  
  // Disconnect from any voice channels the bot is currently in
  await disconnectFromVoiceChannels();
  audiobookCache = await listAudiobooks(); // Fetch all audiobooks
});

let handlingPlayPause = false;

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isModalSubmit() && interaction.customId === 'seek_modal_submit') {
      const timestampInput = interaction.fields.getTextInputValue('seek_timestamp');
      if (!interaction.deferred) interaction.deferUpdate(); // Acknowledge the interaction immediately
      const titleFile = await findClosestMatch(playbackData.audiobookTitle);

      try {
        // Parse the timestamp (HH:MM:SS)
        const [hours, minutes, seconds] = timestampInput.split(':').map((unit) => parseInt(unit, 10) || 0);
        const seekTimestamp = (hours * 3600 + minutes * 60 + seconds) * 1000; // Convert to milliseconds
        // Ensure the timestamp is within the chapter duration
        const totalChapterDuration = playbackData.chapterParts.reduce(
          (sum, part) => sum + getCachedAudioDuration(path.join(baseDir, titleFile.split('.')[0], path.basename(path.normalize(part)))) * 1000,
          0
        );
        if (seekTimestamp < 0 || seekTimestamp > totalChapterDuration) {
          await interaction.followUp({ content: 'Invalid timestamp. Please enter a valid time within the chapter.', ephemeral: true });
          return;
        }
  
        // Parse the seekTimestamp into the correct chapter part index and relative timestamp
        let cumulativeDuration = 0;
        let targetPartIndex = 0;
        let relativeTimestamp = 0;
        if (playbackData.chapterParts.length > 1) {
            for (let i = 0; i < playbackData.chapterParts.length; i++) {
            const partDuration = await getCachedAudioDuration(path.join(baseDir, titleFile.split('.')[0], path.basename(path.normalize(playbackData.chapterParts[i])))) * 1000; // Convert to milliseconds
            if (seekTimestamp < cumulativeDuration + partDuration) {
              targetPartIndex = i;
              relativeTimestamp = seekTimestamp - cumulativeDuration; // Calculate the timestamp relative to the start of this part
              break;
            }
            cumulativeDuration += partDuration;
          }
        } else {
          targetPartIndex = 0; // If there's only one part, set the index to 0
          relativeTimestamp = seekTimestamp; // Use the original seek timestamp
        }

        // Ensure a valid part index was found
        if (targetPartIndex === -1) {
          await interaction.followUp({ content: 'Invalid timestamp. Please enter a valid time within the chapter.', ephemeral: true });
          return;
        }

        // Update playbackData to reflect the new part and timestamp
        playbackData.currentPart = targetPartIndex;
        playbackData.currentTimestamp = relativeTimestamp;
        let isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(playbackData.chapterParts[targetPartIndex])));
        let originalFilePath = path.join(baseDir, titleFile.split('.')[0], playbackData.chapterParts[targetPartIndex]);
        if (isTempFile) {
          originalFilePath = path.join(baseDir, titleFile.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(playbackData.chapterParts[targetPartIndex])))));
        }
        // Call handleLocalSeek with the correct part and timestamp
        const newFilePath = await handleTempFileSeek(originalFilePath, relativeTimestamp);

        // Update the chapter part with the new file path
        playbackData.chapterParts[targetPartIndex] = newFilePath;
        await storePosition(); // Store the new position
        await syncPositionsToFile(); // Sync positions to file
        loadUserPositions();

        // Update playback with the new file
        await updatePlayback();

        // Notify the user
        await interaction.followUp({ content: `Seeked to ${formatTimestamp(seekTimestamp)}.`, ephemeral: true });
      } catch (error) {
        console.error('Error handling seek modal submission:', error);
        await interaction.followUp({ content: 'An error occurred while seeking. Please try again.', ephemeral: true });
      }
    }
    // Ensure the interaction is a button or select menu interaction
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    if (interaction.isStringSelectMenu()) {
      const { customId, values } = interaction;

      if (customId.startsWith('chapter_select_')) { 
        if (!interaction.deferred) interaction.deferUpdate(); // Acknowledge the interaction immediately
        const selectedChapter = parseInt(values[0], 10); // Get the selected chapter
        console.log(`User selected Chapter ${selectedChapter}`);

        // Update playback data and load the selected chapter
        playbackData.currentChapter = selectedChapter - 1; // Adjust for 0-based index
        playbackData.currentPart = 0;
        playbackData.currentTimestamp = 0;
        playbackData.seekOffset = 0; // Reset the seek offset

        // Load the selected chapter
        await loadChapter();

        // Acknowledge the interaction
        if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate(); // Acknowledge the interaction without sending a visible reply
        return;
      } else if (customId === 'speed_select') {
        if (!interaction.deferred) interaction.deferUpdate(); // Acknowledge the interaction immediately
        const selectedSpeed = parseFloat(values[0]); // Get the selected speed value
        console.log(`User selected speed: ${selectedSpeed}x`);
        const newFilePath = await handleSpeedChange(selectedSpeed);
        let part = 0;
        if (playbackData.chapterParts.length > 1) {
          part = playbackData.currentPart;
        } 
        playbackData.chapterParts[part] = newFilePath;
        playbackData.speed = selectedSpeed; // Store the selected speed in playbackData
        await updatePlayback();
        return;
      }
    }

    if (interaction.isButton()) {
      const command = interaction.customId;
      if (command === 'seek_modal') {
        let fileName = path.basename(path.normalize(await findClosestMatch(playbackData.audiobookTitle)));

        let { outputPaths, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1);
        if (!outputPaths || outputPaths.length === 0) {
          playbackData.currentChapter += 1 // Increment the chapter number
          ({ outputPaths, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
        } 

        // Calculate the progress
        const partDurations = await parseAudioFileLengths(outputPaths);
        const isChapterDurationCached = chapterDurationCache.has(playbackData.currentChapter);
        const totalChapterDuration = isChapterDurationCached ? chapterDurationCache.get(playbackData.currentChapter) : partDurations.reduce((sum, duration) => sum + duration, 0);
        if (!isChapterDurationCached) chapterDurationCache.set(playbackData.currentChapter, totalChapterDuration); // Cache the chapter duration
      
        const modal = new ModalBuilder()
          .setCustomId('seek_modal_submit')
          .setTitle('Seek to Timestamp')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('seek_timestamp')
                .setLabel(`Enter a timestamp within ${formatTimestamp(totalChapterDuration)}`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('HH:MM:SS')
                .setRequired(true)
            )
          );
    
        await interaction.showModal(modal);
        return;
      }
      // Acknowledge the interaction immediately to prevent "This interaction failed" errors
      if (!interaction.deferred && !interaction.replied) {
        try {
          await interaction.deferUpdate(); // Acknowledge the interaction without sending a visible reply
        } catch (error) {
          console.error('Error acknowledging interaction');
        }
      }
      if (command.startsWith('play_pause_')) {
        if (handlingPlayPause) return; // Prevent multiple play/pause actions
        handlingPlayPause = true; // Set the lock
        if (userPositionsCache.keys().length === 0) await loadUserPositionsCache(); // Load user positions if not already loaded
        try {        
          // Check if the playback UI message is in memory
          const isMessageInMemory = progressBarMessage && progressBarMessage.id === interaction.message.id;
      
          // Check if the player exists
          let isPlayerActive = false;
          if (player) {
            isPlayerActive = player.state.status !== AudioPlayerStatus.AutoPaused;
            if (!isPlayerActive) {
              player = null;
            }
          }
      
          if (isMessageInMemory && isPlayerActive) {
            // Resume playback
            if (player.state.status === AudioPlayerStatus.Playing) {
              await handlePlaybackControl('pause');
            } else if (player.state.status === AudioPlayerStatus.Paused) {
              await handlePlaybackControl('play');
            }
            return;
          }
          // Extract metadata from the seek UI message

          currentAudiobook = command.replace('play_pause_', ''); // Extract the book title from the embed
          currentAudiobook = currentAudiobook.replace(/_/g, ' '); // Replace underscores with spaces
          const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
          if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks
          currentAudiobook = audiobooks.find(ab => ab.title.toLowerCase().includes(currentAudiobook.toLowerCase()))?.title.split(':')[0];
          const userPosition = getUserPosition(interaction.user.id, currentAudiobook);
          await interaction.channel.send(`Loading ${currentAudiobook}... Please Wait`);
      
          let currentChapter = 0;
          let currentPart = 0;
          let currentTimestamp = 0;
      
          if (userPosition) {
            currentTimestamp = userPosition.timestamp;
            currentChapter = userPosition.chapter;
            currentPart = userPosition.part;
          }
      
          // Reconstruct playbackData
          playbackData = {
            userID: interaction.user.id,
            channelID: interaction.channel.id,
            guildID: interaction.guild.id,
            audiobookTitle: currentAudiobook,
            currentChapter: currentChapter,
            currentPart: currentPart,
            currentTimestamp: currentTimestamp, // Default to 0 if not stored in the embed
            chapterParts: [], // This will be populated later
            coverImageUrl: null,
            seekOffset: 0,
            author: '',
            speed: 1.0, // Default speed
          };
          
          let fileName = path.basename(path.normalize(await findClosestMatch(currentAudiobook))); // Find the closest match for the audiobook title
          // Retrieve audiobook parts and metadata
          let { outputPaths: chapterParts, originalFilePath, metadata, coverImagePath } = await selectAudiobookAndRetrievePaths(
            currentAudiobook,
            playbackData.currentChapter,
            playbackData.currentPart,
            playbackData.currentTimestamp,
            playbackData.speed // Pass the speed to the function
          );
          if (!chapterParts || chapterParts.length === 0) {
            playbackData.currentChapter += 1 // Increment the chapter number
            ({ outputPaths: chapterParts, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
          }
      
          if (!chapterParts || chapterParts.length === 0) {
            console.error('Error: No parts found.');
            return;
          }
          if (chapterParts[playbackData.currentPart] !== path.basename(path.normalize(originalFilePath))) tempFilenameToOriginalMap.set(path.basename(path.normalize(chapterParts[playbackData.currentPart])), path.basename(path.normalize(originalFilePath))); // Map the temp file to the original file
      
          playbackData.chapterParts = chapterParts;
          playbackData.coverImageUrl = getDynamicCoverImageUrl(path.basename(path.normalize(coverImagePath)));
          playbackData.author = metadata.author || 'Unknown Author';
      
          // Create a new player and start playback
          await startPlayback();

          // Create a new playback UI message
          const embedBuilder = new EmbedBuilder()
            .setTitle(currentAudiobook)
            .setAuthor({ name: playbackData.author })
            .setDescription(`Chapter: ${currentChapter} | Part: ${currentPart + 1}`)
            .setColor('#0099ff');
      
          if (playbackData.coverImageUrl) {
            embedBuilder.setThumbnail(playbackData.coverImageUrl);
          }
      
          const channel = client.channels.cache.get(playbackData.channelID);
          if (!channel) {
            console.error(`Channel with ID ${playbackData.channelID} not found.`);
            return;
          }
          clearChannelMessages(channel); // Clear old messages in the channel
          const newMessage = await channel.send({ embeds: [embedBuilder] });
          playbackUiMessage = newMessage;

          await updatePlaybackUI();
          // Set up interval for UI updates
          // if (progressBarMessage) {
          //   //await progressBarMessage.delete().catch(() => null); // Delete the existing progress bar
          //   progressBarMessage = null; // Reset the progress bar message
          // }
          if (updateInterval) clearInterval(updateInterval);
          updateInterval = setInterval(() => {
            updateProgressBar(); // Update the progress bar every second
          }, 1000);
        } catch (error) {
          console.error('Error handling play_pause button:', error);
        } finally {
          handlingPlayPause = false; // Release the lock
        }
        return;
      }
      // Handle the button commands
      switch (command) {
        case 'skip':
          await handleSeekCommand(15000);
          break;

        case 'back':
          await handleSeekCommand(-15000);
          break;

        case 'next':
          await handleNextChapterCommand();
          break;

        case 'prev':
          await handlePreviousChapterCommand();
          break;

        default:
          console.error(`Unknown button interaction: ${command}`);
          break;
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!playbackData) return;

  const userID = playbackData.userID;
  const channelID = playbackData.channelID;

  // Check if the user left the voice channel
  if (oldState.channelId === channelID && newState.channelId !== channelID && userID === newState.id) {
    console.log(`User ${userID} left the voice channel. Ending session.`);
    endSession();
    clearInterval(updateInterval);
    player.stop(); // Stop playback
    player = null; // Clear the player reference
  }
});

let isProcessingPlaybackMessage = false; // Lock for processing playback messages
// Listen for messages from the masterBot
process.on('message', async (message) => {
  if (isProcessingPlaybackMessage) return; // Prevent multiple calls to process playback messages
  isProcessingPlaybackMessage = true; // Set the lock
  try {
    switch (message.type) {
      case 'playback':
        playbackData = message.data;
        currentAudiobook = playbackData.audiobookTitle; // Store the audiobook title
        // Retrieve audiobook parts and metadata
        let { outputPaths, originalFilePath, metadata, coverImagePath } = await selectAudiobookAndRetrievePaths(
          playbackData.audiobookTitle,
          playbackData.currentChapter,
          playbackData.currentPart,
          playbackData.currentTimestamp,
          playbackData.speed ?? 1 // Pass the speed to the function
        );

        if (!outputPaths || outputPaths.length === 0) {
          console.log('No parts found, trying next chapter...', playbackData);
          playbackData.currentChapter += 1 // Increment the chapter number
          const fileName = path.basename(path.normalize(await findClosestMatch(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
          ({ outputPaths, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
        } 

        if (!outputPaths || outputPaths.length === 0) {
          console.error('Error: No parts found.');
          return;
        }
        playbackData.chapterParts = outputPaths;
        if (path.basename(path.normalize(outputPaths[playbackData.currentPart])) !== path.basename(path.normalize(originalFilePath))) tempFilenameToOriginalMap.set(path.basename(path.normalize(outputPaths[playbackData.currentPart])), path.basename(path.normalize(originalFilePath))); // Map the temp file to the original file
        playbackData.coverImageUrl = playbackData.coverImageUrl ?? getDynamicCoverImageUrl(path.basename(path.normalize(coverImagePath)));
        playbackData.author = metadata.author || 'Unknown Author';
        playbackData.seekOffset = 0; // Reset the seek offset

        // Start playback
        await startPlayback();
        await updatePlaybackUI();
        if (progressBarMessage) {
          await progressBarMessage.delete().catch(() => null); // Delete the existing progress bar
          progressBarMessage = null; // Reset the progress bar message
        }
        // Set up interval for UI updates
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(() => {
          updateProgressBar(); // Update the progress bar every second
        }, 1000);
        break;

      default:
        console.error(`Unknown or unsupported message type: ${message.type}`);
    }
  } catch (error) {
    console.error('Error handling message:');
  } finally {
    isProcessingPlaybackMessage = false; // Free the lock
  }
});

process.on('exit', async () => {
  await syncPositionsToFile();
  if (storeInterval) clearInterval(storeInterval);
  if (updateInterval) clearInterval(updateInterval);
  if (syncPositionsToFile) clearInterval(syncPositionsToFile);
  if (connection) {
    connection.destroy();
    console.log('Voice connection destroyed.');
  }

  // Sync positions to file before exiting
  console.log('User positions saved to file before exiting.');

  if (playbackUiMessage) {
    if (player) {
      player.pause();
      await updatePlaybackUI();
      await updateProgressBar();
      player.stop(); // Stop playback
    }
    player = null;
  }

  clearTempFiles();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  // console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  console.error('Unhandled Rejection:');
});

async function endSession() {
  try {
    await syncPositionsToFile();
    clearInterval(syncPositionsToFile);
    if (player) {
      player.pause(); // Pause playback
      await updatePlaybackUI();
      await updateProgressBar();
      player.stop(); // Stop playback
    } 
    // Store the current position
    await storePosition();
    setBotStatus(); // Set the bot status to the audiobook title

    playbackData = null; // Clear playback data
    chapterDurationCache.clear(); // Clear the chapter duration cache 
    if (connection) {
      console.log('Destroying voice connection...');
      connection.destroy();
      connection = null;
      console.log('Voice connection destroyed.');
    }
    console.log('Session ended by the user.');
  } catch (error) {
    console.error('Error ending session:', error);
  }
}

async function setBotStatus(audiobookTitle) {
  try {
    if (audiobookTitle) client.user.setActivity(`Listening to: ${audiobookTitle}`, { type: 'LISTENING' });
    else client.user.setActivity('Idle', { type: 'PLAYING' });
    console.log(`Bot status updated to: Listening to ${audiobookTitle}`);
  } catch (error) {
    console.error('Error setting bot status:', error);
  }
}

let isStartingPlayback = false; // Lock for startPlayback

async function startPlayback() {
  if (isStartingPlayback) return; // Prevent multiple calls to startPlayback
  isStartingPlayback = true; // Set the lock
  if (syncFileInterval) clearInterval(syncFileInterval);
  syncFileInterval = setInterval(async () => {
    await syncPositionsToFile();
  }, 60000); // Store position every second
  bookChapterCountCache.set(playbackData.audiobookTitle, await getChapterCount(playbackData.audiobookTitle)); // Cache the chapter count
  setBotStatus(playbackData.audiobookTitle); // Set the bot status to the audiobook title
  try {
    const { chapterParts, currentPart, channelID, guildID } = playbackData;

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No chapter parts available for playback.');
      return;
    }

    let part = currentPart;

    if ((currentPart < 0 || currentPart > chapterParts.length) && chapterParts.length > 1) {
      console.error('Invalid part index.');
      return;
    } else if (chapterParts.length == 1) {
      part = 0;
    }

    chapterDurationCache.clear(); // Clear the chapter duration cache when starting playback

    // if the file has a map pairing, it is a temp file. Otherwise, it is the original
    //const bookFileName = await findClosestMatch(playbackData.audiobookTitle);
    //const filePath = path.join(bookFileName.split('.')[0], tempFilenameToOriginalMap.get(path.basename(chapterParts[currentPart]))) || chapterParts[currentPart];
    //const audiobookDir = path.join(baseDir, bookFileName.split('.')[0]);
    // Call the /process endpoint to process the current part
    //const { tempFilePath, originalFilePath } = await processFile(filePath, 0, 1, 'resume');

    // Map the temp file to the original file
    //let newTempFilePath = path.join(baseDir, 'temp', path.basename(tempFilePath));
    //if (path.basename(tempFilePath) == path.basename(originalFilePath)) newTempFilePath = path.join(audiobookDir, path.basename(originalFilePath)); // If the temp file is the same as the original, use the original name
    //lse tempFilenameToOriginalMap.set(path.basename(newTempFilePath), path.basename(originalFilePath)); // Map the temp file to the original file

    // Update the chapter part with the new temp file path
    //chapterParts[part] = newTempFilePath;

    //preloadNextPart(part, chapterParts);

    // Create the connection if it doesn't exist
    if (!connection) {
      await connectToVoiceChannel(channelID, guildID);
    }

    // Create the player if it doesn't exist
    if (!player) {
      createPlayer();
    }

    // Create the audio resource and play it
    const fileName = await findClosestMatch(playbackData.audiobookTitle); // Find the closest match for the audiobook title
    const isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[part])));
    let filePath = '';

    if (isTempFile) {
      filePath = path.join(baseDir, 'temp', path.basename(path.normalize(chapterParts[part])));
    } else {
      filePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(chapterParts[part])));
    }
    const resource = createAudioResource(filePath, {
      inlineVolume: true,
      inputType: StreamType.Arbitrary,
    });
    await player.play(resource);
    await connection.subscribe(player);
    console.log(`Playing part ${part + 1} of chapter ${playbackData.currentChapter}.`);
  } catch (error) {
    console.error('Error starting playback:', error);
  } finally {
    isStartingPlayback = false; // Release the lock
  }
}

let isUpdatingPlayback = false; // Lock for updatePlaybackUI

async function updatePlayback() {
  if (isUpdatingPlayback) return;
  else isUpdatingPlayback = true; // Set the lock
  try {
    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No chapter parts available for playback.');
      return;
    }
    const fileName = await findClosestMatch(playbackData.audiobookTitle); 
    const file = chapterParts.length > 1 ? path.basename(path.normalize(chapterParts[currentPart])) : path.basename(path.normalize(chapterParts[0]));
    const isTempFile = tempFilenameToOriginalMap.has(file);
    let filePath = path.join(baseDir, fileName.split('.')[0], file);
    if (isTempFile) {
      filePath = path.join(baseDir, 'temp', file);
    }

    const resource = createAudioResource(filePath, {
      inlineVolume: true,
      inputType: StreamType.Arbitrary,
    });
    await player.play(resource);
    await connection.subscribe(player);
    await updatePlaybackUI();
    await updateProgressBar();
  } catch (error) {
    console.error('Error updating playback:', error);
  } finally {
    isUpdatingPlayback = false; // Release the lock
  }
}

async function loadChapter() {
  try {
    const { audiobookTitle, currentChapter } = playbackData;

    // Retrieve the new chapter parts
    const { outputPaths: chapterParts, originalFilePath, metaData, coverImagePath } = await selectAudiobookAndRetrievePaths(
      audiobookTitle,
      currentChapter,
      0,
      0,
      playbackData.speed // Pass the speed to the function
    );

    if (!chapterParts || chapterParts.length === 0) {
      playbackData.currentChapter += 1 // Increment the chapter number
      const fileName = path.basename(path.normalize(await findClosestMatch(audiobookTitle))); // Find the closest match for the audiobook title
      ({ outputPaths: chapterParts, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
    }

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No parts found for the selected chapter.');
      return;
    }

    playbackData.chapterParts = chapterParts;
    playbackData.currentPart = 0;
    playbackData.currentTimestamp = 0;

    console.log(`Loaded chapter ${currentChapter}.`);
    await updatePlayback();
  } catch (error) {
    console.error('Error loading chapter:', error);
  }
}

async function handleNextPart() {
  const { chapterParts, currentPart, currentChapter, audiobookTitle, speed } = playbackData;
  let thisChapterParts = chapterParts;
  let thisPartIndex = currentPart;
  const isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[currentPart])));
  if (isTempFile) {
    const fileName = path.basename(path.normalize(await findClosestMatch(audiobookTitle))); // Find the closest match for the audiobook title
    let { outputPaths } = await retrieveAudiobookFilePaths(fileName, currentChapter, currentPart, 0, speed); // Retrieve the chapter parts
    thisChapterParts = outputPaths;
    thisPartIndex = outputPaths.findIndex(part => part === path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(chapterParts[currentPart]))))));
  }

  if (thisPartIndex < thisChapterParts.length - 1) {
    try {
      let { outputPaths, originalFilePath, metaData, coverImagePath } = await selectAudiobookAndRetrievePaths(
        audiobookTitle,
        currentChapter,
        currentPart + 1,
        0, 
        speed
      );
      if (!outputPaths || outputPaths.length === 0) {
        console.error(`No parts found for chapter ${playbackData.currentChapter}.`);
        console.log('Playback has reached the end of the audiobook.');
        return;
      }

      playbackData.chapterParts = outputPaths;

    } catch (error) {
      console.error('Error loading the next chapter:', error);
    }
    
    playbackData.currentPart += 1;
    playbackData.currentTimestamp = 0;
    if (!player) await startPlayback();
    else await updatePlayback(); // Start playback for the new part
    await updatePlaybackUI();
    // Set up interval for UI updates
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      updateProgressBar(); // Update the progress bar every second
    }, 1000);
  } else {
    // End of the current chapter, move to the next chapter

    playbackData.currentChapter += 1; // Increment the chapter number
    playbackData.currentPart = 0; // Reset to the first part of the new chapter
    playbackData.currentTimestamp = 0; // Reset the timestamp

    try {
      // Load the next chapter
      let { outputPaths, originalFilePath, metaData, coverImagePath } = await selectAudiobookAndRetrievePaths(
        audiobookTitle,
        playbackData.currentChapter,
        0,
        0, 
        speed
      );

      if (!outputPaths || outputPaths.length === 0) {
        playbackData.currentChapter += 1 // Increment the chapter number
        const fileName = await path.basename(path.normalize(findClosestMatch(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
        ({ outputPaths, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
      } 

      if (!outputPaths || outputPaths.length === 0) {
        console.error(`No parts found for chapter ${playbackData.currentChapter}.`);
        console.log('Playback has reached the end of the audiobook.');
        return;
      }

      playbackData.chapterParts = outputPaths;

      await updatePlayback(); // Start playback for the new chapter
    } catch (error) {
      console.error('Error loading the next chapter:', error);
    }
  }
}

async function updatePlaybackUI() {
  if (isUpdatingPlaybackUI || !playbackData || isSeekLocked) return;

  isUpdatingPlaybackUI = true; // Set the lock

  try {
    const {
      audiobookTitle = 'Unknown Title',
      currentChapter = 1,
      currentPart = 0,
      coverImageUrl = null,
      author = 'Unknown Author',
      channelID,
    } = playbackData;

    const isPlaying = player && (player.state.status === AudioPlayerStatus.Playing || player.state.status === 'buffering' || player.state.status === AudioPlayerStatus.AutoPaused);
    const playbackState = isPlaying ? '▶️ Playing' : '⏸️ Paused';

    // Create the embed for the playback UI
    const embed = new EmbedBuilder()
      .setTitle(audiobookTitle)
      .setAuthor({ name: author })
      .setDescription(`Chapter: ${currentChapter} | Part: ${currentPart + 1} | Speed: ${playbackData.speed ?? 1}x`)
      .addFields({ name: 'Playback State', value: playbackState })
      .setColor('#0099ff');

    if (coverImageUrl) {
      embed.setThumbnail(coverImageUrl);
    }

    const channel = client.channels.cache.get(channelID);
    if (!channel) {
      console.error(`updatePlaybackUI: Channel with ID ${channelID} not found.`);
      return;
    }

    // Check if the playback UI message exists
    if (playbackUiMessage) {
      try {
        const message = await channel.messages.fetch(playbackUiMessage.id).catch(() => null);
        if (message) {
          // Update the existing playback UI message
          await message.edit({ embeds: [embed] });
        } else {
          // If the message no longer exists, create a new one
          playbackUiMessage = await channel.send({ embeds: [embed] });

          // Delete and resend the progress bar
          if (progressBarMessage) {
            await progressBarMessage.delete().catch(() => null); // Delete the existing progress bar
            progressBarMessage = null; // Reset the progress bar message
          }
          await updateProgressBar(); // Resend the progress bar
        }
      } catch (error) {
        console.error('updatePlaybackUI: Error editing playback UI message:', error);
      }
    } else {
      // If the playback UI message doesn't exist, create a new one
      playbackUiMessage = await channel.send({ embeds: [embed] });

      // Delete and resend the progress bar
      if (progressBarMessage) {
        await progressBarMessage.delete().catch(() => null); // Delete the existing progress bar
        progressBarMessage = null; // Reset the progress bar message
      }
      await updateProgressBar(); // Resend the progress bar
    }
  } catch (error) {
    console.error('updatePlaybackUI: Error occurred:', error);
  } finally {
    isUpdatingPlaybackUI = false; // Release the lock
  }
}

let isUpdatingProgressBar = false; // Lock for updateProgressBar
let progressBarMessage = null; // Track the progress bar message

async function updateProgressBar() {
  if (isUpdatingProgressBar || !playbackData || isSeekLocked) return;

  isUpdatingProgressBar = true; // Set the lock

  try {
    const {
      currentChapter = 1,
      currentPart = 0,
      currentTimestamp = 0,
      chapterParts,
    } = playbackData;

    let part = currentPart;
    if (!chapterParts.length > 1 && !chapterParts[currentPart]) return;
    if (chapterParts.length == 1) part = 0; // If there's only one part, set part to 0
    let durationDifference = 0; // Initialize duration difference

    let fileName = await findClosestMatch(playbackData.audiobookTitle);
    const isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[part])));
    let originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(chapterParts[part])));
    if (isTempFile) {
      originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(chapterParts[part]))))));
      const tempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(chapterParts[part])));
      const originalFileDuration = await getCachedAudioDuration(originalFilePath);
      const tempFileDuration = await getCachedAudioDuration(tempFilePath);
      durationDifference = (originalFileDuration - tempFileDuration) * 1000; // Convert seconds to milliseconds
    }

    // Calculate the progress
    const partDurations = await parseAudioFileLengths(chapterParts);
    const timeToCurrentPartFromChapterStart = chapterParts.length > 1 ? partDurations.slice(0, part).reduce((sum, duration) => sum + duration, 0) : 0;
    const totalTimestamp = currentTimestamp + timeToCurrentPartFromChapterStart;
    const isChapterDurationCached = chapterDurationCache.has(currentChapter);
    const totalChapterDuration = isChapterDurationCached ? chapterDurationCache.get(currentChapter) : partDurations.reduce((sum, duration) => sum + duration, 0) + durationDifference;
    if (!isChapterDurationCached) chapterDurationCache.set(currentChapter, totalChapterDuration); // Cache the chapter duration
    const progressBar = await createPlaybackSeekbarRow(totalTimestamp, totalChapterDuration);

    // Create the embed for the progress bar
    const progressEmbed = new EmbedBuilder()
      .setTitle('Progress')
      .setDescription(`${progressBar}`) // Hidden metadata using spoiler tags
      .addFields(
        { name: 'Current Time', value: formatTimestamp(totalTimestamp), inline: true },
        { name: 'Chapter Duration', value: formatTimestamp(totalChapterDuration), inline: true }
      )
      .setColor('#0099ff');

    const channel = client.channels.cache.get(playbackData.channelID);
    if (!channel) {
      console.error(`updateProgressBar: Channel with ID ${playbackData.channelID} not found.`);
      return;
    }

    const isPlaying = player && player.state.status === AudioPlayerStatus.Playing;
    // Create playback control buttons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('prev')
          .setLabel('⏮️ Previous')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('back')
          .setLabel('↩️ Rewind')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`play_pause_${playbackData.audiobookTitle.replace(' (Unabridged)', '').split(':')[0].replace(/\s+/g, '_')}`) // Include the audiobook title
          .setLabel(isPlaying ? '⏸️ Pause' : '▶️ Play')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('skip')
          .setLabel('↪️ Skip')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('⏭️ Next')
          .setStyle(ButtonStyle.Secondary)
      );

    // Add a button to open the seek modal
    const seekRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('seek_modal')
          .setLabel('Seek to Timestamp')
          .setStyle(ButtonStyle.Primary)
      );

    // Update or create the progress bar message
    if (progressBarMessage) {
      try {
        const message = await channel.messages.fetch(progressBarMessage.id).catch(() => null);
        if (message) {
          await message.edit({ embeds: [progressEmbed], components: [row, seekRow] });
          return;
        }
      } catch (error) {
        console.error('updateProgressBar: Error editing progress bar message:', error);
      }
    }

    // If the message doesn't exist, create a new one
    const newMessage = await channel.send({embeds: [progressEmbed], components: [row], seekRow });
    progressBarMessage = newMessage;
  } catch (error) {
    console.error('updateProgressBar: error - ui update failed\n', error);
  } finally {
    isUpdatingProgressBar = false; // Release the lock
  }
}

let isSeekLocked = false; // Flag to prevent multiple seeks at once

async function handleSeekCommand(skipDuration) {
  if (isSeekLocked) return;
  isSeekLocked = true; // Lock the seek operation
  try {
    playbackData.seekOffset += skipDuration; // Track the seek adjustment

    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    let part = currentPart;
    if (!chapterParts.length > 1 && !chapterParts[currentPart]) return;
    if (chapterParts.length == 1) part = 0; // If there's only one part, set part to 0
    
    let fileName = await findClosestMatch(playbackData.audiobookTitle);
    let isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[part])));
    let originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(chapterParts[part])));
    if (isTempFile) {
      originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(chapterParts[part]))))));
      const tempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(chapterParts[part])));
    }
    const originalFileDuration = await getCachedAudioDuration(originalFilePath) * 1000;

    const seekTimestamp = currentTimestamp + skipDuration;// + playbackData.seekOffset;
    
    if (seekTimestamp > (originalFileDuration - skipDuration) && skipDuration > 0) {
      let part = playbackData.currentPart;
      // handleNextPart checks the chapterParts length and loads the next chapter if needed.
      await handleNextPart();
      return;
    } else if (seekTimestamp < 0) {
      let part = playbackData.currentPart;
      // if the next part after adjusting the part index is less than -1, then we need the last part of the previous chapter.
      if (part - 2 < -1) {
        await handlePreviousChapterCommand();
        let part = playbackData.chapterParts.length - 1;
        playbackData.currentPart = part; // Set to the last part of the previous chapter
        const originalFile = path.basename(path.normalize(playbackData.chapterParts[part]));
        const newOriginalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(originalFile)))
        const seekTimestampForPreviousChapterPart = (await getCachedAudioDuration(newOriginalFilePath) * 1000) + skipDuration;
        const newSeekFilePath = await handleOriginalFileSeek(originalFile, seekTimestampForPreviousChapterPart); // Seek to the end of the last part of the previous chapter
        playbackData.chapterParts[part] = path.normalize(newSeekFilePath);
        await updatePlayback();
        return;
      }
      // handle the next part (part + 1 in the handleNextPart() function) 
      playbackData.currentPart -= 2;
      await handleNextPart();
      return;
    }

    const newFilePath = await handleOriginalFileSeek(originalFilePath, seekTimestamp);
    playbackData.chapterParts[part] = newFilePath;

    // Recalculate durations after the seek
    //const partDurations = await calculateTotalChapterDuration(playbackData.chapterParts);
    //playbackData.totalChapterDuration = partDurations.reduce((sum, duration) => sum + duration, 0);

    // Update playback with the new file
    await updatePlayback();
  } catch (error) {
    console.error('Error handling skip command:', error);
  } finally {
    isSeekLocked = false; // Unlock the seek operation
  }
}

async function handleTempFileSeek(seekFilePath, newTimestamp) {
  try {
    // Retrieve the original file path from the tempToOriginalMap

    const fileName = await findClosestMatch(playbackData.audiobookTitle);
    let isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(seekFilePath)));
    let processFilePath = path.join(fileName.split('.')[0], path.basename(path.normalize(seekFilePath)));
    if (isTempFile) {
      processFilePath = path.join(fileName.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(seekFilePath))))))
    }
    const audiobookDir = path.join(baseDir, fileName.split('.')[0]);
    // Call the /process endpoint to generate the seeked file
    const { tempFilePath } = await processFile(processFilePath, newTimestamp, playbackData.speed || 1, 'seek');
    let newTempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(tempFilePath)));
    if (path.basename(path.normalize(tempFilePath)) == path.basename(path.normalize(processFilePath))) newTempFilePath = path.join(audiobookDir, path.basename(path.normalize(processFilePath))); // If the temp file is the same as the original, use the original name
    else tempFilenameToOriginalMap.set(path.basename(path.normalize(newTempFilePath)), path.basename(path.normalize(processFilePath))); // Map the temp file to the original file

    return newTempFilePath;
  } catch (error) {
    console.error('Error handling local seek:', error);
    throw error;
  }
}

async function handleOriginalFileSeek(originalFilePath, newTimestamp) {
  try {
    const fileName = await findClosestMatch(playbackData.audiobookTitle);
    const audiobookDir = path.join(baseDir, fileName.split('.')[0]);
    // Call the /process endpoint to generate the seeked file
    const { tempFilePath } = await processFile(path.join(fileName.split('.')[0], path.basename(path.normalize(originalFilePath))), newTimestamp, 1, 'seek');
    let newTempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(tempFilePath)));
    // Map the new temp file to the original file
    if (path.basename(path.normalize(tempFilePath)) == path.basename(path.normalize(originalFilePath))) newTempFilePath = path.join(audiobookDir, path.basename(path.normalize(originalFilePath))); // If the temp file is the same as the original, use the original name
    else tempFilenameToOriginalMap.set(path.basename(path.normalize(newTempFilePath)), path.basename(path.normalize(originalFilePath))); // Map the temp file to the original file

    return newTempFilePath;
  } catch (error) {
    console.error('Error handling original file seek:', error);
    throw error;
  }
}

async function handleSpeedChange(speed) {
  try {
    const { chapterParts, currentPart, currentTimestamp } = playbackData;
    const fileName = await findClosestMatch(playbackData.audiobookTitle);
    const audiobookDir = path.join(baseDir, fileName.split('.')[0]);
    // Get the original file 
    let isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[currentPart])));
    let originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(chapterParts[currentPart])));
    if (isTempFile) {
      originalFilePath = path.join(fileName.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(chapterParts[currentPart]))))))
    }
    // Call the /process endpoint to generate the file with the adjusted speed
    const { tempFilePath } = await processFile(originalFilePath, currentTimestamp, speed, 'speed');
    let newTempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(tempFilePath)));
    if (path.basename(path.normalize(tempFilePath)) == path.basename(path.normalize(originalFilePath))) newTempFilePath = path.join(audiobookDir, path.basename(path.normalize(originalFilePath))); // If the temp file is the same as the original, use the original name
    else tempFilenameToOriginalMap.set(path.basename(path.normalize(newTempFilePath)), path.basename(path.normalize(originalFilePath))); // Map the temp file to the original file
    // Map the new temp file to the original file

    return newTempFilePath;
  } catch (error) {
    console.error('Error handling speed change:', error);
    throw error;
  }
}

async function handleNextChapterCommand() {
  try {
    playbackData.currentChapter += 1; // Move to the next chapter
    playbackData.currentPart = 0; // Reset to the first part of the new chapter
    playbackData.currentTimestamp = 0; // Reset the timestamp

    // Load the next chapter
    let { outputPaths: chapterParts } = await selectAudiobookAndRetrievePaths(
      playbackData.audiobookTitle,
      playbackData.currentChapter,
      0,
      0,
      playbackData.speed // Pass the speed to the function
    );

    if (!chapterParts || chapterParts.length === 0) {
      playbackData.currentChapter += 1 // Increment the chapter number
      const fileName = await path.basename(path.normalize(findClosestMatch(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
      ({ outputPaths: chapterParts } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
    }

    if (!chapterParts || chapterParts.length === 0) {
      console.error(`No parts found for chapter ${playbackData.currentChapter}. Trying next.`);
      return;
    }

    playbackData.chapterParts = chapterParts;
    await updatePlayback(); // Start playback for the new chapter
  } catch (error) {
    console.error('Error handling next chapter command:', error);
  }
}

async function handlePreviousChapterCommand() {
  try {
    if (playbackData.currentChapter === 1) {
      console.log('Already at the first chapter. Cannot go back further.');
      return;
    }

    playbackData.currentChapter -= 1; // Move to the previous chapter
    playbackData.currentPart = 0; // Reset to the first part of the new chapter
    playbackData.currentTimestamp = 0; // Reset the timestamp

    // Load the previous chapter
    let { outputPaths: chapterParts, originalFilePath } = await selectAudiobookAndRetrievePaths(
      playbackData.audiobookTitle,
      playbackData.currentChapter,
      0,
      0,
      playbackData.speed // Pass the speed to the function
    );

    if (!chapterParts || chapterParts.length === 0) {
      playbackData.currentChapter -= 1 // Increment the chapter number
      const fileName = await path.basename(path.normalize(findClosestMatch(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
      ({ outputPaths: chapterParts, originalFilePath } = await retrieveAudiobookFilePaths(fileName, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
    }

    if (!chapterParts || chapterParts.length === 0) {
      console.error(`No parts found for chapter ${playbackData.currentChapter}.`);
      return;
    }

    playbackData.chapterParts = chapterParts;
    await updatePlayback(); // Start playback for the new chapter
  } catch (error) {
    console.error('Error handling previous chapter command:', error);
  }
}

async function connectToVoiceChannel(channelId, guildId) {
  try {
    // Retrieve the guild object using the guild ID
    guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.error(`Guild with ID ${guildId} not found.`);
      return;
    }

    // Use the guild's voice adapter creator
    const adapterCreator = guild.voiceAdapterCreator;

    connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator, // Use the adapterCreator from the guild
      selfDeaf: false, // Ensure the bot can hear itself (if needed)
      selfMute: false, // Ensure the bot is not muted
    });
  } catch (error) {
    console.error('Error connecting to voice channel:', error);
  }
}

async function clearTempFiles() {
  setInterval(async () => {
    try {
      if (!playbackData) return; // Exit if playbackData is not available
      guild = client.guilds.cache.get(playbackData.guildID);
      const members = await guild.members.fetch();
      const onlineMembers = members.filter(member => member.presence?.status === 'online');
      const onlineMemberIds = new Set(onlineMembers.map(member => member.user.id));
  
      for (const [userId, tempFiles] of tempFiles.entries()) {
        if (!onlineMemberIds.has(userId)) {
          // User is no longer online, delete their temp files
          for (const tempFile of tempFiles) {
            fs.unlink(tempFile, (err) => {
              if (err) {
                console.error(`Error deleting file ${tempFile}:`, err);
              } else {
                tempFilenameToOriginalMap.delete(path.basename(path.normalize(tempFile))); // Remove the mapping
              }
            });
          }
          tempFiles.delete(userId);
        }
      }
    } catch (error) {
      if (error.code === 'GuildMembersTimeout') {
        console.error('Failed to fetch guild members in time.');
      } else {
        console.error('An error occurred while fetching guild members');
      }
    }
  }, 600000); // Check every 60 seconds
}

async function createPlaybackSeekbarRow(currentPosition, totalDuration) {
  const progressBarLength = 25; // Length of the progress bar
  const progress = Math.abs(Math.floor(((currentPosition) / totalDuration) * progressBarLength));
  const progressBar = '━'.repeat(progress) + '🔘' + '━'.repeat(Math.abs(progressBarLength - progress));
  return progressBar;
}

async function createInfoRow(userID, title, author, chapter, part, timestamp) {
  const coverImagePath = userCoverImages.get(userID); // Get the local file path
  const coverImageUrl = getDynamicCoverImageUrl(path.basename(path.normalize(coverImagePath)));

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setAuthor({ name: author })
    .setDescription(`Chapter: ${chapter} | ${timestamp}`)
    .setColor('#0099ff');

  // Only set the thumbnail if the coverImageUrl is valid
  if (coverImageUrl) {
    embed.setThumbnail(coverImageUrl);
  }

  return embed;
}

async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (err, stdout) => {
        if (err) {
          return reject(err);
        }
        resolve(parseFloat(stdout));
      }
    );
  });
}

async function storePosition() {
  try {
    // Ensure the player is active before proceeding
    if (!player || player.state.status !== AudioPlayerStatus.Playing) {
      return; // Exit if the player is not active
    }
    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks
    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    let part = currentPart;
    if (!chapterParts.length > 1 && !chapterParts[currentPart]) return;
    if (chapterParts.length == 1) part = 0; // If there's only one part, set part to 0
    // Calculate the correct timestamp for seeking

    let durationDifference = 0;

    let fileName = await findClosestMatch(playbackData.audiobookTitle);
    let isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[part])));
    if (isTempFile) {
      const originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(chapterParts[part]))))));
      const tempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(chapterParts[part])));
      const originalFileDuration = await getCachedAudioDuration(originalFilePath);
      const tempFileDuration = await getCachedAudioDuration(tempFilePath);
      durationDifference = (originalFileDuration - tempFileDuration) * 1000; // Convert seconds to milliseconds
    }
    
    // Update the current timestamp based on actual playback duration
    let realTimestamp = durationDifference; // Playback duration in milliseconds
    if (player.state.resource?.playbackDuration) {
      realTimestamp += player.state.resource.playbackDuration; // Playback duration in milliseconds
    }

    playbackData.currentTimestamp = realTimestamp;

    // Update the cached position
    const userID = playbackData.userID;
    let audiobookTitle = audiobooks.find(ab => ab.title.toLowerCase().includes(playbackData.audiobookTitle.toLowerCase()))?.title || playbackData.audiobookTitle;
    audiobookTitle = audiobookTitle.split(':')[0]; // Normalize the title for the cache key
    audiobookTitle = audiobookTitle.replace(' (Unabridged)', '')
    if (!userPositionsCache[userID]) {
      userPositionsCache[userID] = {}; // Initialize the user's data if it doesn't exist
    }

    const userAudiobooks = userPositionsCache[userID];
    userAudiobooks[audiobookTitle] = {
      chapter: playbackData.currentChapter,
      part: playbackData.currentPart,
      timestamp: playbackData.currentTimestamp,
    };
  } catch (error) {
    console.error('storePosition: error - store position failed');
  }
}

async function getCachedAudioDuration(filePath) {
  if (audioDurationCache.has(filePath)) {
    // Return the cached duration if it exists
    return audioDurationCache.get(filePath);
  }

  // Otherwise, call getAudioDuration and cache the result
  const duration = await getAudioDuration(filePath);
  audioDurationCache.set(filePath, duration);
  return duration;
}

async function parseAudioFileLengths(chapterParts) {
  if (!chapterParts || chapterParts.length === 0) {
    return [];
  }
  const fileName = await findClosestMatch(playbackData.audiobookTitle);
  // Calculate the duration of each part
  const partDurations = [];
  for (const part of chapterParts) {
    const isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(part)));
    const normalizedPart = path.normalize(part); // Normalize the path to handle mixed separators
    const partFilePath = isTempFile ? path.join(baseDir, 'temp', path.basename(normalizedPart)) : path.join(baseDir, fileName.split('.')[0], path.basename(normalizedPart));
    const duration = await getCachedAudioDuration(partFilePath);
    partDurations.push(duration * 1000); // Convert seconds to milliseconds
  }

  return partDurations;
}

let isPausing = false;
let isUnpausing = false;
async function handlePlaybackControl(command) {
  try {
    switch (command) {
      case 'pause':
        if (!isPausing && player && player.state.status === AudioPlayerStatus.Playing) {
          isPausing = true;
          player.pause();
          updatePlaybackUI();
          updateProgressBar();
          isPausing = false;
        }
        break;

      case 'play':
        if (player && player.state.status === AudioPlayerStatus.Paused) {
          isUnpausing = true;
          player.unpause();
          updatePlaybackUI();
          updateProgressBar();
          isUnpausing = false;
        }
        break;
      default:
        console.error(`Unknown playback control command: ${command}`);
    }
  } catch (error) {
    console.error('Error handling playback control:', error);
  }
}

async function disconnectFromVoiceChannels() {
  try {
    const voiceConnections = getVoiceConnection(client.guilds.cache.map((guild) => guild.id));
    if (!voiceConnections) return;
    for (const connection of voiceConnections.values()) {
      connection.destroy();
      console.log(`Disconnected from voice channel in guild ${connection.guildId}.`);
    }
  } catch (error) {
    console.error('Error disconnecting from voice channels:', error);
  }
}

let isClearingChannelMessages = false;

async function clearChannelMessages(channel) {
  if (isClearingChannelMessages) {
    return; // Exit if the function is already running
  }
  isClearingChannelMessages = true; // Set the lock
  try {
    let fetchedMessages;
    do {
      // Fetch up to 100 messages at a time
      fetchedMessages = await channel.messages.fetch({ limit: 100 });

      // Filter out messages older than 14 days (bulkDelete limitation) and younger than 24 hours
      const deletableMessages = fetchedMessages.filter(
        (message) => Date.now() - message.createdTimestamp < 14 * 24 * 60 * 60 * 1000 
        && message.createdTimestamp < Date.now() - 1000 * 60 * 60 * 24 
        && playbackUiMessage?.id !== message.id 
        && progressBarMessage?.id !== message.id
      );

      if (deletableMessages.size > 0) {
        await channel.bulkDelete(deletableMessages);
      }

      // Delete older messages individually (if needed)
      for (const message of fetchedMessages.values()) {
        if (Date.now() - message.createdTimestamp >= 14 * 24 * 60 * 60 * 1000         
          && playbackUiMessage?.id !== message.id 
          && progressBarMessage?.id !== message.id) {
          await message.delete();
        }
      }
    } while (fetchedMessages.size > 0);
  } catch (error) {
    console.error('Error clearing channel messages:', error);
  } finally {
    isClearingChannelMessages = false; // Release the lock
  }
}

async function copyTempFileToLocal(tempFilePath, localDir) {
  const fileName = path.basename(path.normalize(tempFilePath));
  const localFilePath = path.join(localDir, fileName);

  return new Promise((resolve, reject) => {
    // Apply the playback speed using the `atempo` filter
    const playbackSpeed = playbackData.speed || 1.0; // Default to 1.0x if not set
    const ffmpeg = spawn('ffmpeg', [
      '-ss', Math.floor((playbackData.currentTimestamp || 0) / 1000), // Convert milliseconds to seconds
      '-i', tempFilePath,
      '-vn',
      '-b:a', '192k',
      '-c:a', 'copy',
      localFilePath,
    ]);
    ffmpeg.on('close', (code) => {
      resolve(localFilePath); // Resolve with the local file path
    });

    ffmpeg.on('error', (error) => {
      reject(error); // Reject on ffmpeg error
    });
  });
}

// Preload the next part of the audiobook
async function preloadNextPart(currentPartIndex, chapterParts, localDir) {
  if (currentPartIndex + 1 < chapterParts.length) {
    const nextPartPath = chapterParts[currentPartIndex + 1];

    try {
      // Copy the temp file to the local directory
      const localFilePath = await copyTempFileToLocal(nextPartPath, localDir);
      console.log(`Preloaded next part: ${localFilePath}`);

      // Delete the temporary file after successfully copying it locally
      //await deleteTempFile(nextPartPath);
      console.log(`Deleted temporary file: ${nextPartPath}`);
    } catch (error) {
      console.error(`Error preloading next part or deleting temp file: ${error.message}`);
    }
  }
}

let isSyncingPositions = false; // Lock for syncPositionsToFile

async function syncPositionsToFile() {
  if (isSyncingPositions) {
    return; // Exit if the function is already running
  }
  isSyncingPositions = true; // Set the lock
  try {
    let existingData = {};

    // Read the existing file data if it exists
    if (fs.existsSync(userPositionFilePath)) {
      const fileData = await fs.readFileSync(userPositionFilePath, 'utf-8').trim();
      if (fileData) {
        try {
          existingData = JSON.parse(fileData);
        } catch (error) {
          console.error('Error parsing existing JSON file. Resetting to an empty object.', error);
          existingData = {}; // Reset to an empty object if the file is invalid
        }
      }
    }

    // Merge the cached data with the existing data
    for (const userID of Object.keys(userPositionsCache)) {
      const userAudiobooks = userPositionsCache[userID];
    
      // Ensure the user exists in existingData
      if (!existingData[userID]) {
        existingData[userID] = {}; // Initialize the user entry
      }
    
      for (const [audiobookTitle, positionData] of Object.entries(userAudiobooks)) {
        if (!audiobookTitle || typeof audiobookTitle !== 'string') {
          console.warn(`Skipping invalid audiobook title for user ${userID}:`, audiobookTitle);
          continue; // Skip invalid titles
        }
    
        // Add or update the audiobook position data
        existingData[userID][audiobookTitle] = positionData;
      }
    }

    // Skip writing if there is no data
    if (Object.keys(existingData).length === 0) {
      console.warn('No data to write. Skipping file update.');
      return;
    }

    // Write the updated data back to the file
    fs.writeFileSync(userPositionFilePath, JSON.stringify(existingData, null, 2));
  } catch (error) {
    console.error('Error syncing positions to file:', error);
} finally {
    isSyncingPositions = false; // Release the lock
  }
}

function validatePlaybackData(data) {
  const requiredFields = [
    'userID',
    'audiobookTitle',
    'chapterParts',
    'currentPart',
    'currentChapter',
    'currentTimestamp',
    'channelID',
    'guildID',
    'coverImageUrl',
    'author',
  ];

  let isValid = true;
  for (const field of requiredFields) {
    if (data[field] === undefined) { // Explicitly check for undefined
      console.error(`Missing required playbackData field: ${field}`);
      isValid = false;
    }
  }
  return isValid;
}

let isCreatePlayerLocked = false; // Lock flag for createPlayer function
let isPausingEventLocked = false; // Lock flag for the Playing event
let isPlayingEventLocked = false; // Lock flag for the Playing event

function createPlayer() {
  if (isCreatePlayerLocked) {
    return; // Exit if the function is already running
  }
  isCreatePlayerLocked = true; // Set the lock
  try {
    // Create a new audio player
    player = createAudioPlayer();

    // Handle playback events 
    player.on(AudioPlayerStatus.Idle, async () => {
      if (isSeekLocked || isUpdatingPlayback || isStartingPlayback || isProcessingPlaybackMessage) return; // Exit if a seek operation is in progress
      await handleNextPart(); // Move to the next part or chapter
    });

    client.on('messageDelete', (message) => {
      if (message.id === playbackUiMessage?.id) {
        playbackUiMessage = null; // Reset the playback UI message if it is deleted
      }
      if (message.id === progressBarMessage?.id) {
        progressBarMessage = null; // Reset the progress bar message if it is deleted
      }
    });

    player.on('error', (error) => {
      console.error('Error with audio player:', error);
    });

  } catch (error) {
    console.error('Error creating audio player:', error);
  } finally {
    isCreatePlayerLocked = false; // Release the lock
  }
}

let inactivityTimeout = null;

function resetInactivityTimeout() {
  if (inactivityTimeout) clearTimeout(inactivityTimeout);

  inactivityTimeout = setTimeout(() => {
    console.log('Session ended due to inactivity.');
    endSession();
  }, 5 * 60 * 1000); // 5 minutes of inactivity
}

function splitChaptersIntoGroups(chapters, groupSize = 25) {
  const groups = [];
  for (let i = 0; i < chapters.length; i += groupSize) {
    groups.push(chapters.slice(i, i + groupSize));
  }
  return groups;
}

const coverArtAddress = process.env.COVER_ART_ADDRESS;
const coverArtPort = process.env.COVER_ART_PORT;
const piAddress = process.env.AUDIOBOOK_PI_ADDRESS;

function getDynamicCoverImageUrl(coverImageFile) {
  coverImageFile = path.basename(path.normalize(path.normalize(coverImageFile))).split('\\').at(-1); // Get the file name without the path
  const baseUrl = `http://${coverArtAddress}:${coverArtPort}/images/`; 
  return `${baseUrl}${coverImageFile}`;
}

async function loadUserPositionsCache() {
  try {
    if (fs.existsSync(userPositionFilePath)) {
      const fileData = fs.readFileSync(userPositionFilePath, 'utf-8');
      if (fileData.trim()) {
        const existingData = JSON.parse(fileData);
        for (const [userID, userAudiobooks] of Object.entries(existingData)) {
          userPositionsCache[userID] = userAudiobooks; // Load the user positions into the cache
        }
      } 
    } 
  } catch (error) {
    console.error('loadUserPositionsCache: Error loading user positions from file:', error);
  }
}

function formatTimestamp(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((unit) => String(unit).padStart(2, '0'))
    .join(':');
}

function throttle(func, limit) {
  let inThrottle = false;
  let timeout;

  const throttled = (...args) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      timeout = setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };

  // Add a cancel method to clear the timer and reset the state
  throttled.cancel = () => {
    clearTimeout(timeout);
    inThrottle = false;
  };

  return throttled;
}

// Clear the cache periodically to free memory
setInterval(() => {
  audioDurationCache.clear();
}, 60 * 60 * 1000); // Clear the cache every hour

if (storeInterval) clearInterval(storeInterval);
storeInterval = setInterval(async () => {
  await storePosition();
}, 1000); // Store position every second

clearTempFiles();
loadUserPositionsCache();

// Log in the minion bot
client.login(minionToken);