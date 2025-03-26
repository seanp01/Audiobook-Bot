const { getUserBooksInProgress, loadUserPositions, scheduleUserPositionSaving, listAudiobooks, getM4BCoverImage, getM4BMetaData, findClosestMatch, getFileNameFromTitle, skipAudiobook, retrieveAudiobookFilePaths, selectAudiobookAndRetrievePaths, updateAudiobookCache, storeUserPosition, getUserPosition, } = require('./smbAccess');
const { Client, Collection, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, getVoiceConnection, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
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
const userPositionsCache = new Map(); // Cache for user positions
const tempToOriginalMap = new Map(); // Map temporary file paths to original file paths
const userPositionFilePath = path.join(__dirname, 'userPosition.json');

const dvrAddress = process.env.DVR_ADDRESS;
const dvrPort = process.env.DVR_PORT;

let isUpdatingSeekUI = false; // Lock flag for updateSeekUI
let playbackData = null;
let player = null;
let connection = null;
let storeInterval = null;
let updateInterval = null;
let guild = null;
let playbackUiMessage = null; 

let initialTimestamp = 0;
let initialPartIndex = 0;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', () => {
  console.log(`${minionId} is ready!`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // Ensure the interaction is a button interaction
    if (!interaction.isButton()) return;

    const command = interaction.customId;

    // Acknowledge the interaction immediately to prevent "This interaction failed" errors
    if (!interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferUpdate(); // Acknowledge the interaction without sending a visible reply
      } catch (error) {
        console.error('Error acknowledging interaction');
      }
    }

    // Handle the button commands
    switch (command) {
      case 'play_pause':
        if (!player) {
          console.error('Player is not initialized.');
          return;
        }
        if (player.state.status === AudioPlayerStatus.Playing) {
          await handlePlaybackControl('pause');
        } else if (player.state.status === AudioPlayerStatus.Paused) {
          await handlePlaybackControl('play');
        }
        break;

      case 'skip':
        await handleSkipCommand();
        break;

      case 'back':
        await handleBackCommand();
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
  } catch (error) {
    console.error('Error handling interaction:', error);

    // Notify the user if an error occurs
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp();
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!playbackData) return;

  const userID = playbackData.userID;
  const channelID = playbackData.channelID;

  // Check if the user left the voice channel
  if (oldState.channelId === channelID && newState.channelId !== channelID) {
    console.log(`User ${userID} left the voice channel. Ending session.`);
    endSession();
    clearInterval(updateInterval);
  }
});

// Listen for messages from the masterBot
process.on('message', async (message) => {
  try {
    switch (message.type) {
      case 'playback':
        playbackData = message.data;

        // Retrieve audiobook parts and metadata
        const { outputPaths: chapterParts, originalFilePath, metadata, coverImagePath } = await selectAudiobookAndRetrievePaths(
          playbackData.audiobookTitle,
          playbackData.currentChapter,
          playbackData.currentPart,
          playbackData.currentTimestamp
        );

        if (!chapterParts || chapterParts.length === 0) {
          console.error('Error: No parts found.');
          return;
        }

        playbackData.chapterParts = chapterParts;
        tempToOriginalMap.set(chapterParts[playbackData.currentPart], originalFilePath); // Map the temp file to the original file
        playbackData.coverImageUrl = getDynamicCoverImageUrl(coverImagePath);
        playbackData.author = metadata.author || 'Unknown Author';

        // Start playback
        await startPlayback();
        break;

      default:
        console.error(`Unknown or unsupported message type: ${message.type}`);
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

process.on('exit', () => {
  if (storeInterval) clearInterval(storeInterval);
  if (updateInterval) clearInterval(updateInterval);
  if (connection) {
    connection.destroy();
    console.log('Voice connection destroyed.');
  }

  // Sync positions to file before exiting
  syncPositionsToFile();
  console.log('User positions saved to file before exiting.');
  clearTempFiles();
  console.log('Minion bot process exiting. Cleaned up resources.');
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function endSession() {
  try {
    if (player) {
      player.stop(); // Stop playback
      console.log('Playback stopped.');
    }

    playbackData = null; // Clear playback data

    if (connection) {
      console.log('Destroying voice connection...');
      await new Promise((resolve) => {
        connection.destroy();
        resolve(); // Resolve the promise after destroying the connection
      });
      connection = null;
      console.log('Voice connection destroyed.');
    }

    console.log('Session ended by the user.');

    // Trigger process exit to save positions and clean up
    console.log('Exiting process...');
    process.exit(0); // Exit the process with a success code
  } catch (error) {
    console.error('Error ending session:', error);
    process.exit(1); // Exit the process with an error code
  }
}

async function startPlayback() {
  try {
    const { chapterParts, currentPart, channelID, guildID } = playbackData;

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No chapter parts available for playback.');
      return;
    }

    if (currentPart < 0 || currentPart >= chapterParts.length) {
      console.error(`Invalid currentPart: ${currentPart}`);
      return;
    }

    // Create the connection if it doesn't exist
    if (!connection) {
      await connectToVoiceChannel(channelID, guildID);
    }

    // Create the player if it doesn't exist
    if (!player) {
      createPlayer();
    }
    // Set up interval for UI updates
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(updateSeekUI, 1000);
    // Create the audio resource and play it
    const resource = createAudioResource(chapterParts[currentPart]);
    player.play(resource);

    // Subscribe the player to the connection
    connection.subscribe(player);

    console.log(`Playing part ${currentPart + 1} of chapter ${playbackData.currentChapter}.`);
  } catch (error) {
    console.error('Error starting playback:', error);
  }
}

async function updatePlayback() {
  try {
    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No chapter parts available for playback.');
      return;
    }

    const resource = createAudioResource(chapterParts[currentPart], {
      inputType: 'arbitrary',
      inlineVolume: true,
    });

    player.play(resource);
    console.log(`Updated playback to timestamp ${currentTimestamp}.`);
  } catch (error) {
    console.error('Error updating playback:', error);
  }
}

async function loadChapter() {
  try {
    const { audiobookTitle, currentChapter } = playbackData;

    // Retrieve the new chapter parts
    const { outputPaths: chapterParts, metaData, coverImagePath } = await selectAudiobookAndRetrievePaths(
      audiobookTitle,
      currentChapter,
      0,
      0
    );

    if (!chapterParts || chapterParts.length === 0) {
      console.error('No parts found for the selected chapter.');
      return;
    }

    playbackData.chapterParts = chapterParts;
    playbackData.currentPart = 0;
    playbackData.currentTimestamp = 0;

    console.log(`Loaded chapter ${currentChapter}.`);
    await startPlayback();
  } catch (error) {
    console.error('Error loading chapter:', error);
  }
}

async function handleNextPart() {
  const { chapterParts, currentPart, currentChapter, audiobookTitle } = playbackData;

  if (currentPart + 1 < chapterParts.length) {
    // Move to the next part within the same chapter
    playbackData.currentPart += 1;
    playbackData.currentTimestamp = 0;
    await startPlayback();
  } else {
    // End of the current chapter, move to the next chapter
    console.log('End of chapter reached. Moving to the next chapter.');

    playbackData.currentChapter += 1; // Increment the chapter number
    playbackData.currentPart = 0; // Reset to the first part of the new chapter
    playbackData.currentTimestamp = 0; // Reset the timestamp

    try {
      // Load the next chapter
      const { outputPaths: chapterParts, metaData, coverImagePath } = await selectAudiobookAndRetrievePaths(
        audiobookTitle,
        playbackData.currentChapter,
        0,
        0
      );

      if (!chapterParts || chapterParts.length === 0) {
        console.error(`No parts found for chapter ${playbackData.currentChapter}.`);
        console.log('Playback has reached the end of the audiobook.');
        return;
      }

      playbackData.chapterParts = chapterParts;

      console.log(`Loaded chapter ${playbackData.currentChapter}.`);
      await startPlayback(); // Start playback for the new chapter
    } catch (error) {
      console.error('Error loading the next chapter:', error);
    }
  }
}

async function updateSeekUI() {
  if (isUpdatingSeekUI) {
    return; // Exit if the function is already running
  }

  isUpdatingSeekUI = true; // Set the lock

  try {
    const {
      audiobookTitle = 'Unknown Title',
      currentChapter = 1,
      currentPart = 0,
      currentTimestamp = 0,
      coverImageUrl = null,
      author = 'Unknown Author',
    } = playbackData;

    // Retrieve the cached part durations
    const partDurations = await calculateTotalChapterDuration(playbackData.chapterParts);

    // Check if the current file is a temporary file
    const currentFilePath = playbackData.chapterParts[currentPart];
    const originalFilePath = tempToOriginalMap.get(currentFilePath);

    let timeRemovedFromStart = 0;

    if (originalFilePath) {
      // If the file is a temporary file, calculate the time removed from the start
      const originalDuration = await getCachedAudioDuration(originalFilePath);
      const currentDuration = await getCachedAudioDuration(currentFilePath);

      timeRemovedFromStart = originalDuration - currentDuration;
      console.log(`Time removed from start: ${timeRemovedFromStart} ms`);
    }

    // Calculate the cumulative duration up to the current part
    const timeToCurrentPart = partDurations.slice(0, currentPart).reduce((sum, duration) => sum + duration, 0);

    // Adjust the total timestamp to account for the time removed
    const totalTimestamp = currentTimestamp + timeToCurrentPart + timeRemovedFromStart;

    // Calculate the total duration of the chapter
    const totalChapterDuration = partDurations.reduce((sum, duration) => sum + duration, 0);

    // Generate the progress bar
    const progressBar = await createPlaybackSeekbarRow(totalTimestamp, totalChapterDuration);

    // Format the playback state
    const isPlaying = player && player.state.status === AudioPlayerStatus.Playing;
    const playbackState = isPlaying ? '▶️ Playing' : '⏸️ Paused';

    // Create the embed for the UI
    const embed = new EmbedBuilder()
      .setTitle(audiobookTitle)
      .setAuthor({ name: author })
      .setDescription(`Chapter: ${currentChapter + 1} | Part: ${currentPart + 1}`)
      .addFields(
        { name: 'Progress', value: progressBar },
        { name: 'Playback State', value: playbackState },
        { name: 'Chapter Duration', value: formatTimestamp(totalChapterDuration) },
        { name: 'Progress', value: formatTimestamp(totalTimestamp) }
      )
      .setColor('#0099ff');

    // Only set the thumbnail if the coverImageUrl is valid
    if (coverImageUrl) {
      embed.setThumbnail(coverImageUrl);
    }

    // Create the action rows for controls
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
          .setCustomId('play_pause')
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

    // Send or edit the playback UI message
    const channel = client.channels.cache.get(playbackData.channelID);
    if (!channel) {
      console.error(`Channel with ID ${playbackData.channelID} not found.`);
      return;
    }

    if (!playbackUiMessage) {
      // Send a new message if no playback UI message exists
      playbackUiMessage = await channel.send({ embeds: [embed], components: [row] });
    } else {
      // Edit the existing playback UI message
      await playbackUiMessage.edit({ embeds: [embed], components: [row] });
    }
  } catch (error) {
    console.error('Error updating seek UI:', error);
  } finally {
    isUpdatingSeekUI = false; // Release the lock
  }
}

async function handleSkipCommand() {
  try {
    const skipDuration = 10000; // Skip forward 10 seconds
    playbackData.currentTimestamp += skipDuration;

    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    // Check if the current file is a temporary file
    const originalFilePath = tempToOriginalMap.get(chapterParts[currentPart]) || chapterParts[currentPart];

    if (tempToOriginalMap.has(chapterParts[currentPart])) {
      // Handle seek locally for temporary files
      const newFilePath = await handleLocalSeek(chapterParts[currentPart], currentTimestamp);
      playbackData.chapterParts[currentPart] = newFilePath;
    } else {
      // Generate a new MP3 file for the new timestamp
      const newFilePath = await handleOriginalFileSeek(originalFilePath, currentTimestamp);
      playbackData.chapterParts[currentPart] = newFilePath;
    }

    // Update playback with the new file
    await updatePlayback();
    console.log(`Skipped forward 10 seconds.`);
  } catch (error) {
    console.error('Error handling skip command:', error);
  }
}

async function handleBackCommand() {
  try {
    const rewindDuration = 10000; // Rewind 10 seconds
    playbackData.currentTimestamp = Math.max(0, playbackData.currentTimestamp - rewindDuration);

    const { chapterParts, currentPart, currentTimestamp } = playbackData;

    // Check if the current file is a temporary file
    const originalFilePath = tempToOriginalMap.get(chapterParts[currentPart]) || chapterParts[currentPart];

    if (tempToOriginalMap.has(chapterParts[currentPart])) {
      // Handle seek locally for temporary files
      const newFilePath = await handleLocalSeek(chapterParts[currentPart], currentTimestamp);
      playbackData.chapterParts[currentPart] = newFilePath;
    } else {
      // Send a request to the DVR to generate a new MP3 file
      const response = await axios.post(`http://${dvrAddress}:${dvrPort}/convert`, {
        filePath: originalFilePath,
        startTime: Math.floor(currentTimestamp / 1000), // Convert milliseconds to seconds
      });

      if (response.data && response.data.outputFilePath) {
        playbackData.chapterParts[currentPart] = response.data.outputFilePath;
      } else {
        console.error('Error: DVR did not return a valid output file path.');
      }
    }

    // Update playback with the new file
    await updatePlayback();
    console.log(`Rewound 10 seconds.`);
  } catch (error) {
    console.error('Error handling back command:', error);
  }
}

async function handleLocalSeek(tempFilePath, newTimestamp) {
  try {
    const originalFilePath = tempToOriginalMap.get(tempFilePath);

    if (newTimestamp < 0) {
      // Seek goes beyond the start of the temporary file, revert to the original file
      console.log('Seek goes beyond the start of the temporary file. Reverting to the original file.');
      return await handleOriginalFileSeek(originalFilePath, newTimestamp);
    }

    // Generate a new temporary file for the seeked position
    const newTempFilePath = path.join(path.dirname(tempFilePath), `${uuidv4()}.mp3`);

    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-ss', Math.floor(newTimestamp / 1000), // Convert milliseconds to seconds
      '-i', originalFilePath,
      '-vn',
      '-b:a', '192k',
      '-c:a', 'copy',
      newTempFilePath,
    ]);

    return new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log(`Generated new temporary file: ${newTempFilePath}`);
          tempToOriginalMap.set(newTempFilePath, originalFilePath); // Map the new temp file to the original file
          resolve(newTempFilePath);
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    });
  } catch (error) {
    console.error('Error handling local seek:', error);
    throw error;
  }
}

async function handleOriginalFileSeek(originalFilePath, newTimestamp) {
  try {
    const localOutputDir = path.join(__dirname, '..\\temp');
    const newTempFilePath = path.join(localOutputDir, `${uuidv4()}.mp3`);
    const ffmpeg = spawn('ffmpeg', [
      '-ss', Math.floor(newTimestamp / 1000), // Convert milliseconds to seconds
      '-i', originalFilePath,
      '-vn',
      '-b:a', '192k',
      '-c:a', 'copy',
      newTempFilePath,
    ]);

    return new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log(`Generated new temporary file from original file: ${newTempFilePath}`);
          tempToOriginalMap.set(newTempFilePath, originalFilePath); // Map the new temp file to the original file
          resolve(newTempFilePath);
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    });
  } catch (error) {
    console.error('Error handling original file seek:', error);
    throw error;
  }
}

async function handleNextChapterCommand() {
  try {
    playbackData.currentChapter += 1; // Move to the next chapter
    playbackData.currentPart = 0; // Reset to the first part of the new chapter
    playbackData.currentTimestamp = 0; // Reset the timestamp

    // Load the next chapter
    const { outputPaths: chapterParts } = await selectAudiobookAndRetrievePaths(
      playbackData.audiobookTitle,
      playbackData.currentChapter,
      0,
      0
    );

    if (!chapterParts || chapterParts.length === 0) {
      console.error(`No parts found for chapter ${playbackData.currentChapter}.`);
      console.log('Playback has reached the end of the audiobook.');
      return;
    }

    playbackData.chapterParts = chapterParts;

    console.log(`Loaded chapter ${playbackData.currentChapter}.`);
    await startPlayback(); // Start playback for the new chapter
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
    const { outputPaths: chapterParts } = await selectAudiobookAndRetrievePaths(
      playbackData.audiobookTitle,
      playbackData.currentChapter,
      0,
      0
    );

    if (!chapterParts || chapterParts.length === 0) {
      console.error(`No parts found for chapter ${playbackData.currentChapter}.`);
      return;
    }

    playbackData.chapterParts = chapterParts;

    console.log(`Loaded chapter ${playbackData.currentChapter}.`);
    await startPlayback(); // Start playback for the new chapter
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

    console.log(`Minion ${minionId} connected to voice channel ${channelId}.`);
  } catch (error) {
    console.error('Error connecting to voice channel:', error);
  }
}

async function clearTempFiles() {
  setInterval(async () => {
    if (!playbackData) return; // Exit if playbackData is not available
    guild = client.guilds.cache.get(playbackData.guildID);
    const members = await guild.members.fetch();
    const onlineMembers = members.filter(member => member.presence?.status === 'online');
    const onlineMemberIds = new Set(onlineMembers.map(member => member.user.id));

    for (const [userId, tempFiles] of userTempFiles.entries()) {
      if (!onlineMemberIds.has(userId)) {
        // User is no longer online, delete their temp files
        for (const tempFile of tempFiles) {
          fs.unlink(tempFile, (err) => {
            if (err) {
              console.error(`Error deleting file ${tempFile}:`, err);
            } else {
              console.log(`Deleted file ${tempFile}`);
              tempToOriginalMap.delete(tempFile); // Remove the mapping
            }
          });
        }
        userTempFiles.delete(userId);
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
  const coverImageUrl = getDynamicCoverImageUrl(coverImagePath);

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

    // Update the current timestamp based on actual playback duration
    let currentTimestamp = playbackData.currentTimestamp || 0;
    if (player.state.resource?.playbackDuration) {
      currentTimestamp = player.state.resource.playbackDuration; // Playback duration in milliseconds
    }

    playbackData.currentTimestamp = currentTimestamp;

    // Update the cached position
    const userID = playbackData.userID;
    const audiobookTitle = playbackData.audiobookTitle;

    if (!userPositionsCache.has(userID)) {
      userPositionsCache.set(userID, {}); // Initialize the user's data if it doesn't exist
    }

    const userAudiobooks = userPositionsCache.get(userID);
    userAudiobooks[audiobookTitle] = {
      chapter: playbackData.currentChapter,
      part: playbackData.currentPart,
      timestamp: currentTimestamp,
    };
  } catch (error) {
    console.error('Error storing position:', error);
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

async function calculateTotalChapterDuration(chapterParts) {
  const chapterKey = chapterParts.join('|'); // Create a unique key for the chapter parts

  // Check if the durations are already cached
  if (chapterDurationCache.has(chapterKey)) {
    return chapterDurationCache.get(chapterKey); // Return the cached array of part durations
  }

  // Calculate the duration of each part
  const partDurations = [];
  for (const part of chapterParts) {
    const duration = await getCachedAudioDuration(part);
    partDurations.push(duration * 1000); // Convert seconds to milliseconds
  }

  // Cache the array of part durations
  chapterDurationCache.set(chapterKey, partDurations);

  return partDurations;
}


async function handlePlaybackControl(command) {
  try {
    switch (command) {
      case 'pause':
        if (player && player.state.status === AudioPlayerStatus.Playing) {
          player.pause();
          console.log('Playback paused.');
        }
        break;

      case 'play':
        if (player && player.state.status === AudioPlayerStatus.Paused) {
          player.unpause();
          console.log('Playback resumed.');
        }
        break;

      case 'skip':
        playbackData.currentTimestamp += 10000; // Skip forward 10 seconds
        await updatePlayback();
        break;

      case 'back':
        playbackData.currentTimestamp = Math.max(0, playbackData.currentTimestamp - 10000); // Skip back 10 seconds
        await updatePlayback();
        break;

      default:
        console.error(`Unknown playback control command: ${command}`);
    }
  } catch (error) {
    console.error('Error handling playback control:', error);
  }
}

function syncPositionsToFile() {
  try {
    let existingData = {};

    // Read the existing file data if it exists
    if (fs.existsSync(userPositionFilePath)) {
      const fileData = fs.readFileSync(userPositionFilePath, 'utf-8');
      existingData = JSON.parse(fileData);
    }

    // Merge the cached data with the existing data
    for (const [userID, userAudiobooks] of userPositionsCache.entries()) {
      if (!existingData[userID]) {
        existingData[userID] = {}; // Initialize the user's data if it doesn't exist
      }

      // Update the user's audiobooks
      for (const [audiobookTitle, positionData] of Object.entries(userAudiobooks)) {
        existingData[userID][audiobookTitle] = positionData;
      }
    }

    // Write the updated data back to the file
    fs.writeFileSync(userPositionFilePath, JSON.stringify(existingData, null, 2));
  } catch (error) {
    console.error('Error syncing positions to file:', error);
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

function createPlayer() {
  try {
    // Create a new audio player
    player = createAudioPlayer();

    // Handle playback events
    player.on(AudioPlayerStatus.Idle, async () => {
      console.log('Playback finished.');
      await handleNextPart(); // Move to the next part or chapter
    });

    client.on('messageDelete', (message) => {
      if (message.id === playbackUiMessage?.id) {
        playbackUiMessage = null; // Reset the playback UI message if it is deleted
      }
    });

    let isPlayingEventLocked = false; // Lock flag for the Playing event

    player.on(AudioPlayerStatus.Playing, async () => {
      if (isPlayingEventLocked) {
        return; // Exit if the event is already being handled
      }
    
      isPlayingEventLocked = true; // Set the lock
    
      try {
        console.log('Playback started.');    
        // Add your logic here (e.g., updating UI, logging, etc.)
        await updateSeekUI(); // Example: Update the seek UI
      } catch (error) {
        console.error('Error handling AudioPlayerStatus.Playing event:', error);
      } finally {
        isPlayingEventLocked = false; // Release the lock
      }
    });

    let isPausingEventLocked = false; // Lock flag for the Playing event

    player.on(AudioPlayerStatus.Paused, async () => {
      if (isPausingEventLocked) {
        return; // Exit if the event is already being handled
      }

      isPausingEventLocked = true; // Set the lock

      try {
        console.log('Playback paused.');    
        // Add your logic here (e.g., updating UI, logging, etc.)
        await updateSeekUI(); // Example: Update the seek UI
      } catch (error) {
        console.error('Error handling AudioPlayerStatus.Paused event:', error);
      } finally {
        isPlayingEventLocked = false; // Release the lock
      }
    });

    player.on('error', (error) => {
      console.error('Error with audio player:', error);
    });

    console.log('Audio player created.');
  } catch (error) {
    console.error('Error creating audio player:', error);
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

function getDynamicCoverImageUrl(filePath) {
  const isWindows = os.platform() === 'win32';
  const baseUrl = isWindows
    ? `http://${coverArtAddress}:${coverArtPort}/images/` 
    : `http://${coverArtAddress}:${coverArtPort}/images/`; 

  const fileName = path.basename(filePath); // Extract the file name from the path
  return `${baseUrl}${fileName}`;
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
  console.log('Audio duration cache cleared');
}, 60 * 60 * 1000); // Clear the cache every hour

if (storeInterval) clearInterval(storeInterval);
storeInterval = setInterval(() => {
  storePosition();
}, 1000); // Store position every second

setInterval(syncPositionsToFile, 60000); // Sync every 60 seconds

clearTempFiles();

// Log in the minion bot
client.login(minionToken);