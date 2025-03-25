const path = require('path');
const fs = require('fs');
const os = require('os');
const fuzzball = require('fuzzball');
const { exec, spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid'); // Import uuid
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');

const cacheFilePath = path.join(__dirname, 'audiobookCache.json');
const userPositionFilePath = path.join(__dirname, 'userPosition.json');
const localOutputDir = path.join(__dirname, '../temp'); // Define local directory

let cachedAudiobooks = [];
let titleToFileMap = {};
let cacheTimestamp = 0;
// In-memory cache for user positions
let userPositionsCache = {};
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const axios = require('axios');
const dvrAddress = process.env.DVR_ADDRESS;
const dvrPort = process.env.DVR_PORT;
const hostServiceUrl = `http://${dvrAddress}:${dvrPort}`;
const dvrDeviceName = process.env.DVR_DEVICE_NAME;

// Ensure the local output directory exists
if (!fs.existsSync(localOutputDir)) {
  fs.mkdirSync(localOutputDir, { recursive: true });
}

// Load cache from JSON file
function loadCache() {
  if (fs.existsSync(cacheFilePath)) {
    const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
    cachedAudiobooks = cacheData.cachedAudiobooks;
    titleToFileMap = cacheData.titleToFileMap;
    cacheTimestamp = cacheData.cacheTimestamp;
    console.log('Cache loaded from file');
  }
}

// Save cache to JSON file
function saveCache() {
  const cacheData = {
    cachedAudiobooks,
    titleToFileMap,
    cacheTimestamp,
  };
  fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2));
  console.log('Cache saved to file');
}

async function listAudiobooks() {
  try {
    const response = await axios.get(`${hostServiceUrl}/audiobooks`);
    return response.data;
  } catch (error) {
    console.error('Error listing audiobooks:', error);
    throw error;
  }
}

async function retrieveAudiobookFilePaths(fileName, chapter, part = 0, startTime = 0, duration = MAX_FILE_SIZE) {
  // Determine the base directory based on the operating system
  const platform = os.platform();
  const baseDir = platform === 'win32' 
    ? '\\\\${dvrDeviceName}\\Audiobooks' // Windows UNC path
    : '/mnt/audiobooks'; // Linux mount point

  const audiobookDir = path.join(baseDir, fileName.split('.')[0]);

  console.log('Current working directory:', process.cwd());
  console.log('Reading directory:', audiobookDir);

  try {
    // Check if the directory exists
    if (!fs.existsSync(audiobookDir)) {
      throw new Error(`Directory does not exist: ${audiobookDir}`);
    }

    console.log(`Directory exists: ${audiobookDir}`);

    const files = await fs.promises.readdir(audiobookDir);

    if (!files || files.length === 0) {
      throw new Error('No files found in directory');
    }

    // Filter and sort files by chapter and part number
    const sortedFiles = files
      .filter(file => path.extname(file) === '.mp3')
      .sort((a, b) => {
        const aMatch = a.match(/(\d+)(?:-(\d+))?/);
        const bMatch = b.match(/(\d+)(?:-(\d+))?/);
        const aChapter = parseInt(aMatch[1], 10);
        const bChapter = parseInt(bMatch[1], 10);
        const aPart = aMatch[2] ? parseInt(aMatch[2], 10) : 0;
        const bPart = bMatch[2] ? parseInt(bPart[2], 10) : 0;
        return aChapter - bChapter || aPart - bPart;
      });

    // Filter files by chapter and part if specified
    const chapterFiles = chapter
      ? sortedFiles.filter(file => new RegExp(`^Chapter_${chapter}(?:-|\\D|$)`).test(file))
      : sortedFiles;

    // Calculate the total size and select files within the duration limit
    let totalSize = 0;
    const selectedFiles = [];
    for (const file of chapterFiles) {
      const filePath = path.join(audiobookDir, file);
      const stats = await fs.promises.stat(filePath);
      totalSize += stats.size;
      selectedFiles.push(filePath);
    }

    // If a startTime is provided, use ffmpeg to copy the mp3 locally starting at the desired timestamp
    if (startTime > 0 && selectedFiles.length > 0) {
      const uniqueFileName = `${uuidv4()}.mp3`; // Generate a unique filename
      const localFilePath = path.join(localOutputDir, uniqueFileName);
      return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
          "-loglevel", "error", // Suppress extra logs, show only errors
          "-ss", startTime / 1000,
          "-i", selectedFiles[part], // Use the first selected file
          "-vn",
          "-b:a", "192k",
          "-c:a", "copy",
          localFilePath
        ]);

        ffmpeg.stdout.on("data", (data) => {
          console.log(`stdout: ${data}`);
        });

        ffmpeg.stderr.on("data", (data) => {
          console.error(`stderr: ${data}`);
        });

        ffmpeg.on("close", (code) => {
          console.log(`FFmpeg exited with code ${code}`);
          if (code === 0) {
            selectedFiles[part] = localFilePath;
            resolve(selectedFiles);
          } else {
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        });
      });
    } else {
      return selectedFiles;
    }
  } catch (error) {
    console.error('Error retrieving audiobook file paths:', error);
    throw error;
  }
}

async function selectAudiobookAndRetrievePaths(userInput, chapter = 0, part = 0, timestamp = 0) {
  const baseDir = os.platform() === 'win32' ? '\\\\${dvrDeviceName}\\Audiobooks' : '/mnt/audiobooks';
  console.log('function selectAudiobook()');
  try {
    // Update the cache if it's expired
    if (Date.now() - cacheTimestamp > CACHE_DURATION) {
      await updateAudiobookCache();
    }

    const closestMatch = findClosestMatch(userInput);
    if (!closestMatch) {
      throw new Error('No matching audiobook found');
    }
    console.log('Closest match:', closestMatch);
    const fileName = titleToFileMap[closestMatch];
    const outputPaths = await retrieveAudiobookFilePaths(fileName, chapter, part, timestamp);

    // Extract metadata and cover image
    const metadata = await getM4BMetadata(path.join(baseDir, fileName));
    const coverImagePath = await getM4BCoverImage(path.join(baseDir, fileName));
    return { outputPaths, metadata, coverImagePath }; // Ensure this returns an object
  } catch (error) {
    console.error('Error selecting audiobook:', error);
    throw error;
  }
}

getFileNameFromTitle = (title) => {
  return titleToFileMap[title]; 
}

function findClosestMatch(userInput) {
  const titles = Object.keys(titleToFileMap);

  const normalizedInput = userInput.toLowerCase();

  // 1. Check for exact matches first
  const exactMatch = titles.find(title => title.toLowerCase() === normalizedInput);
  if (exactMatch) {
    return exactMatch;
  }

  // 2. Check for a prefix match
  const prefixPattern = new RegExp(`^${normalizedInput}:`, 'i');
  const prefixMatch = titles.find(title => prefixPattern.test(title));
  if (prefixMatch) {
    return prefixMatch;
  }

  // 3. Use fuzzy matching with token sorting
  const options = {
    scorer: fuzzball.token_sort_ratio, // More accurate for structured names
    processor: choice => choice.toLowerCase(),
    limit: 1
  };

  const matches = fuzzball.extract(normalizedInput, titles, options);
  const bestMatch = matches.length > 0 ? matches[0] : null;

  // 4. Ensure the match is strong enough
  const MIN_SCORE_THRESHOLD = 40;
  if (bestMatch && bestMatch[1] >= MIN_SCORE_THRESHOLD) {
    return bestMatch[0];
  }

  if (bestMatch && bestMatch[2] >= MIN_SCORE_THRESHOLD) {
    return bestMatch[0];
  }

  return null;
}

function normalizePath(filePath) {
  const platform = os.platform(); // Detect the platform (e.g., 'win32' for Windows, 'linux' for Linux)

  // Replace backslashes with forward slashes for consistency
  let normalizedPath = filePath.replace(/\\/g, '/');

  if (platform === 'win32') {
      // Windows: Remove "<dvrDeviceName>/Audiobooks/" if it exists
      normalizedPath = normalizedPath.replace(new RegExp(`^/?${dvrDeviceName}/Audiobooks/`, 'i'), '');
  } else if (platform === 'linux') {
      // Linux: Remove "mnt/audiobooks/" if it exists
      normalizedPath = normalizedPath.replace(/^\/?mnt\/audiobooks\//, '');
  }

  return normalizedPath;
}

async function updateAudiobookCache() {
  const platform = os.platform();
  const baseDir = platform === 'win32' ? `\\\\${dvrDeviceName}\\Audiobooks` : '/mnt/audiobooks';

  try {
    const files = await fs.promises.readdir(baseDir);
    const audiobooks = files.map(file => ({
      title: path.basename(file, path.extname(file)),
      file: path.join(baseDir, file),
    }));

    cachedAudiobooks = audiobooks;
    console.log('Audiobook cache updated:', cachedAudiobooks);
  } catch (error) {
    console.error('Error updating audiobook cache:', error);
  }
}

async function listAudiobooksFromSource() {
  console.log('function listAudiobooksFromSource()');
  const files = await fs.promises.readdir(`\\\\${dvrDeviceName}\\Audiobooks`);
  return new Promise((resolve, reject) => {
    const audiobooks = files.map(file => {
      const title = path.basename(file, path.extname(file));
      return { file, title };
    });
    console.log('Successfully listed audiobooks from source:', audiobooks);
    resolve(audiobooks);
  });
}

function getUserBooksInProgress(userId) {
  if (!userPositionsCache[userId]) {
    return [];
  }
  return Object.keys(userPositionsCache[userId]).map(title => ({
    title,
    ...userPositionsCache[userId][title]
  }));
}

function loadUserPositions() {
  if (fs.existsSync(userPositionFilePath)) {
    userPositionsCache = JSON.parse(fs.readFileSync(userPositionFilePath, 'utf8'));
  } else {
    userPositionsCache = {};
  }
}

// Store user's last played timestamp in memory
function storeUserPosition(userId, audiobookTitle, chapter, part, timestamp, interaction) {
  if (!userPositionsCache[userId]) {
    userPositionsCache[userId] = {};
  }
  userPositionsCache[userId][audiobookTitle] = { chapter, part, timestamp };
}

// Periodically write the in-memory user positions to the file
function saveUserPositionsToFile() {
  fs.writeFileSync(userPositionFilePath, JSON.stringify(userPositionsCache, null, 2));
  console.log('User positions saved to file');
}

// Schedule periodic saving of user positions every 30 minutes
function scheduleUserPositionSaving() {
  setInterval(saveUserPositionsToFile, 60 * 1000); // every minute
}

// Retrieve user's last played timestamp from memory
function getUserPosition(userId, audiobookTitle) {
  if (userPositionsCache[userId] && userPositionsCache[userId][audiobookTitle]) {
    return userPositionsCache[userId][audiobookTitle];
  }
  return null;
}

async function skipAudiobook(interaction, offset, userPlayers, userCurrentAudiobook, userCurrentPart, userCurrentChapter, updateUIMessage) {
  try {
    const user = interaction.user;
    const player = userPlayers.get(user.id);
    if (!player) {
      await interaction.followUp('No audiobook is currently playing.');
      return;
    }

    // Retrieve the current audiobook title for the user
    const selectedAudiobook = userCurrentAudiobook.get(user.id);
    if (!selectedAudiobook) {
      await interaction.followUp('No audiobook is currently playing.');
      return;
    }

    const userPosition = getUserPosition(user.id, selectedAudiobook);
    let currentChapter = userPosition.chapter || 0;
    let currentTimestamp = userPosition.timestamp || 0;
    let currentPart = userCurrentPart.get(user.id) || 0;
    if (userPosition) {
      currentPart = userPosition.part;
      currentChapter = userPosition.chapter;
      currentTimestamp = userPosition.timestamp;
    }

    // Calculate the new timestamp
    const newTimestamp = currentTimestamp + (offset * 1000);

    // Generate a new MP3 file for the new timestamp
    const { outputPaths: initialChapterParts, metadata, coverImagePath } = await selectAudiobookAndRetrievePaths(selectedAudiobook, currentChapter, currentPart, newTimestamp);

    if (!initialChapterParts || initialChapterParts.length === 0) {
      await interaction.followUp('Error: No parts found.');
      return;
    }

    const currentPartPath = initialChapterParts[currentPart];
    const resource = createAudioResource(currentPartPath);
    player.play(resource);

    // Update the user's position
    storeUserPosition(user.id, selectedAudiobook, currentChapter, currentPart, newTimestamp, interaction);
    await updateUIMessage(`Skipped ${offset} seconds.`);
  } catch (error) {
    console.error('Error skipping audiobook:', error);
    await updateUIMessage('An error occurred while skipping the audiobook.');
  }
}

// Retrieve user's last played timestamp
function getUserPosition(userId, audiobookTitle) {
  const userPositions = JSON.parse(fs.readFileSync(userPositionFilePath, 'utf8'));
  if (userPositions[userId] && userPositions[userId][audiobookTitle]) {
    return userPositions[userId][audiobookTitle];
  }
  return null;
}

// Schedule cache updates once a week
function scheduleCacheUpdates() {
  console.log('function scheduleCacheUpdates()');
  setInterval(updateAudiobookCache, CACHE_DURATION);
}


function getM4BMetadata(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=artist,title', '-of', 'json', filePath], (err, stdout) => {
      if (err) {
        return reject(err);
      }
      const metadata = JSON.parse(stdout);
      const tags = metadata.format.tags || {};
      resolve({
        author: tags.artist || 'Unknown Author',
        title: tags.title || 'Unknown Title',
      });
    });
  });
}

function getM4BCoverImage(filePath) {
  return new Promise((resolve, reject) => {
    const coverImagePath = path.join(localOutputDir, `${uuidv4()}.jpg`);
    const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-an', '-vcodec', 'copy', coverImagePath]);

    ffmpeg.on('close', (code) => {
      resolve(coverImagePath);
    });
  });
}

async function convertFile(filePath, startTime, duration) {
  try {
    const response = await axios.post(`${hostServiceUrl}/convert`, { filePath, startTime, duration });
    return response.data.outputFilePath;
  } catch (error) {
    console.error('Error converting file:', error);
    throw error;
  }
}

// Load cache on startup
loadCache();
scheduleCacheUpdates();

module.exports = {
  listAudiobooks,
  retrieveAudiobookFilePaths,
  selectAudiobookAndRetrievePaths,
  updateAudiobookCache,
  storeUserPosition,
  skipAudiobook,
  getUserPosition,
  findClosestMatch,
  getFileNameFromTitle,
  getM4BCoverImage,
  getM4BMetadata,
  convertFile, 
  loadUserPositions, 
  scheduleUserPositionSaving,
  getUserBooksInProgress
};