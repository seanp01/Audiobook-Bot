const { processFile, getChapterCount, listAudiobooks, findClosestTitleFile, retrieveAudiobookFilePaths, selectAudiobookAndRetrievePaths, getUserPosition, userPositionsCache} = require('./smbAccess');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, ContainerBuilder, TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, getVoiceConnection, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require('@discordjs/voice');
require('@discordjs/opus');
const { setInterval, clearInterval } = require('timers');
const { exec, spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Retrieve minionId and minionToken from command-line arguments
const [minionId, minionToken] = process.argv.slice(2);

const playEmojiID = process.env.PLAY_EMOJI_ID;
const pauseEmojiID = process.env.PAUSE_EMOJI_ID;
const nextEmojiID = process.env.NEXT_EMOJI_ID;
const backEmojiID = process.env.BACK_EMOJI_ID;
const plusFifteenEmojiID = process.env.PLUS_FIFTEEN_EMOJI_ID;
const minusFifteenEmojiID = process.env.MINUS_FIFTEEN_EMOJI_ID;

const tempFiles = new Map(); // Track temporary files by userId
const audioDurationCache = new Map();
const userCoverImages = new Map();
const chapterDurationCache = new Map(); // Cache for chapter durations
const bookChapterCountCache = new Map(); // Cache for book chapter counts
// userPositionsCache is imported from smbAccess.js - don't redeclare it here
const tempFilenameToOriginalMap = new Map(); // Map temporary file paths to original file paths
const userPositionFilePath = path.join(__dirname, 'userPosition.json');

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

const MIN_PLAYBACK_SPEED = 0.25;
const MAX_PLAYBACK_SPEED = 3.0;

function clampPlaybackSpeed(speed) {
  if (!Number.isFinite(speed)) return 1.0;
  return Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, Number(speed.toFixed(2))));
}

function formatPlaybackSpeed(speed) {
  return `${parseFloat(Number(speed).toFixed(2))}x`;
}

function resolveButtonEmoji(emojiValue, fallbackUnicode) {
  if (!emojiValue || typeof emojiValue !== 'string') {
    return fallbackUnicode;
  }

  const trimmedValue = emojiValue.trim();
  const fullCustomEmojiMatch = trimmedValue.match(/^<a?:\w+:(\d{17,20})>$/);
  if (fullCustomEmojiMatch) {
    return { id: fullCustomEmojiMatch[1] };
  }

  if (/^\d{17,20}$/.test(trimmedValue)) {
    return { id: trimmedValue };
  }

  return trimmedValue;
}

function buildPlaybackPanel(title, lines = [], accentColor = 0x5865f2) {
  return new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `### ${title}`,
        ...lines.filter((line) => line !== undefined && line !== null && line !== ''),
      ].join('\n'))
    );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('clientReady', async () => {
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
      if (!interaction.deferred) await interaction.deferUpdate(); // Acknowledge the interaction immediately
      const titleFile = await path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle)));

      try {
        // Parse the timestamp (HH:MM:SS)
        const [hours, minutes, seconds] = timestampInput.split(':').map((unit) => parseInt(unit, 10) || 0);
        const seekTimestamp = (hours * 3600 + minutes * 60 + seconds) * 1000; // Convert to milliseconds
        // Ensure the timestamp is within the chapter duration
        const partDurations = await parseAudioFileLengths(playbackData.chapterParts);
        const totalChapterDuration = partDurations.reduce((sum, duration) => sum + duration, 0);
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
        await syncPositionsToFile(); // Sync positions to file (already reconciles cache with file)

        // Update playback with the new file
        await updatePlayback();

        // Notify the user
        await interaction.followUp({ content: `Seeked to ${formatTimestamp(seekTimestamp)}.`, ephemeral: true });
      } catch (error) {
        console.error('Error handling seek modal submission:', error);
        await interaction.followUp({ content: 'An error occurred while seeking. Please try again.', ephemeral: true });
      }
    } else if (interaction.isModalSubmit() && interaction.customId === 'speed_custom_submit') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const rawSpeedInput = interaction.fields.getTextInputValue('speed_custom_value');
      const parsedSpeed = parseFloat(rawSpeedInput);

      if (!Number.isFinite(parsedSpeed)) {
        await interaction.followUp({ content: 'Invalid speed. Enter a number like 1.15.', ephemeral: true });
        return;
      }

      const clampedSpeed = clampPlaybackSpeed(parsedSpeed);
      await applyPlaybackSpeed(clampedSpeed);
      await interaction.followUp({
        content: `Playback speed set to ${formatPlaybackSpeed(clampedSpeed)}.`,
        ephemeral: true,
      });
      return;
    }
    // Ensure the interaction is a button or select menu interaction
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    if (interaction.isStringSelectMenu()) {
      const { customId, values } = interaction;

      if (customId.startsWith('chapter_select_') || customId === 'chapter_jump') { 
        if (!interaction.deferred) await interaction.deferUpdate(); // Acknowledge the interaction immediately
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
      } else if (customId === 'speed_select' || customId === 'speed_preset_select') {
        if (!interaction.deferred) await interaction.deferUpdate(); // Acknowledge the interaction immediately
        const selectedSpeed = parseFloat(values[0]); // Get the selected speed value
        await applyPlaybackSpeed(selectedSpeed);
        return;
      }
    }

    if (interaction.isButton()) {
      const command = interaction.customId;
      if (command === 'seek_modal') {
        let fileName = path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle)));

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

      if (command === 'speed_custom_modal') {
        const speedModal = new ModalBuilder()
          .setCustomId('speed_custom_submit')
          .setTitle('Set Custom Playback Speed')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('speed_custom_value')
                .setLabel(`Enter speed (${MIN_PLAYBACK_SPEED} - ${MAX_PLAYBACK_SPEED})`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Example: 1.15')
                .setRequired(true)
            )
          );

        await interaction.showModal(speedModal);
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
        if (Object.keys(userPositionsCache).length === 0) loadUserPositionsCache(); // Load user positions if not already loaded
        try {        
          // Check if the playback UI message is in memory
          const isMessageInMemory =
            (progressBarMessage && progressBarMessage.id === interaction.message.id) ||
            (playbackUiMessage && playbackUiMessage.id === interaction.message.id);
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
          playbackUiMessage = null; // Resend the playback UI message
          currentAudiobook = command.replace('play_pause_', '').replaceAll('_', ' ').replace(' (Unabridged)', '').split(':')[0]; // Extract the book title from the embed
          const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
          if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks
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
          
          let fileName = path.basename(path.normalize(await findClosestTitleFile(currentAudiobook))); // Find the closest match for the audiobook title
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

          const channel = client.channels.cache.get(playbackData.channelID);
          if (!channel) {
            console.error(`Channel with ID ${playbackData.channelID} not found.`);
            return;
          }
          await clearChannelMessages(channel); // Clear old playback messages in the channel
          playbackUiMessage = null;

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

        case 'speed_down_10':
          await applyPlaybackSpeed((playbackData.speed ?? 1) - 0.1);
          break;

        case 'speed_down_05':
          await applyPlaybackSpeed((playbackData.speed ?? 1) - 0.05);
          break;

        case 'speed_reset':
          await applyPlaybackSpeed(1.0);
          break;

        case 'speed_up_05':
          await applyPlaybackSpeed((playbackData.speed ?? 1) + 0.05);
          break;

        case 'speed_up_10':
          await applyPlaybackSpeed((playbackData.speed ?? 1) + 0.1);
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
          const fileName = path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
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
    if (audiobookTitle) {
      await client.user.setActivity(`${audiobookTitle}`, { type: ActivityType.Listening });
    } else {
      await client.user.setActivity('Idle', { type: ActivityType.Playing });
    }
  } catch (error) {
    console.error('Error setting bot status:', error);
  }
}

let isStartingPlayback = false; // Lock for startPlayback

async function startPlayback() {
  if (isStartingPlayback) return; // Prevent multiple calls to startPlayback
  if (!playbackData || !playbackData.audiobookTitle) {
    console.error('startPlayback: playbackData or audiobookTitle is undefined');
    return;
  }
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
    //const bookFileName = await findClosestTitleFile(playbackData.audiobookTitle);
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

    // Abort if the connection could not be established
    if (!connection) {
      console.error('startPlayback: Voice connection failed, aborting playback.');
      return;
    }

    // Create the player if it doesn't exist
    if (!player) {
      createPlayer();
    }

    // Create the audio resource and play it
    const fileName = await findClosestTitleFile(playbackData.audiobookTitle); // Find the closest match for the audiobook title
    if (!fileName) {
      console.error(`startPlayback: Could not find audiobook file for title: ${playbackData.audiobookTitle}`);
      return;
    }
    const isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[part])));
    let filePath = '';

    if (isTempFile) {
      filePath = path.join(baseDir, 'temp', path.basename(path.normalize(chapterParts[part])));
    } else {
      filePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(chapterParts[part])));
    }
    // Validate file exists before creating resource
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      return;
    }

    const resource = createAudioResource(filePath, {
      inlineVolume: true,
      inputType: StreamType.Arbitrary,
    });

    connection.subscribe(player);
    player.play(resource);
    console.log(`Playing part ${part + 1} of chapter ${playbackData.currentChapter}.`);
    
    // Store position immediately so book appears in progress list right away
    const userID = playbackData.userID;
    // Use the title directly from playbackData - it's already normalized by bot.js
    const audiobookTitle = playbackData.audiobookTitle;
    if (!userPositionsCache[userID]) {
      userPositionsCache[userID] = {};
    }
    userPositionsCache[userID][audiobookTitle] = {
      chapter: playbackData.currentChapter,
      part: playbackData.currentPart,
      timestamp: playbackData.currentTimestamp || 0,
    };
    
    // Immediately sync to file for cross-process visibility (minions are forked processes)
    // Using local syncPositionsToFile() which merges with file data, not saveUserPositionsToFile()
    await syncPositionsToFile();
  } catch (error) {
    console.error('Error starting playback:', error);
  } finally {
    isStartingPlayback = false; // Release the lock
  }
}

let isUpdatingPlayback = false; // Lock for updatePlaybackUI

async function updatePlayback() {
  if (isUpdatingPlayback) return;
  if (!playbackData || !playbackData.audiobookTitle) {
    console.error('updatePlayback: playbackData or audiobookTitle is undefined');
    return;
  }
  isUpdatingPlayback = true; // Set the lock
  try {
    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No chapter parts available for playback.');
      return;
    }
    const fileName = await findClosestTitleFile(playbackData.audiobookTitle); 
    const file = chapterParts.length > 1 ? path.basename(path.normalize(chapterParts[currentPart])) : path.basename(path.normalize(chapterParts[0]));
    const isTempFile = tempFilenameToOriginalMap.has(file);
    let filePath = path.join(baseDir, fileName.split('.')[0], file);
    if (isTempFile) {
      filePath = path.join(baseDir, 'temp', file);
    }

    // Validate file exists before creating resource
    if (!fs.existsSync(filePath)) {
      console.error(`File not found for playback: ${filePath}`);
      return;
    }

    const resource = createAudioResource(filePath, {
      inlineVolume: true,
      inputType: StreamType.Arbitrary,
    });

    connection.subscribe(player);
    player.play(resource);
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
      let titleFile = path.basename(path.normalize(await findClosestTitleFile(audiobookTitle))); // Find the closest match for the audiobook title
      ({ outputPaths: chapterParts, originalFilePath } = await retrieveAudiobookFilePaths(titleFile, playbackData.currentChapter, 0, 0, 1)); // Retrieve the chapter parts
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
    const fileName = path.basename(path.normalize(await findClosestTitleFile(audiobookTitle))); // Find the closest match for the audiobook title
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
        const fileName = await path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
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

const UI_OPERATION_TIMEOUT_MS = 8000;
const UI_OPERATION_MAX_RETRIES = 3;
const UI_RETRY_BASE_DELAY_MS = 400;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(operation, timeoutMs, label) {
  return Promise.race([
    operation(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function runUiOperationWithRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= UI_OPERATION_MAX_RETRIES; attempt++) {
    try {
      return await withTimeout(operation, UI_OPERATION_TIMEOUT_MS, `${label} (attempt ${attempt})`);
    } catch (error) {
      lastError = error;
      if (attempt < UI_OPERATION_MAX_RETRIES) {
        await delay(UI_RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
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

    let part = currentPart;
    const chapterParts = playbackData.chapterParts || [];
    if (!chapterParts.length > 1 && !chapterParts[currentPart]) return;
    if (chapterParts.length === 1) part = 0;

    let durationDifference = 0;
    if (chapterParts[part]) {
      const fileName = await findClosestTitleFile(playbackData.audiobookTitle);
      if (fileName) {
        const isTempFile = tempFilenameToOriginalMap.has(path.basename(path.normalize(chapterParts[part])));
        let originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(chapterParts[part])));
        if (isTempFile) {
          originalFilePath = path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(tempFilenameToOriginalMap.get(path.basename(path.normalize(chapterParts[part]))))));
          const tempFilePath = path.join(baseDir, 'temp', path.basename(path.normalize(chapterParts[part])));
          const originalFileDuration = await getCachedAudioDuration(originalFilePath);
          const tempFileDuration = await getCachedAudioDuration(tempFilePath);
          durationDifference = (originalFileDuration - tempFileDuration) * 1000;
        }
      }
    }

    const partDurations = await parseAudioFileLengths(chapterParts);
    const timeToCurrentPartFromChapterStart = chapterParts.length > 1 ? partDurations.slice(0, part).reduce((sum, duration) => sum + duration, 0) : 0;
    const totalTimestamp = (playbackData.currentTimestamp || 0) + timeToCurrentPartFromChapterStart;
    const isChapterDurationCached = chapterDurationCache.has(currentChapter);
    const totalChapterDuration = isChapterDurationCached ? chapterDurationCache.get(currentChapter) : partDurations.reduce((sum, duration) => sum + duration, 0) + durationDifference;
    if (!isChapterDurationCached) chapterDurationCache.set(currentChapter, totalChapterDuration);
    const progressBar = await createPlaybackSeekbarRow(totalTimestamp, totalChapterDuration);

    const cardLines = [
      `## ${audiobookTitle}`,
      `**Author:** ${author}`,
      `**Chapter:** ${currentChapter} | **Part:** ${currentPart + 1} | **Speed:** ${playbackData.speed ?? 1}x`,
      `**State:** ${playbackState}`,
      `**Progress:** \`${progressBar}\``,
      `**Time:** ${formatTimestamp(totalTimestamp)} / ${formatTimestamp(totalChapterDuration)}`,
    ];

    const playbackContainer = new ContainerBuilder()
      .setAccentColor(0x0099ff)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(cardLines.join('\n'))
      );

    if (coverImageUrl) {
      playbackContainer.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(coverImageUrl)
        )
      );
    }

    playbackContainer.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Playback Controls')
    );

    // Keep transport controls as a top-level row under the card; embedding them in the container causes the 5-button row to wrap on mobile.
    const controlsRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('prev')
          .setEmoji(resolveButtonEmoji(backEmojiID, '⏮️'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('back')
          .setEmoji(resolveButtonEmoji(minusFifteenEmojiID, '⏪'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`play_pause_${playbackData.audiobookTitle.replace(' (Unabridged)', '').split(':')[0].replace(/\s+/g, '_')}`)
          .setEmoji(isPlaying ? resolveButtonEmoji(pauseEmojiID, '⏸️') : resolveButtonEmoji(playEmojiID, '▶️'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('skip')
          .setEmoji(resolveButtonEmoji(plusFifteenEmojiID, '⏩'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('next')
          .setEmoji(resolveButtonEmoji(nextEmojiID, '⏭️'))
          .setStyle(ButtonStyle.Secondary)
      );

    const seekRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('seek_modal')
          .setLabel('Seek to Timestamp')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('speed_custom_modal')
          .setLabel('Custom Speed')
          .setStyle(ButtonStyle.Primary)
      );

    const speedAdjustRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('speed_down_10')
          .setLabel('-0.10x')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('speed_down_05')
          .setLabel('-0.05x')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('speed_reset')
          .setLabel('1x')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('speed_up_05')
          .setLabel('+0.05x')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('speed_up_10')
          .setLabel('+0.10x')
          .setStyle(ButtonStyle.Secondary)
      );

    const speedPresetRow = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('speed_preset_select')
          .setPlaceholder('Presets')
          .addOptions(
            { label: '0.8x', value: '0.8' },
            { label: '0.9x', value: '0.9' },
            { label: '1.0x', value: '1.0' },
            { label: '1.1x', value: '1.1' },
            { label: '1.25x', value: '1.25' },
            { label: '1.5x', value: '1.5' },
            { label: '2.0x', value: '2.0' }
          )
      );

    const chapterCount = bookChapterCountCache.get(playbackData.audiobookTitle) || 1;
    const currentChapterDisplay = Math.max(1, currentChapter);
    let chapterStart = Math.max(1, currentChapterDisplay - 12);
    let chapterEnd = Math.min(chapterCount, chapterStart + 24);
    chapterStart = Math.max(1, chapterEnd - 24);

    const chapterOptions = [];
    for (let chapterNumber = chapterStart; chapterNumber <= chapterEnd; chapterNumber++) {
      chapterOptions.push({
        label: `Chapter ${chapterNumber}`,
        value: `${chapterNumber}`,
        default: chapterNumber === currentChapterDisplay,
      });
    }

    const chapterJumpRow = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('chapter_jump')
          .setPlaceholder(`Chapter ${chapterStart}-${chapterEnd}`)
          .addOptions(chapterOptions)
      );

    playbackContainer
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### Navigation\nCurrent chapter window: ${chapterParts.length > 0 ? 'active' : 'unavailable'}`
        )
      )
      .addActionRowComponents(seekRow)
      .addActionRowComponents(chapterJumpRow)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### Playback Speed\nCurrent speed: ${formatPlaybackSpeed(playbackData.speed ?? 1)}`
        )
      )
      .addActionRowComponents(speedAdjustRow)
      .addActionRowComponents(speedPresetRow);

    const channel = client.channels.cache.get(channelID);
    if (!channel) {
      console.error(`updatePlaybackUI: Channel with ID ${channelID} not found.`);
      return;
    }

    // Check if the playback UI message exists
    if (playbackUiMessage) {
      try {
        let message = null;
        try {
          message = await runUiOperationWithRetry(
            () => channel.messages.fetch(playbackUiMessage.id),
            'Fetch playback UI message'
          );
        } catch (fetchError) {
          if (fetchError?.code !== 10008) {
            throw fetchError;
          }
        }
        if (message) {
          // Update the existing playback UI message
          await runUiOperationWithRetry(
            () =>
              message.edit({
                flags: MessageFlags.IsComponentsV2,
                components: [playbackContainer, controlsRow],
              }),
            'Edit playback UI message'
          );
        } else {
          // If the message no longer exists, create a new one
          playbackUiMessage = await runUiOperationWithRetry(
            () =>
              channel.send({
                flags: MessageFlags.IsComponentsV2,
                components: [playbackContainer, controlsRow],
              }),
            'Send playback UI message'
          );

          // Delete old progress-bar-only message when switching to combined UI
          if (progressBarMessage) {
            await progressBarMessage.delete().catch(() => null);
            progressBarMessage = null;
          }
        }
      } catch (error) {
        console.error('updatePlaybackUI: Error editing playback UI message:', error);
        try {
          playbackUiMessage = await runUiOperationWithRetry(
            () =>
              channel.send({
                flags: MessageFlags.IsComponentsV2,
                components: [playbackContainer, controlsRow],
              }),
            'Recover by sending playback UI message'
          );
        } catch (sendError) {
          console.error('updatePlaybackUI: Recovery send failed:', sendError);
          playbackUiMessage = null;
        }
      }
    } else {
      // If the playback UI message doesn't exist, create a new combined message
      playbackUiMessage = await runUiOperationWithRetry(
        () =>
          channel.send({
            flags: MessageFlags.IsComponentsV2,
            components: [playbackContainer, controlsRow],
          }),
        'Initial send playback UI message'
      );

      // Delete old progress-bar-only message when switching to combined UI
      if (progressBarMessage) {
        await progressBarMessage.delete().catch(() => null);
        progressBarMessage = null;
      }
    }
  } catch (error) {
    console.error('updatePlaybackUI: Error occurred:', error);
  } finally {
    isUpdatingPlaybackUI = false; // Release the lock
  }
}

let isUpdatingProgressBar = false; // Lock for updateProgressBar
let progressBarMessage = null; // Track the progress bar message
let slowExecutionCount = 0; // Track consecutive slow executions

async function updateProgressBar() {
  if (isUpdatingProgressBar || !playbackData || isSeekLocked) return;
  isUpdatingProgressBar = true;
  try {
    await updatePlaybackUI();
  } catch (error) {
    console.error('updateProgressBar: error - ui update failed\n', error);
  } finally {
    isUpdatingProgressBar = false;
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
    
    let fileName = await findClosestTitleFile(playbackData.audiobookTitle);
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

    const fileName = await findClosestTitleFile(playbackData.audiobookTitle);
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
    const fileName = await findClosestTitleFile(playbackData.audiobookTitle);
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
    const fileName = await findClosestTitleFile(playbackData.audiobookTitle);
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

async function applyPlaybackSpeed(speed) {
  try {
    const nextSpeed = clampPlaybackSpeed(speed);
    console.log(`Setting playback speed to ${formatPlaybackSpeed(nextSpeed)}`);
    const newFilePath = await handleSpeedChange(nextSpeed);

    let part = 0;
    if (playbackData.chapterParts.length > 1) {
      part = playbackData.currentPart;
    }

    playbackData.chapterParts[part] = newFilePath;
    playbackData.speed = nextSpeed;
    await updatePlayback();
    await updatePlaybackUI();
  } catch (error) {
    console.error('Error applying playback speed:', error);
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
      const fileName = await path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
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
      const fileName = await path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle))); // Find the closest match for the audiobook title
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

async function connectToVoiceChannel(channelId, guildId, maxRetries = 4) {
  // Retrieve the guild object using the guild ID
  guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error(`Guild with ID ${guildId} not found.`);
    return;
  }

  const adapterCreator = guild.voiceAdapterCreator;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Always destroy any leftover connection before (re)joining
      if (connection) {
        try { connection.destroy(); } catch (_) {}
        connection = null;
      }

      connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      // Wait for the DAVE encryption handshake + voice ready state.
      // Use a generous per-attempt timeout; the DAVE handshake can be slow.
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log(`Voice connection is ready (attempt ${attempt}/${maxRetries}).`);
      return; // Success - exit retry loop
    } catch (error) {
      console.error(`Voice connection attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (connection) {
        try { connection.destroy(); } catch (_) {}
        connection = null;
      }
      if (attempt < maxRetries) {
        const delay = attempt * 2000; // 2 s, 4 s, 6 s back-off
        console.log(`Retrying voice connection in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error; // All retries exhausted - let startPlayback abort cleanly
      }
    }
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
  
      for (const [userId, userTempFiles] of tempFiles.entries()) {
        if (!onlineMemberIds.has(userId)) {
          // User is no longer online, delete their temp files
          for (const tempFile of userTempFiles) {
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

// DEPRECATED - This function is no longer used since the cover image is now included in the main playback UI message instead of a separate embed. Keeping it here for reference in case we want to use it for something else in the future.
// async function createInfoRow(userID, title, author, chapter, part, timestamp) {
//   const coverImagePath = userCoverImages.get(userID); // Get the local file path
//   const coverImageUrl = getDynamicCoverImageUrl(path.basename(path.normalize(coverImagePath)));

//   const embed = new EmbedBuilder()
//     .setTitle(title)
//     .setAuthor({ name: author })
//     .setDescription(`Chapter: ${chapter} | ${timestamp}`)
//     .setColor('#0099ff');

//   // Only set the thumbnail if the coverImageUrl is valid
//   if (coverImageUrl) {
//     embed.setThumbnail(coverImageUrl);
//   }

//   return embed;
// }

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

let isStorePositionRunning = false; // Lock to track if the function is running

async function storePosition() {
  try {
    if (isStorePositionRunning) return; // Prevent multiple executions
    isStorePositionRunning = true; // Set the lock
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

    let fileName = path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle)));
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
    // Use the title directly from playbackData - it's already normalized by bot.js
    const audiobookTitle = playbackData.audiobookTitle;
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
  } finally {
    isStorePositionRunning = false; // Release the lock
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
  const fileName = path.basename(path.normalize(await findClosestTitleFile(playbackData.audiobookTitle)));
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
    const latestMessageBatch = await channel.messages.fetch({ limit: 1 });
    const latestMessage = latestMessageBatch.first();
    if (!latestMessage) return;

    const oneDayMs = 24 * 60 * 60 * 1000;
    const fourteenDaysMs = 14 * oneDayMs;
    const cutoffTimestamp = latestMessage.createdTimestamp - oneDayMs;

    let before;
    while (true) {
      const fetchedMessages = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (fetchedMessages.size === 0) break;

      const deletableMessages = fetchedMessages.filter((message) => {
        if (playbackUiMessage?.id === message.id || progressBarMessage?.id === message.id) return false;
        if (message.createdTimestamp >= cutoffTimestamp) return false;
        if (message.author?.id !== client.user?.id) return false;
        return Date.now() - message.createdTimestamp < fourteenDaysMs;
      });

      if (deletableMessages.size > 0) {
        await channel.bulkDelete(deletableMessages, true);
      }

      for (const message of fetchedMessages.values()) {
        if (playbackUiMessage?.id === message.id || progressBarMessage?.id === message.id) continue;
        if (message.createdTimestamp >= cutoffTimestamp) continue;
        if (message.author?.id !== client.user?.id) continue;
        if (Date.now() - message.createdTimestamp >= fourteenDaysMs) {
          await message.delete().catch(() => null);
        }
      }

      before = fetchedMessages.last()?.id;
      if (!before) break;
    }
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
let lastKnownFileState = {}; // Track previous file state to detect external deletions

async function syncPositionsToFile() {
  if (isSyncingPositions) {
    return; // Exit if the function is already running
  }
  isSyncingPositions = true; // Set the lock
  try {
    let existingData = {};

    // Read the existing file data if it exists to respect any external deletions
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

    // Detect external deletions: if a book was in file before but is gone now, remove from cache
    for (const userID of Object.keys(lastKnownFileState)) {
      if (!userPositionsCache[userID]) continue;
      
      for (const bookTitle of Object.keys(lastKnownFileState[userID] || {})) {
        // If book was in last known state but not in current file, it was externally deleted
        if (userPositionsCache[userID][bookTitle] && (!existingData[userID] || !existingData[userID][bookTitle])) {
          delete userPositionsCache[userID][bookTitle];
          console.log(`[syncPositionsToFile] Removed "${bookTitle}" from cache for user ${userID} (externally deleted)`);
        }
      }
    }

    // Now update existingData with current cache values
    for (const userID of Object.keys(userPositionsCache)) {
      const userAudiobooks = userPositionsCache[userID];

      // Skip if user has no audiobooks in cache
      if (!userAudiobooks || Object.keys(userAudiobooks).length === 0) {
        continue;
      }

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

    // Clean up empty user entries AFTER processing all users
    for (const userID of Object.keys(existingData)) {
      if (Object.keys(existingData[userID]).length === 0) {
        delete existingData[userID];
      }
    }

    // Skip writing if there is no data
    if (Object.keys(existingData).length === 0) {
      console.warn('No data to write. Skipping file update.');
      return;
    }

    // Write the updated data back to the file
    fs.writeFileSync(userPositionFilePath, JSON.stringify(existingData, null, 2));
    
    // Update last known file state after successful write
    lastKnownFileState = JSON.parse(JSON.stringify(existingData)); // Deep copy
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

function splitChaptersIntoGroups(chapters, groupSize = 40) {
  const groups = [];
  for (let i = 0; i < chapters.length; i += groupSize) {
    groups.push(chapters.slice(i, i + groupSize));
  }
  return groups;
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
      console.log('Player idle - moving to next part');
      if (isSeekLocked || isUpdatingPlayback || isStartingPlayback || isProcessingPlaybackMessage) return; // Exit if a seek operation is in progress
      await handleNextPart(); // Move to the next part or chapter
    });

    player.on(AudioPlayerStatus.Playing, () => {
      console.log('Player started playing');
    });

    player.on(AudioPlayerStatus.Paused, () => {
      console.log('Player paused');
    });

    player.on(AudioPlayerStatus.AutoPaused, () => {
      console.warn('Player auto-paused (lost voice connection subscribers). Attempting recovery...');
      if (connection && player) {
        try {
          // Re-subscribe the player to restore audio output
          connection.subscribe(player);
          console.log('Re-subscribed player after AutoPaused state.');
        } catch (error) {
          console.error('Failed to re-subscribe player after AutoPaused:', error);
        }
      }
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