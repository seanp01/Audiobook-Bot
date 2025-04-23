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
const { saveCache, getUserBooksInProgress, loadUserPositions, scheduleUserPositionSaving, listAudiobooks, getM4BCoverImage, getM4BMetaData, findClosestMatch, getFileNameFromTitle, skipAudiobook, retrieveAudiobookFilePaths, selectAudiobookAndRetrievePaths, updateAudiobookCache, getUserPosition, } = require('./utils/smbAccess');
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
const smbDrive = process.env.REMOTE_DRIVE_LETTER;
const networkUsername = process.env.NETWORK_USERNAME; // Replace with your network username
const networkPassword = process.env.NETOWRK_PASSWORD; // Replace with your network password

const audioDurationCache = new Map();

let isDriveMounted = false;
let streampalonline = false;  
let guild = null;
let onlineMembers = [];

let skipAdjustment = 0;

const userPositionFilePath = path.join(__dirname, 'utils', 'userPosition.json');
const userMessageMapFilePath = path.join(__dirname, 'utils', 'userMessageMap.json');
const platform = os.platform();
const baseDir = platform === 'win32' 
? `${smbDrive}` // Windows UNC path
: '/mnt/audiobooks'; // Linux mount point

// Map to store connections and players for each user
const userPlaybackSpeeds = new Map();
const userCurrentAudiobook = new Map();
const userCurrentChapter = new Map();
const userCurrentPart = new Map();
const userTimestamps = new Map();
const userUiMessageData = new Map(); // Map to store { channelId, messageId }
const userPositionsCache = new Map(); // Cache for user positions
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
    GatewayIntentBits.MessageContent,
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
  } catch (error) {
    console.error(error);
  }

  // Register (or update) new commands
  const commandsToRegister = [
      // new SlashCommandBuilder().setName(Commands.AUDIOBOOK).setDescription('Plays an audiobook selection')
      //     .addStringOption(option => option.setName('title').setDescription('Name of audiobook to play').setRequired(true)),
      // new SlashCommandBuilder().setName(Commands.AUDIOBOOK_IN_PROGRESS).setDescription('Lists audiobooks in progress'),
      // new SlashCommandBuilder().setName(Commands.AUDIOBOOK_LIBRARY).setDescription('Navigate the audiobook library'),
  ];

   for (const command of commandsToRegister) {
     await guild.commands.create(command.toJSON());
   }
  try {
    const members = await guild.members.fetch();
    onlineMembers = members.filter(member => member.presence?.status === 'online');
    const onlineMemberNames = onlineMembers.map(member => member.user.username).join(', ');
    console.log(`Online members: ${onlineMemberNames}`);
    loadUserPositions();
  } catch (error) {
    if (error.code === 'GuildMembersTimeout') {
      console.error('Failed to fetch guild members in time.');
    } else {
      console.error('An error occurred while fetching guild members');
    }
  }
  await checkAndMountNetworkDrive();
  audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
  await loadUserPositionsCache(); // Load user positions from file
  //await refreshAudiblePlusTitles();
  // await updateAudiobookCache();
  // saveCache();
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
          await interaction.deferReply({ ephemeral: true }); 
          await executeAudiobookCommand(interaction, await findClosestMatch(interaction.options.getString('title')));
          break;
        case Commands.AUDIOBOOK_LIBRARY:
          await interaction.deferReply();
          await showLibraryMenu(interaction);
          break;
        case Commands.AUDIOBOOK_IN_PROGRESS:
          if (interaction.replied) await interaction.editReply("Loading..."); 
          const booksInProgress = await getUserBooksInProgress(interaction.user.id);
          if (booksInProgress.length === 0) {

            if (interaction.replied || interaction.deferred) await interaction.followUp('You have no audiobooks in progress.');
            else await interaction.reply('You have no audiobooks in progress.');
            return;
          }
          const buttons = booksInProgress.map((book) => {
            return new ButtonBuilder()
              .setCustomId(`resume_${book.title.replace(' (Unabridged)', '').split(':')[0]}`) // Use the original title in the customId
              .setLabel(book.title.split(':')[0]) // Display the normalized title
              .setStyle(ButtonStyle.Primary);
          });
        
          // Split buttons into rows of 5
          const rows = [];
          for (let i = 0; i < buttons.length; i += 5) {
            rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
          }
          
          // Send the message with multiple rows of buttons
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
              content: 'Select a book to resume:',
              components: rows,
              ephemeral: true,
            });  
          } else {
            await interaction.reply({
              content: 'Select a book to resume:',
              components: rows,
              ephemeral: true,
            });
          }   
          break;
        default:
          if (!interaction.replied && !interaction.deferred) await interaction.reply('Command not recognized.');
          break;
      }
    } else if (interaction.isButton()) {
      const command = interaction.customId;
      if (command.startsWith('remove_')) {
        const bookTitle = command.replace('remove_', '');
  
        // Ask for confirmation
        await interaction.reply({
          content: `Are you sure you want to remove "${bookTitle}" from your in-progress list?`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`confirm_remove_${bookTitle}`)
                .setLabel('Yes')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId('cancel_remove')
                .setLabel('No')
                .setStyle(ButtonStyle.Secondary)
            ),
          ],
          ephemeral: true,
        });
      } else if (command.startsWith('confirm_remove_')) {
        const bookTitle = command.replace('confirm_remove_', '');
        const userId = interaction.user.id;
  
        // Remove the book from the user's position cache
        if (!userPositionsCache[userId]) {
          await loadUserPositionsCache();
        }
        const userPositions = userPositionsCache[userId] || {};
        delete userPositions[bookTitle];
        userPositionsCache[userId] = userPositions;
  
        // Persist the changes to the file
        await syncPositionsToFile();
  
        await interaction.update({
          content: `"${bookTitle}" has been removed from your in-progress list.`,
          components: [],
        });
      } else if (command === 'cancel_remove') {
        await interaction.update({
          content: 'Action canceled.',
          components: [],
        });
      }
      if (!command.startsWith('resume_') && !interaction.replied && !interaction.deferred) await interaction.deferUpdate(); // Defer the reply to acknowledge the interaction

      if (command.startsWith('resume_')) {
        const rawTitle = command.replace('resume_', '');
        const normalizedTitle = normalizeTitle(rawTitle);
        if (interaction.replied) await interaction.editReply(`Loading ${normalizedTitle}...`); // Delete the previous reply if it exists
        else if (!interaction.replied && !interaction.deferred) await interaction.reply(`Loading ${normalizedTitle}...`); // Show the loading message
        const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
        if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks
        const originalTitle = audiobooks.find((book) => normalizeTitle(book.title).includes(normalizedTitle))?.title;
        // Execute the audiobook command to start a new session
        await executeAudiobookCommand(interaction, originalTitle.replace(' (Unabridged)', '').split(':')[0]); // Use the original title in the command
      } else if (command === 'library_search') {
        // Prompt the user for a search query
        await interaction.followUp({
          content: 'Please enter your search query:',
          ephemeral: true, // Only visible to the user
        });

        // Wait for the user's response
        const filter = (response) => response.author.id === interaction.user.id;
        const collected = await interaction.channel.awaitMessages({
          filter,
          max: 1,
          time: 30000, // 30 seconds timeout
          errors: ['time'],
        }).catch(() => null);

        if (!collected || collected.size === 0) {
          await interaction.followUp({
            content: 'You did not provide a search query in time.',
            ephemeral: true,
          });
          return;
        }

        const searchQuery = collected.first().content.trim();
        await collected.first().delete(); // Delete the user's message for cleanliness

        // Perform the search
        await showSearchResults(interaction, searchQuery);
      } else if (command.startsWith('library_browse_all')) {
        const page = parseInt(command.split('_').pop(), 10) || 0;
        await showBrowseAllMenu(interaction, page);
      } else if (command.startsWith('library_genres')) {
        const genreCommand = command.split('_').pop();
        if (genreCommand === 'menu') {
          await showGenresMenu(interaction);
        } else {
          let genre = command.replace('library_genres_', '');
          const page = parseInt(command.split('_').pop(), 10) || 0;
          if (page > 0 || (page == 0 && genre.split('_').at(-1) == '0')) { // Wierd logic loop
            genre = genre.split('_')[0];
          } else {
            genre = genre.replace(/_/g, ' ');
          }
          await showGenreBooksMenu(interaction, genre, page);
        }
      } else if (command.startsWith('library_in_progress')) {
        const page = parseInt(command.split('_').pop(), 10) || 0;
        await showInProgressMenu(interaction, page);
      } else if (command.startsWith('library_back')) {
        await showLibraryMenu(interaction);
      } else if (command.startsWith('start_or_resume')) {
        const bookTitle = command.replace('start_or_resume_', '').replace(' (Unabridged)', '').split('_')[0];
        const normalizedTitle = normalizeTitle(bookTitle);
        const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
        if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks
        const originalTitle = audiobooks.find((book) => normalizeTitle(book.title).includes(normalizedTitle))?.title;

        await executeAudiobookCommand(interaction, originalTitle);
      } else if (command.startsWith('search_results_')) {
        const parts = command.split('_');
        const searchQuery = parts.slice(2, -1).join('_'); // Extract the search query
        const page = parseInt(parts[parts.length - 1], 10); // Extract the page number
  
        // Show the search results for the specified page
        await showSearchResults(interaction, searchQuery, page);
      } else if (command.startsWith('library_authors_menu')) {
        const page = parseInt(command.split('_').pop(), 10) || 0; // Extract the page number
        await showAuthorsMenu(interaction, page);
      } else if (command.startsWith('library_author_')) {
        const parts = command.split('_');
        const author = parts.slice(2, -1).join(' ').replace(/_/g, ' '); // Extract the author name
        const page = parseInt(parts[parts.length - 1], 10) || 0; // Extract the page number
        await showAuthorBooksMenu(interaction, author, page);
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
  }
});

masterBot.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const newUserChannel = newState.channel;
    const oldUserChannel = oldState.channel;
    // check if user is a bot
    if (newState.member.user.bot || newUserChannel == oldUserChannel) return; // Ignore bot users
    // Check if the user joined a voice channel
    if (newUserChannel && newUserChannel.name.startsWith('private-session-')) {
      console.log(`User ${newState.member.user.tag} joined voice channel ${newUserChannel.name}`);

      // Send the library menu in the associated text channel
      await newUserChannel.send({
        content: `Welcome to your private session, ${newState.member.user.tag}! Here are your audiobook options:`,
      });

      // Use the showLibraryMenu function to send the buttons
      await showLibraryMenu({
        editReply: async (data) => {
          await newUserChannel.send({
            content: data.content, // The message content
            components: data.components || [], // The components (e.g., buttons, select menus)
          });
        },
      });
    }

    // Handle when the user leaves the voice channel
    if (!newUserChannel && oldUserChannel && oldUserChannel.name.startsWith('private-session-')) {
      console.log(`User ${oldState.member.user.tag} left voice channel ${oldUserChannel.name}`);
    }
  } catch (error) {
    console.error('Error handling voiceStateUpdate:', error);
  }
});

let isSyncingPositions = false; // Flag to prevent concurrent sync operations

async function syncPositionsToFile() {
  if (isSyncingPositions) {
    return; // Exit if the function is already running
  }
  isSyncingPositions = true; // Set the lock
  try {
    let existingData = {};

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

async function showSearchResults(interaction, searchQuery, page = 0) {
  try {
    await interaction.editReply({
      content: `Loading results for '${searchQuery}'...`
    });
    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks

    // Filter audiobooks based on the search query (case-insensitive)
    const searchResults = audiobooks.filter((book) =>
      book.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (searchResults.length === 0) {
      await interaction.editReply({
        content: `No audiobooks found for the search query: "${searchQuery}"`,
        ephemeral: true,
      });
      return;
    }

    // Paginate the search results
    const resultsPerPage = 10; // Maximum of 10 results per page (2 rows of 5 buttons)
    const paginatedResults = searchResults.slice(page * resultsPerPage, (page + 1) * resultsPerPage);

    // Create buttons for each search result
    const buttons = paginatedResults.map((book, index) => {
      const truncatedTitle = book.title.replace(' (Unabridged)', '').split(':')[0];
      return new ButtonBuilder()
        .setCustomId(`start_or_resume_${truncatedTitle}_${page}_${index}`) // Ensure unique customId
        .setLabel(truncatedTitle)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📘'); // Placeholder emoji
    });

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    // Add pagination buttons
    const paginationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`search_results_${searchQuery}_${page - 1}`)
        .setLabel('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0), // Disable the "previous" button on the first page
      new ButtonBuilder()
        .setCustomId(`search_results_${searchQuery}_${page + 1}`)
        .setLabel('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * resultsPerPage >= searchResults.length), // Disable the "next" button on the last page
      new ButtonBuilder()
        .setCustomId('library_back') // Back button to return to the library menu
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Add the pagination row to the rows array
    rows.push(paginationButtons);

    // Send the search results
    await interaction.editReply({
      content: `Search Results for: "${searchQuery}" (Page ${page + 1} of ${Math.ceil(searchResults.length / resultsPerPage)}):`,
      components: rows,
    });
  } catch (error) {
    console.error('Error showing search results:', error);
    await interaction.editReply({
      content: 'An error occurred while searching for audiobooks.',
      ephemeral: true,
    });
  }
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

async function showAuthorBooksMenu(interaction, author, page = 0) {
  try {
    await interaction.editReply({
      content: `Loading books by ${author}...`
    });
    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks

    // Filter audiobooks by author
    const authorBooks = audiobooks.filter((book) => book.author === author);
    const paginatedBooks = authorBooks.slice(page * 10, (page + 1) * 10);

    if (paginatedBooks.length === 0) {
      await interaction.editReply(`No books found for the author: ${author}`);
      return;
    }

    // Create buttons for each book
    const buttons = paginatedBooks.map((book, index) => {
      const truncatedTitle = book.title.replace(' (Unabridged)', '').split(':')[0];
      return new ButtonBuilder()
        .setCustomId(`start_or_resume_${truncatedTitle}_${page}_${index}`) // Ensure unique customId
        .setLabel(truncatedTitle)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📘'); // Placeholder emoji
    });

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    // Add pagination buttons
    const paginationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`library_author_${author.replace(/\s+/g, '_')}_${page - 1}`)
        .setLabel('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`library_author_${author.replace(/\s+/g, '_')}_${page + 1}`)
        .setLabel('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * 10 >= authorBooks.length),
      new ButtonBuilder()
        .setCustomId('library_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Add the pagination row to the rows array
    rows.push(paginationButtons);

    // Send the updated message
    await interaction.editReply({
      content: `Books by Author: ${author} (Page ${page + 1}):`,
      components: rows,
    });
  } catch (error) {
    console.error('Error showing author books menu:', error);
    await interaction.editReply('An error occurred while loading books for this author.');
  }
}

async function showAuthorsMenu(interaction, page = 0) {
  try {
    await interaction.editReply({
      content: `Loading Authors...`
    });
    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks

    // Extract unique authors
    const authors = [...new Set(audiobooks.map((book) => book.author))].sort();

    if (authors.length === 0) {
      await interaction.editReply('No authors found in the audiobook library.');
      return;
    }

    // Pagination logic
    const resultsPerPage = 10; // Maximum of 10 authors per page
    const paginatedAuthors = authors.slice(page * resultsPerPage, (page + 1) * resultsPerPage);
    // Create buttons for each author
    const buttons = paginatedAuthors.map((author) => {
      const cleanAuthor = author.length > 50 ? `${author.slice(0, 47)}...` : author;
      return new ButtonBuilder()
        .setCustomId(`library_author_${cleanAuthor.replace(/\s+/g, '_')}_0`) // Replace spaces with underscores for customId
        .setLabel(cleanAuthor) // Truncate long author names
        .setStyle(ButtonStyle.Primary)
    });

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    // Add pagination buttons
    const paginationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`library_authors_menu_${page - 1}`)
        .setLabel('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0), // Disable the "previous" button on the first page
      new ButtonBuilder()
        .setCustomId(`library_authors_menu_${page + 1}`)
        .setLabel('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * resultsPerPage >= authors.length), // Disable the "next" button on the last page
      new ButtonBuilder()
        .setCustomId('library_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Add the pagination row to the rows array
    rows.push(paginationButtons);

    // Send the paginated authors menu
    await interaction.editReply({
      content: `Select an Author (Page ${page + 1} of ${Math.ceil(authors.length / resultsPerPage)}):`,
      components: rows,
    });
  } catch (error) {
    console.error('Error showing authors menu:', error);
    await interaction.editReply('An error occurred while loading authors.');
  }
}

async function sendInteractionToMinion(minion, playbackData, commandType = 'playback') {
  try {
    const minionProcess = minionProcesses.get(minion.id);
    if (!minionProcess) {
      console.error(`Minion bot ${minion.id} is not running.`);
      return;
    }

    minionProcess.send({
      type: commandType,
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

const userMinionMap = new Map(); // Map to track which minion is assigned to each user

async function executeAudiobookCommand(interaction, bookTitle = null) {
  try {
    const userId = interaction.user.id;
    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks

    // Use the original title for storage
    const originalTitle = audiobooks.find((book) => book.title === bookTitle)?.title || bookTitle;

    // Check if the book is already in progress
    const userPosition = getUserPosition(userId, originalTitle);
    let currentChapter = userPosition?.chapter || 1;
    let currentPart = userPosition?.part || 0;
    let currentTimestamp = userPosition?.timestamp || 0;

    // Check if the user already has an assigned minion
    const assignedMinion = userMinionMap.get(userId);

    if (assignedMinion) {
      if (!interaction.replied && !interaction.deferred) await interaction.reply(`Loading ${originalTitle}...`); // Show the loading message
      const playbackData = {
        userID: userId,
        audiobookTitle: originalTitle,
        currentPart: currentPart,
        currentChapter: currentChapter,
        currentTimestamp: currentTimestamp,
        channelID: interaction.channel.id,
        guildID: interaction.guild.id,
      };

      await sendInteractionToMinion(assignedMinion, playbackData, 'playback');
      userCurrentAudiobook.set(userId, originalTitle);
      userCurrentChapter.set(userId, currentChapter);
      userCurrentPart.set(userId, currentPart);
      userTimestamps.set(userId, currentTimestamp);

      // Delete the loading message
      if (interaction.replied) await interaction.deleteReply(); 
      return;
    }

    // Find the next available minion
    const availableMinion = minionBots.find((minion) => minion.isActive && !minion.isInUse);

    if (!availableMinion) {
      console.error('No available minions at the moment.');
      await interaction.editReply('No available minions at the moment.');
      return;
    }

    availableMinion.isInUse = true;

    // Assign the minion to the user
    userMinionMap.set(userId, availableMinion);

    const playbackData = {
      userID: userId,
      audiobookTitle: originalTitle,
      currentPart: currentPart,
      currentChapter: currentChapter,
      currentTimestamp: currentTimestamp,
      channelID: interaction.channel.id,
      guildID: interaction.guild.id,
    };

    await sendInteractionToMinion(availableMinion, playbackData, 'playback');

    userCurrentAudiobook.set(userId, originalTitle);
    userCurrentChapter.set(userId, currentChapter);
    userCurrentPart.set(userId, currentPart);
    userTimestamps.set(userId, currentTimestamp);

    // Delete the loading message
    await interaction.deleteReply();
  } catch (error) {
    console.error('Error executing audiobook command');
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply('An error occurred while executing the command.');
    } else {
      await interaction.editReply('An error occurred while executing the command.');
    }
  }
}

async function showLibraryMenu(interaction) {
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('library_browse_all_0')
      .setLabel('Browse All')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('library_genres_menu')
      .setLabel('Genres')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('library_in_progress_0')
      .setLabel('In-Progress')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('library_search')
      .setLabel('Search 🔍')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('library_authors_menu') // Add the Authors button
      .setLabel('Authors')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.editReply({
    content: 'Audiobook Library Menu:',
    embeds: [], // No embeds for this menu
    components: [buttons],
  });
}

let audiobookCache;

async function showBrowseAllMenu(interaction, page) {
  try {
    await interaction.editReply({
      content: `Loading library...`
    });
    if (!interaction.replied && !interaction.deferred) await interaction.reply('Loading menu...'); // Show the loading message

    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks
    const paginatedBooks = audiobooks.slice(page * 10, (page + 1) * 10);

    // Create buttons for each book
    const buttons = paginatedBooks.map((book, index) => {
      const truncatedTitle = book.title.replace(' (Unabridged)', '').split(':')[0];
      return new ButtonBuilder()
        .setCustomId(`start_or_resume_${truncatedTitle}_${page}_${index}`) // Ensure unique and valid custom_id
        .setLabel(truncatedTitle) // Full title for the button label
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📘'); // Placeholder emoji
    });

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    // Add pagination buttons in a separate row
    const paginationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`library_browse_all_${page - 1}`)
        .setLabel('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`library_browse_all_${page + 1}`)
        .setLabel('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * 10 >= audiobooks.length),
      new ButtonBuilder()
        .setCustomId('library_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Add the pagination row to the rows array
    rows.push(paginationButtons);

    // Send the updated message
    await interaction.editReply({
      content: `Browse All Audiobooks (Page ${page + 1}):`,
      components: rows,
    });

    // Delete the loading message
    //await interaction.deleteReply();
  } catch (error) {
    console.error('Error showing browse all menu:', error);
    await interaction.editReply('An error occurred while loading the browse all menu.');
  }
}

async function showGenresMenu(interaction) {
  try {
    await interaction.editReply({
      content: `Loading genres...`
    });
    const audiobookCatalogChannel = interaction.guild.channels.cache.find(
      (channel) => channel.name === 'library-catalog' && channel.type === 0 // 0 = Text channel
    );

    if (!audiobookCatalogChannel) {
      await interaction.editReply('The #library-catalog channel could not be found.');
      return;
    }

    // Fetch the last 100 messages from the channel
    const messages = await audiobookCatalogChannel.messages.fetch({ limit: 100 });
    const content = messages.map((msg) => msg.content).join('\n');

    // Extract genres from the content
    const genreRegex = /(?:🔥|⚔️|⚡|🧠|🏛️|🌍|🎭) (.+?)(?:\n|$)/g;
    const genres = [];
    let match;
    while ((match = genreRegex.exec(content)) !== null) {
      genres.push(match[1].trim());
    }

    if (genres.length === 0) {
      await interaction.editReply('No genres found in the #library-catalog channel.');
      return;
    }

    // Create buttons for each genre
    const buttons = genres.map((genre) =>
      new ButtonBuilder()
        .setCustomId(`library_genres_${genre.replace(/\s+/g, '_')}`) // Replace spaces with underscores for customId
        .setLabel(genre)
        .setStyle(ButtonStyle.Primary)
    );

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    // Add a back button in a separate row
    const backButtonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('library_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Send the genre buttons with the back button
    await interaction.editReply({
      content: 'Select a Genre:',
      components: [...rows, backButtonRow], // Include all rows and the back button row
    });
  } catch (error) {
    console.error('Error showing genres menu:', error);
    await interaction.editReply('An error occurred while loading genres.');
  }
}

async function showGenreBooksMenu(interaction, genre, page) {
  await interaction.editReply({
    content: `Loading books in ${genre}...`
  });
  try {
    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks

    // Filter audiobooks by genre
    const genreBooks = audiobooks.filter((book) => book.genre === genre);
    const paginatedBooks = genreBooks.slice(page * 10, (page + 1) * 10);

    if (paginatedBooks.length === 0) {
      await interaction.editReply(`No books found for the genre: ${genre}`);
      return;
    }
    // Create buttons for each book
    const buttons = paginatedBooks.map((book, index) => {
      const truncatedTitle = book.title.replace(' (Unabridged)', '').split(':')[0];
      return new ButtonBuilder()
        .setCustomId(`start_or_resume_${truncatedTitle}_${page}_${index}`) // Ensure unique customId
        .setLabel(truncatedTitle)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📘') // Placeholder emoji
      }
    );

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    // Add pagination buttons
    const paginationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`library_genres_${genre}_${page - 1}`)
        .setLabel('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`library_genres_${genre}_${page + 1}`)
        .setLabel('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * 10 >= genreBooks.length),
      new ButtonBuilder()
        .setCustomId('library_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Add the pagination row to the rows array
    rows.push(paginationButtons);

    // Send the updated message
    await interaction.editReply({
      content: `Books in Genre: ${genre} (Page ${page + 1}):`,
      components: rows,
    });
  } catch (error) {
    console.error('Error showing genre books menu:', error);
    await interaction.editReply('An error occurred while loading books for this genre.');
  }
}

async function showInProgressMenu(interaction, page = 0) {
  try {
    await interaction.editReply({
      content: `Loading listens...`,
    });

    const audiobooks = audiobookCache ?? await listAudiobooks(); // Fetch all audiobooks
    if (!audiobookCache) audiobookCache = audiobooks; // Cache the audiobooks

    const userId = interaction.user.id;
    const booksInProgress = await getUserBooksInProgress(userId); // Fetch books in progress

    if (booksInProgress.length === 0) {
      await interaction.editReply('You have no audiobooks in progress.');
      return;
    }

    // Ensure the page is within bounds
    if (page < 0 || page >= booksInProgress.length) {
      await interaction.editReply('Invalid page number.');
      return;
    }

    // Get the book for the current page
    const book = booksInProgress[page];
    const audiobookData = audiobooks.find((ab) => normalizeTitle(ab.title).includes(normalizeTitle(book.title)));
    const bookDuration = audiobookData.playtime; // Total duration of the book
    const { progress, coverImagePath } = await calculateUserProgress(book, bookDuration); // User's progress percentage
    
    const coverImageUrl = getDynamicCoverImageUrl(path.basename(path.normalize(coverImagePath)));

    // Create the embed for the book
    const embed = new EmbedBuilder()
    .setTitle(audiobookData.title.replace(' (Unabridged)', '').split(':')[0])
    .setDescription(`Progress: ${progress}%\n\n${createProgressBar(progress)}`) // Add the progress bar
    .setThumbnail(coverImageUrl) // Add the cover image
    .setColor('#0099ff');

    // Create buttons for "Resume" and "Remove"
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`resume_${audiobookData.title.replace(' (Unabridged)', '').split(':')[0]}`)
        .setLabel('Resume')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`remove_${audiobookData.title.replace(' (Unabridged)', '').split(':')[0]}`)
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger)
    );

    // Add pagination buttons
    const paginationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`library_in_progress_${page - 1}`)
        .setLabel('⬅️ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0), // Disable "Previous" on the first page
      new ButtonBuilder()
        .setCustomId(`library_in_progress_${page + 1}`)
        .setLabel('Next ➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === booksInProgress.length - 1), // Disable "Next" on the last page
      new ButtonBuilder()
        .setCustomId('library_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Danger)
    );

    // Send the embed with buttons
    await interaction.editReply({
      content: `Book ${page + 1} of ${booksInProgress.length}:`,
      embeds: [embed],
      components: [buttons, paginationButtons],
    });
  } catch (error) {
    console.error('Error showing in-progress menu:', error);
    await interaction.editReply('An error occurred while loading books in progress.');
  }
}

// Helper function to calculate user progress
async function calculateUserProgress(book, bookDuration) {
  let totalProgress = 0;
  let fileName = await findClosestMatch(book.title);
  // Add durations for all completed chapters
  for (let i = 0; i < book.chapter; i++) {
    const { outputPaths: chapterParts, originalFilePath: originalFilePath } = await selectAudiobookAndRetrievePaths(book.title, i + 1, 0, 0);
    if (!chapterParts || chapterParts.length === 0) {
      console.warn(`No parts found for chapter ${i + 1} of ${book.title}`);
      continue; // Skip if no parts are found
    }
    const durations = await Promise.all(chapterParts.map((part) => getCachedAudioDuration(path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(part))))));
    totalProgress += durations.reduce((sum, duration) => sum + duration, 0);
  }

  // Add durations for completed parts in the current chapter
  const { outputPaths: currentChapterParts, originalFilePath: originalFilePath, metadata: metadata, coverImagePath: coverImagePath, } = await selectAudiobookAndRetrievePaths(book.title, book.chapter + 1, 0, 0);
  const currentPartDurations = await Promise.all(
    currentChapterParts.slice(0, book.part).map((part) => getCachedAudioDuration(path.join(baseDir, fileName.split('.')[0], path.basename(path.normalize(part)))))
  );
  totalProgress += currentPartDurations.reduce((sum, duration) => sum + duration, 0);

  // Add the current timestamp within the current part
  totalProgress += book.timestamp;
  const progress = bookDuration > 0 ? Math.round((totalProgress / (bookDuration * 1000)) * 100) : 0;
  // Calculate the progress percentage
  return { progress: progress, coverImagePath: coverImagePath };
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

async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (err, stdout) => {
        if (err) {
          return reject(err);
        }
        resolve(parseFloat(stdout) * 1000);
      }
    );
  });
}

async function fetchAudiblePlusTitles() {
  return new Promise((resolve, reject) => {
    exec('python ./DiscordBot/utils/getAudiblePlusLibrary.py', (error, stdout, stderr) => {
      if (error) {
        console.error('Error executing Python script:', error);
        return reject(error);
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (parseError) {
        console.error('Error parsing Python script output:', parseError);
        reject(parseError);
      }
    });
  });
}

const cacheFilePath = path.join(__dirname, 'temp', 'audiblePlusCache.json');

async function updateAudiblePlusChannel(channelName) {
  try {
    // Check if the cache exists and is recent
    let audiblePlusTitles = [];
    const now = new Date();
    if (fs.existsSync(cacheFilePath)) {
      const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (lastUpdated > oneWeekAgo) {
        console.log('Skipping Update.');
        return;
      }
    }

    // If no recent cache, fetch new data
    if (audiblePlusTitles.length === 0) {
      console.log('Fetching new Audible Plus titles...');
      audiblePlusTitles = await fetchAudiblePlusTitles();

      // Save the new data to the cache
      const cacheData = {
        lastUpdated: now.toISOString(),
        titles: audiblePlusTitles,
      };
      fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2));
    }

    const channel = guild.channels.cache.find(
      (ch) => ch.name === channelName && ch.type === 0 // 0 = Text channel
    );
    if (!channel) {
      console.error(`Channel "${channelName}" not found.`);
      return;
    }

    if (audiblePlusTitles.length === 0) {
      await channel.send('No Audible Plus titles found.');
      return;
    }

    // Send a separator message with the current date
    const currentDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    await channel.send(`**📅 Audible Plus Titles List - Updated on ${currentDate}**`);

    // Group books by genres
    const booksByGenre = {};
    audiblePlusTitles.forEach((title) => {
      const genres = title.genres == "Unknown Genre" ? ['Unknown Genre'] : title.genres || ['Unknown Genre'];
      for (const genre of genres) {
        if (!booksByGenre[genre]) {
          booksByGenre[genre] = [];
        }
        booksByGenre[genre].push(title);
      };
    });

    // Post books by genre
    for (const [genre, books] of Object.entries(booksByGenre)) {
      const embeds = books.map((title) => {
        const embed = new EmbedBuilder()
          .setTitle(`📘 ${title.title}`)
          .addFields(
            { name: 'Author(s)', value: title.authors, inline: true },
            { name: 'Available Until', value: `(${title.days_left} days left)`, inline: true }
          )
          .setColor('#0099ff');

        // Add the cover image if it exists
        if (title.cover_image && title.cover_image !== 'No Image Available') {
          embed.setThumbnail(title.cover_image); // Use setThumbnail for a smaller image
        }

        return embed;
      });

      // Send embeds in batches of 10
      for (let i = 0; i < embeds.length; i += 10) {
        await channel.send({
          content: `**Genre: ${genre}**`,
          embeds: embeds.slice(i, i + 10),
        });
      }
    }

    // Add a "Leaving Soon" section
    const leavingSoon = audiblePlusTitles
      .filter((title) => title.days_left <= 30) // Titles leaving in 30 days or less
      .sort((a, b) => a.days_left - b.days_left); // Sort by days left

    if (leavingSoon.length > 0) {
      const embeds = leavingSoon.map((title) => {
        const embed = new EmbedBuilder()
          .setTitle(`📘 ${title.title}`)
          .addFields(
            { name: 'Author(s)', value: title.authors, inline: true },
            { name: 'Available Until', value: `(${title.days_left} days left)`, inline: true }
          )
          .setColor('#ff0000'); // Use red to indicate urgency

        // Add the cover image if it exists
        if (title.cover_image && title.cover_image !== 'No Image Available') {
          embed.setThumbnail(title.cover_image); // Use setThumbnail for a smaller image
        }

        return embed;
      });

      // Send the "Leaving Soon" section
      for (let i = 0; i < embeds.length; i += 10) {
        await channel.send({
          content: '**📅 Titles Leaving Soon:**',
          embeds: embeds.slice(i, i + 10),
        });
      }
    }
  } catch (error) {
    console.error('Error updating Audible Plus channel:', error);
  }
}

async function refreshAudiblePlusTitles() {
  try {
    await updateAudiblePlusChannel('included-in-audible-plus');
  } catch (error) {
    console.error('Error refreshing Audible Plus titles:', error);
  }
}

async function getCoverImageEmoji(filePath) {
  const coverImagePath = await getM4BCoverImage(filePath);
  return coverImagePath; // Placeholder emoji
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

function createProgressBar(progress) {
  const totalBars = 20; // Total number of bars in the progress bar
  const filledBars = Math.round((progress / 100) * totalBars); // Calculate the number of filled bars
  const emptyBars = totalBars - filledBars; // Calculate the number of empty bars

  const bar = '█'.repeat(filledBars) + '━'.repeat(emptyBars); // Create the progress bar
  return `${bar}`; // Wrap the bar in square brackets
}

function getDynamicCoverImageUrl(coverImageFile) {
  coverImageFile = path.basename(path.normalize(coverImageFile)).split('\\').at(-1); // Get the file name without the path
  const baseUrl = `http://${coverArtAddress}:${coverArtPort}/images/`; 
  return `${baseUrl}${coverImageFile}`;
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
      exec(`net use ${smbDrive} ${smbPath}`, (error, stdout, stderr) => {
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
          `sudo mount -t cifs ${smbPath} ${linuxMountPoint} -o username=${networkUsername},password=${networkPassword},vers=3.0,iocharset=utf8,sec=ntlmssp`,
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

function normalizeTitle(title) {
  return title
    .toLowerCase() // Convert to lowercase
    .trim() // Remove leading and trailing whitespace
    .replace(/\s+/g, ' ') // Replace multiple spaces with a single space
    .replace(/[^a-z0-9\s]/g, ''); // Remove special characters
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

setInterval(async () => {
  console.log('Refreshing Audible Plus titles...');
  await refreshAudiblePlusTitles();
}, 24 * 60 * 60 * 1000); // Refresh every 24 hours

//login into the bot
masterBot.login(process.env.MASTER_BOT_TOKEN); // Use environment variable