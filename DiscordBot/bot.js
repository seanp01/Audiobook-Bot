const { Client, Collection, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');
const path = require('path');
const colors = require('colors'); 
const fs = require('fs'); 
const wol = require('wake_on_lan');
const axios = require('axios');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { exec, spawn, fork, execFile } = require('child_process');
const { Routes } = require('discord-api-types/v9');
const { joinVoiceChannel, createAudioPlayer, getVoiceConnection, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { v4: uuidv4 } = require('uuid');
const { getUserBooksInProgress, loadUserPositions, scheduleUserPositionSaving, listAudiobooks, getM4BCoverImage, getM4BMetaData, findClosestMatch, getFileNameFromTitle, skipAudiobook, retrieveAudiobookFilePaths, selectAudiobookAndRetrievePaths, updateAudiobookCache, storeUserPosition, getUserPosition, } = require('./utils/smbAccess');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '.env') }); // Explicitly load .env from the DiscordBot directory

// Discord IDs
const streampalID = process.env.STREAMPAL_ID;
const guildID = process.env.GUILD_ID;
const streamboiAppID = process.env.STREAMBOI_APP_ID;

const player1ID = process.env.MINION_BOT_1_APP_ID;
const player2ID = process.env.MINION_BOT_2_APP_ID;
const player3ID = process.env.MINION_BOT_3_APP_ID;
const player4ID = process.env.MINION_BOT_4_APP_ID;

const player1Token = process.env.MINION_BOT_1_TOKEN;
const player2Token = process.env.MINION_BOT_2_TOKEN;
const player3Token = process.env.MINION_BOT_3_TOKEN;
const player4Token = process.env.MINION_BOT_4_TOKEN;
const streamPalToken = process.env.MASTER_BOT_TOKEN;

// Network addresses
const macAddress = process.env.MAC_ADDRESS;
const mediaPIIPAddress = process.env.MEDIA_PI_ADDRESS;
const coverArtAddress = process.env.COVER_ART_ADDRESS;
const dvrAddress = process.env.DVR_ADDRESS;
const audiobookPIIPAddress = process.env.AUDIOBOOK_PI_ADDRESS;

const channelName = process.env.CHANNEL_NAME;;

const piServicePort = process.env.PI_SERVICE_PORT;
const livestreamServicePort = process.env.LIVESTREAM_SERVICE_PORT;
const coverArtPort = process.env.COVER_ART_PORT;

const networkPath = process.env.NETWORK_PATH;
const driveLetter = process.env.DRIVE_LETTER;
const networkUsername = process.env.NETWORK_USERNAME; // Replace with your network username
const networkPassword = process.env.NETOWRK_PASSWORD; // Replace with your network password

const audioDurationCache = new Map();
const localOutputDir = path.join(__dirname, 'temp');
const imageDirectory = path.join(__dirname, 'temp');

let isDriveMounted = false;
let streampalonline = false;  
let guild = null;
let onlineMembers = [];

let skipAdjustment = 0;

const userPositionFilePath = path.join(__dirname, 'utils', 'userPosition.json');
const userMessageMapFilePath = path.join(__dirname, 'utils', 'userMessageMap.json');

const imageHost = express();

setInterval(() => {
  audioDurationCache.clear();
  console.log('Audio duration cache cleared');
}, 60 * 60 * 1000); // Clear the cache every hour

imageHost.use('/images', express.static(imageDirectory, {
  fallthrough: false, // Ensure that requests are not passed to the next middleware if the file is not found
  setHeaders: (res, path) => {
    res.set('Content-Type', 'image/jpeg'); // Set the content type to image/jpeg
  }
}));

imageHost.listen(8080, () => {
  console.log('Image server running on port 8080/images/');
});

imageHost.use((err, req, res, next) => {
  console.error('Error serving image:', err);
  res.status(500).send('Internal Server Error');
});

imageHost.get('*', (req, res) => {
  console.log('Request for:', req.url);
  res.status(404).send('Not Found');
});

// Map to store connections and players for each user
const userPlaybackSpeeds = new Map();
const userCurrentAudiobook = new Map();
const userCurrentChapter = new Map();
const userCurrentPart = new Map();
const userTimestamps = new Map();
const userUiMessageData = new Map(); // Map to store { channelId, messageId }
const userIntervals = new Map();
const minionConnections = new Map(); // Map to store connections for each minion bot
const minionProcesses = new Map();

// Minion bot tokens
const minionBots = [
  {
    id: 'player1',
    appId: player1ID,
    token: player1Token,
    client: null,
    isActive: false, // Track whether the minion is active,
    isInUse: false, // Track whether the minion is in use
  },
  {
    id: 'player2',
    appId: player2ID,
    token: player2Token,
    client: null,
    isActive: false, // Track whether the minion is active
    isInUse: false, // Track whether the minion is in use
  },
  {
    id: 'player3',
    appId: player3ID,
    token: player3Token,
    client: null,
    isActive: false, // Track whether the minion is active
    isInUse: false, // Track whether the minion is in use
  },
  {
    id: 'player4',
    appId: player4ID,
    token: player4Token,
    client: null,
    isActive: false, // Track whether the minion is active
    isInUse: false, // Track whether the minion is in use
  }
];

// Define the enum for commands
const Commands = {
  PING: 'ping',
  YOUTUBE: 'youtube',
  NINE_ANIME: '9anime',
  PLAYBACK: 'playback',
  FF: 'ff',
  RW: 'rw',
  VOLUME_UP: 'volumeup',
  VOLUME_DOWN: 'volumedown',
  FOCUS: 'focus',
  END: 'end',
  FULLSCREEN: 'fullscreen',
  MUTE: 'mute',
  START_LIVESTREAM_SERVICE: 'start-livestream-service',
  SEARCH: 'search',
  AUDIOBOOK: 'audiobook',
  AUDIOBOOK_LIBRARY: 'audiobook-library',
  AUDIOBOOK_PLAY: 'audiobook-play',
  AUDIOBOOK_PAUSE: 'audiobook-pause',
  AUDIOBOOK_FF: 'audiobook-ff',
  AUDIOBOOK_RW: 'audiobook-rw',
  AUDIOBOOK_SKIP: 'audiobook-skip',
  AUDIOBOOK_BACK: 'audiobook-back',
  AUDIOBOOK_NEXT_CHAPTER: 'audiobook-next-chapter',
  AUDIOBOOK_PREV_CHAPTER: 'audiobook-prev-chapter',
  AUDIOBOOK_SPEED: 'audiobook-speed',
  AUDIOBOOK_IN_PROGRESS: 'audiobook-in-progress',
};

const UI_Commands = {
  PLAY_PAUSE: 'play_pause',
  SKIP: 'skip',
  BACK: 'back',
  SPEED: 'speed',
  PREV: 'prev',
  NEXT: 'next',
};

const masterBot = new Client({
  messageCache: 60,
  fetchAllMembers: false,
  messageCacheMaxSize: 10,
  restTimeOffset: 0,
  restWsBridgetimeout: 100,
  disableEveryone: true,
  intents: [    
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildIntegrations,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping
  ], 
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction
  ] 
});

masterBot.once('ready', async () => {
  guild = await masterBot.guilds.cache.get(guildID);
  if (!guild) {
    console.log('Guild not found');
    return;
  }

  // Use the enum for local command values
  const localCommands = new Set(Object.values(Commands));
  // Delete commands that are not found in the folder
  const rest = new REST({ version: '9' }).setToken(process.env.MASTER_BOT_TOKEN);
  try {
    console.log('Started deleting extra application (/) commands.');

    const commands = await rest.get(
      Routes.applicationGuildCommands(streamboiAppID, guildID)
    );

    for (const command of commands) {
      if (!localCommands.has(command.name)) {
        await rest.delete(
          `${Routes.applicationGuildCommands(streamboiAppID, guildID)}/${command.id}`
        );
        console.log(`Deleted command: ${command.name}`);
      }
    }

    console.log('Successfully deleted extra application (/) commands.');
  } catch (error) {
    console.error(error);
  }

  // Register (or update) new commands
  const commandsToRegister = [
      // new SlashCommandBuilder().setName(Commands.AUDIOBOOK).setDescription('Plays an audiobook selection')
      //    .addStringOption(option => option.setName('title').setDescription('Name of audiobook to play').setRequired(true))
      //    .addNumberOption(option => option.setName('chapter').setDescription('Chapter to start from').setRequired(false)),
    ];

   for (const command of commandsToRegister) {
     await guild.commands.create(command.toJSON());
   }

  const members = await guild.members.fetch();
  onlineMembers = members.filter(member => member.presence?.status === 'online');
  const onlineMemberNames = onlineMembers.map(member => member.user.username).join(', ');
  console.log(`Online members: ${onlineMemberNames}`);
  loadUserPositions();
  await checkAndMountNetworkDrive();
});

masterBot.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    // Helper function to update the UI message
    const updateUIMessage = async (content) => {
      if (typeof content !== 'string') {
        content = String(content);
      }
      updateMessageData(interaction);
    };

    if (interaction.isCommand()) {
      const command = interaction.commandName;

      switch (command) {
        case Commands.PING:
          await updateUIMessage('Pong!');
          break;
        case Commands.YOUTUBE:
          const input = interaction.options.getString('url');
          await axios.post('http://' + mediaPIIPAddress + ':' + piServicePort + '/youtube', { url: input })
            .then(response => {
              console.log(response.data);
            })
            .catch(error => {
              console.log(error);
            });
          await updateUIMessage('Now Playing url!');
          break;
        case Commands.AUDIOBOOK:
          console.log('User requested audio book playback');
          await interaction.deferReply({ ephemeral: true }); // Defer the reply to acknowledge the interaction
          await executeAudiobookCommand(interaction);
          break;
        case Commands.AUDIOBOOK_LIBRARY:
          await interaction.deferReply(); // Defer the reply to acknowledge the interaction
          const audiobookFiles = await listAudiobooks();
          await updateUIMessage(`Available audiobooks: ${audiobookFiles.join(', ')}`);
          break;
          await interaction.deferReply({ ephemeral: true }); // Defer the reply to acknowledge the interaction
          await updateUIMessage('Rewinding audiobook (not supported yet)');
          break;
        case Commands.AUDIOBOOK_IN_PROGRESS:
          await interaction.deferReply({ ephemeral: true }); // Defer the reply to acknowledge the interaction
          const booksInProgress = getUserBooksInProgress(interaction.user.id);
          if (booksInProgress.length === 0) {
            await interaction.editReply('You have no audiobooks in progress.');
            return;
          }
          const buttons = booksInProgress.map(book => 
            new ButtonBuilder()
              .setCustomId(`resume_${book.title}`)
              .setLabel(book.title)
              .setStyle(ButtonStyle.Primary)
          );
  
          const inProgressSelection = new ActionRowBuilder().addComponents(buttons);
          await interaction.followUp({ content: 'Select a book to resume:', components: [inProgressSelection], ephemeral: true });
          break;
        default:
          await interaction.reply('Command not recognized.');
          break;
      }
    } else if (interaction.isButton()) {
      const command = interaction.customId;

      if (command.startsWith('resume_')) {
        const bookTitle = command.replace('resume_', '');
        await interaction.deferReply({ ephemeral: true }); // Defer the reply to acknowledge the interaction
        await executeAudiobookCommand(interaction, bookTitle);
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    if (!interaction.replied) {
      await interaction.reply('An error occurred while processing the interaction.');
    }
  }
});

masterBot.on('voiceStateUpdate', (oldState, newState) => {
  let newUserChannel = newState.channel;
  let oldUserChannel = oldState.channel;
  if(newUserChannel !== null) {
    console.log(`User ${newState.member.user.tag} joined voice channel ${newUserChannel.name}`);
    if (newUserChannel.name !== 'stream') return
    // First user has joined the voice channel
    wol.wake(macAddress, function(error) {
      if(error) {
        console.log('Wake-on-LAN error', error);
      } else {
        console.log('Wake-on-LAN packet sent');
      }
    });    
  } else if(newUserChannel === null){
    if (oldUserChannel.name !== 'stream') return
    // Last remaining user has left the voice channel
    console.log(`User ${oldState.member.user.tag} left voice channel ${oldUserChannel.name}`);
  }
});

async function sendInteractionToMinion(minion, playbackData, commandType = 'playback') {
  try {
    const minionProcess = minionProcesses.get(minion.id);
    if (!minionProcess) {
      console.error(`Minion bot ${minion.id} is not running.`);
      return;
    }
  
    minionProcess.send({
      type: 'playback',
      data: playbackData,
    });

    console.log(`Sent interaction to ${minion.id} for audiobook playback.`);
  } catch (error) {
    console.error(`Error sending interaction to ${minion.id}:`, error);
    minion.isInUse = false; // Reset the flag on failure
  }
}

async function updateMessageData(interaction) {
  const userId = interaction.user.id;

  // Build the message update object dynamically
  const updateData = {
    content: 'Audiobook controls:',
    components: [],
  };

  try {
    if (interaction.deferred || interaction.replied) {
      // Use editReply if the interaction was deferred or already replied to
      await interaction.editReply(updateData);
    } else {
      // Use reply if the interaction has not been replied to or deferred
      await interaction.reply(updateData);
    }

    // Store the interaction in userUiMessageData
    userUiMessageData.set(userId, interaction);
  } catch (error) {
    console.error('Error updating message data:', error);
  }
}

async function executeAudiobookCommand(interaction, bookTitle = null) {
  try {
    const userId = interaction.user.id;
    const selectedAudiobook = bookTitle || interaction.options.getString('title');
    const selectedChapter = bookTitle ? 1 : (interaction.options.getNumber('chapter') || 1);
    let currentTimestamp = 0;

    const userPosition = getUserPosition(userId, selectedAudiobook);
    let currentChapter = selectedChapter;
    let currentPart = 0;

    if (userPosition) {
      currentTimestamp = userPosition.timestamp;
      currentChapter = userPosition.chapter;
      currentPart = userPosition.part;
    }

    const availableMinion = minionBots.find((minion) => minion.isActive && !minion.isInUse);

    if (!availableMinion) {
      console.error('No available minions at the moment.');
      await interaction.followUp('No available minions at the moment.');
      return;
    }

    availableMinion.isInUse = true;

    const playbackData = {
      userID: userId,
      audiobookTitle: selectedAudiobook,
      currentPart: currentPart,
      currentChapter: currentChapter,
      currentTimestamp: currentTimestamp,
      channelID: interaction.channel.id,
      guildID: interaction.guild.id,
    };

    await sendInteractionToMinion(availableMinion, playbackData, 'playback');

    userCurrentAudiobook.set(userId, selectedAudiobook);
    userCurrentChapter.set(userId, currentChapter);
    userCurrentPart.set(userId, currentPart);
    userTimestamps.set(userId, currentTimestamp);

    if (!interaction.replied) {
      await interaction.followUp(`Now playing: **${selectedAudiobook}**`);
    }
  } catch (error) {
    console.error('Error executing audiobook command:', error);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply('An error occurred while executing the command.');
    }
  }
}

// Read the JSON file
function loadUserMessageMap() {
  try {
    if (fs.existsSync(userMessageMapFilePath)) {
      const fileData = fs.readFileSync(userMessageMapFilePath, 'utf8');
      return JSON.parse(fileData);
    }
    return {};
  } catch (error) {
    console.error('Error loading user message map:', error);
    return {};
  }
}

// Write to the JSON file
function saveUserMessageMap(data) {
  try {
    fs.writeFileSync(userMessageMapFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving user message map:', error);
  }
}

// Update the JSON file with a new mapping
function updateUserMessageMap(userID, channelID, messageID) {
  const userMessageMap = loadUserMessageMap();
  userMessageMap[userID] = { channelID, messageID };
  saveUserMessageMap(userMessageMap);
}

// Remove a mapping from the JSON file
function removeUserMessageMap(userID) {
  const userMessageMap = loadUserMessageMap();
  delete userMessageMap[userID];
  saveUserMessageMap(userMessageMap);
}

function checkAndMountNetworkDrive() {
  if (isDriveMounted) {
    return;
  }
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    const linuxMountPoint = '/mnt/audiobooks'; // Define the Linux mount point
    const smbPath = platform === 'win32' ? `\\\\${dvrAddress}\\Audiobooks` : `//${dvrAddress}/Audiobooks`;

    if (platform === 'win32') {
      // Windows-specific code
      exec(`net use ${driveLetter} ${smbPath}`, (error, stdout, stderr) => {
        if (error && error.message.includes('local device name is already in use')) {
          console.log(`Network drive already mounted: ${error}`);
          resolve();
        } else if (error && error.message.includes('not found')) {
          console.log(`Network not found: ${error}`);
          resolve();
        } else if (stdout) {
          console.log(`Network drive mounted: ${stdout}`);
          resolve();
        } else {
          resolve();
        }
      });
      isDriveMounted = true;
    } else if (platform === 'linux') {
      // Linux-specific code
      // Check if the mount point is already mounted
      exec(`mount | grep ${linuxMountPoint}`, (error, stdout, stderr) => {
        if (stdout.includes(linuxMountPoint)) {
          console.log(`Network drive already mounted at ${linuxMountPoint}`);
          return resolve(); // Exit early if already mounted
        }

        // Ensure the mount point directory exists
        if (!fs.existsSync(linuxMountPoint)) {
          fs.mkdirSync(linuxMountPoint, { recursive: true });
        }

        // Mount the network drive
        exec(
          `sudo mount -t cifs ${smbPath} ${linuxMountPoint} -o username=${networkUsername},password=${networkPassword},vers=3.0`,
          (error, stdout, stderr) => {
            if (error) {
              console.log(`Error mounting network drive: ${stderr}`);
              resolve(); // Resolve to avoid blocking the process
            } else {
              console.log(`Network drive mounted at ${linuxMountPoint}: ${stdout}`);
              resolve();
            }
          }
        );
      });
      isDriveMounted = true;
    } else {
      console.log(`Unsupported platform: ${platform}`);
      resolve();
    }
  });
}

function sendStreamPAlToClientVoiceChannel() {
  setTimeout(function(){
    axios.post('http://' + mediaPIIPAddress + ':' + piServicePort + '/join_channel') 
    .then(response => {
      console.log('Post request /join_channel sent\n' + response.data);
    })
    .catch(error => {
      console.log('Join Channel error', error);
    });
  }, 5000);
}

function startLiveStreamService() {
  setTimeout(function(){
    axios.post('http://' + mediaPIIPAddress + ':' + piServicePort + '/start_livestream_service') 
    .then(response => {
      console.log('Post request /start_livestream_service sent\n' + response.data);
    })
    .catch(error => {
      console.log('Start Livestream Service channel error', error);
    });
  }, 5000);
}

// Function to get the next available minion
function getNextAvailableMinion() {
  return minionBots.find((minion) => !minion.isActive);
}

minionBots.forEach((minion) => {
  if (minion.token === undefined || minion.token === '') {
    console.error(`Minion bot ${minion.id} token is not defined.`);
    return;
  }
  // Function to spawn a minion bot process
  const spawnMinionBot = (minion) => {
    const minionProcess = fork(
      path.join(__dirname, 'utils', 'minionBot.js'),
      [minion.id, minion.token],
      { stdio: 'inherit' }
    );

    console.log('Spawning minion bot with id and token ' + minion.id + ' ' + minion.token);

    // Mark the minion as active when the process starts
    minion.isActive = true;

    // Handle when the minion process exits
    minionProcess.on('exit', (code) => {
      console.log(`${minion.id} exited with code ${code}`);
      minion.isActive = false;
      minion.isInUse = false;
      minion.userID = null; // Clear the associated user
      minionProcesses.delete(minion.id); // Remove the process from the map

      console.log(`Restarting minion bot ${minion.id}...`);
      spawnMinionBot(minion); // Restart the minion bot
    });

    // Store the minion process in the map
    minionProcesses.set(minion.id, minionProcess);
  };

  // Spawn the initial minion bot process
  spawnMinionBot(minion);
});

masterBot.aliases = new Collection();
masterBot.cooldowns = new Collection();

//login into the bot
masterBot.login(process.env.MASTER_BOT_TOKEN); // Use environment variable