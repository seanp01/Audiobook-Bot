const path = require('path');
const fs = require('fs');
const os = require('os');
const fuzzball = require('fuzzball');
const { exec, spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid'); // Import uuid
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const axios = require('axios');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Explicitly load .env from the DiscordBot directory

const dvrAddress = process.env.DVR_ADDRESS;
const dvrPort = process.env.DVR_PORT;
const cacheFilePath = path.join(__dirname, 'audiobookCache.json');
const userPositionFilePath = path.join(__dirname, 'userPosition.json');
const localOutputDir = path.join(__dirname, '../temp'); // Define local directory
const localDriveLetter = process.env.LOCAL_DRIVE_LETTER || 'C:'; // Local drive letter for the host PC
const remoteDriveLetter = process.env.REMOTE_DRIVE_LETTER || 'Z:'; // Remote drive letter for the DVR
const platform = os.platform();
const baseDir = platform === 'win32' 
? `${remoteDriveLetter}` // Windows UNC path
: '/mnt/audiobooks'; // Linux mount point
const hostServiceUrl = `http://${dvrAddress}:${dvrPort}`;

let cachedAudiobooks = null;
let titleToFileMap = {};
let cacheTimestamp = 0;
// In-memory cache for user positions
let userPositionsCache = {};
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const tempFilenameToOriginalMap = new Map(); // Map temporary files to original files

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
    console.error('Error listing audiobooks');
    throw error;
  }
}

async function retrieveAudiobookFilePaths(fileName, chapter, part = 0, startTime = 0, speed = 1) {
  fileName = path.basename(path.normalize(fileName)); // Get the file name without the path
  const audiobookDir = path.join(baseDir, fileName.split('.')[0]);
  const localAudiobookDir = path.join(localDriveLetter, 'Audiobooks', fileName.split('.')[0]);

  try {
    // Check if the directory exists
    if (!fs.existsSync(audiobookDir)) {
      throw new Error(`Directory does not exist: ${audiobookDir}`);
    }

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
    let chapterFiles = chapter
      ? sortedFiles.filter(file => new RegExp(`^Chapter_${chapter}(?:-|\\D|$)`).test(file))
      : sortedFiles;

    if (chapterFiles.length === 0) {
      console.error(`No files found for chapter ${chapter} trying the next chapter`);
      return [];
    }
    const chapterFile = chapterFiles.length > 1 ? chapterFiles[part] : chapterFiles[0];
    const originalFilePath = chapterFile;
    if (startTime > 0) {
            // Use the /process endpoint to generate the temp file
      const response = await axios.post(`${hostServiceUrl}/process`, {
        filePath: path.join(fileName.split('.')[0], path.basename(path.normalize(chapterFile))),
        startTime,
        speed,
        action: 'seek', // Default action is 'seek'
      });

      const tempFileName = path.basename(path.normalize(response.data.tempFilePath));
      //const tempFilePath = path.join(localDriveLetter, 'Audiobooks', 'temp', tempFileName); 
      // Map the temp file to the original file
      tempFilenameToOriginalMap.set(tempFileName, chapterFile);
      chapterFiles[part] = tempFileName; // Update the file path to the temp file
    }

    return { outputPaths: chapterFiles, originalFilePath };
  } catch (error) {
    console.error('Error retrieving audiobook file paths');
    throw error;
  }
}
// Define a cache for metadata and cover image paths
const metaDataCacheMap = new Map();

async function selectAudiobookAndRetrievePaths(userInput, chapter, part = 0, timestamp = 0, speed = 1) {
  try {
    // Find the closest matching audiobook file
    const fileName = path.basename(await findClosestMatch(userInput));
    if (!fileName) {
      throw new Error(`No matching audiobook found for input: ${userInput}`);
    }

    // Update the cache if it's expired
    if (Date.now() - cacheTimestamp > CACHE_DURATION) {
      await updateAudiobookCache();
      cacheTimestamp = Date.now(); // Update the cache timestamp
      saveCache();
    }

    // Check if the fileName is already cached
    if (metaDataCacheMap.has(fileName)) {
      const cachedData = metaDataCacheMap.get(fileName);
      let { outputPaths, originalFilePath } = await retrieveAudiobookFilePaths(fileName, chapter, part, timestamp, speed);
      return {
        outputPaths,
        originalFilePath: originalFilePath,
        metadata: cachedData.metadata,
        coverImagePath: path.basename(path.normalize(cachedData.coverImagePath)),
      };
    }

    // Fetch metadata from the /metadata endpoint
    const metadataResponse = await axios.post(`${hostServiceUrl}/metadata`, {
      filePath: fileName,
    });
    const metadata = metadataResponse.data;

    // Fetch cover image from the /cover endpoint
    const coverResponse = await axios.post(`${hostServiceUrl}/cover`, {
      filePath: fileName,
    });
    const coverImagePath = coverResponse.data.coverImagePath;

    // Retrieve audiobook file paths
    let { outputPaths, originalFilePath } = await retrieveAudiobookFilePaths(fileName, chapter, part, timestamp, speed);

    // Cache the metadata and cover image path
    metaDataCacheMap.set(fileName, {
      metadata,
      coverImagePath,
      originalFilePath: fileName,
    });

    return {
      outputPaths,
      originalFilePath,
      metadata,
      coverImagePath,
    };
  } catch (error) {
    console.error('Error in selectAudiobookAndRetrievePaths');
    throw error;
  }
}

getFileNameFromTitle = (title) => {
  return titleToFileMap[title]; 
}

async function findClosestMatch(userInput) {
  try {
    // Fetch the list of audiobooks
    const audiobooks = cachedAudiobooks ?? await listAudiobooks();
    if (!cachedAudiobooks) cachedAudiobooks = audiobooks; // Cache the audiobooks if not already cached

    const titles = audiobooks.map((book) => book.title); // Extract titles from the list

    const normalizedInput = userInput;

    // 1. Check for exact matches first
    const exactMatch = titles.find((title) => title.toLowerCase().includes(normalizedInput.toLowerCase()));
    if (exactMatch) {
      return path.basename(path.normalize(titleToFileMap[exactMatch])); // Return the mapped filename
    }

    // 2. Check for a prefix match
    const prefixPattern = new RegExp(`^${normalizedInput}:`, 'i');
    const prefixMatch = titles.find((title) => prefixPattern.test(title));
    if (prefixMatch) {
      return path.basename(path.normalize(titleToFileMap[prefixMatch])); // Return the mapped filename
    }

    // 3. Use fuzzy matching with token sorting
    const options = {
      scorer: fuzzball.token_sort_ratio, // More accurate for structured names
      processor: (choice) => choice.toLowerCase(),
      limit: 1,
    };

    const matches = fuzzball.extract(normalizedInput, titles, options);
    const bestMatch = matches.length > 0 ? matches[0] : null;

    // 4. Ensure the match is strong enough
    const MIN_SCORE_THRESHOLD = 40;
    if (bestMatch && bestMatch[1] >= MIN_SCORE_THRESHOLD) {
      return path.basename(path.normalize(titleToFileMap[bestMatch[0]])); // Return the mapped filename
    }

    return null; // No match found
  } catch (error) {
    console.error('Error finding closest match');
    throw error;
  }
}

async function updateAudiobookCache() {
  try {
    // Fetch the list of audiobooks using listAudiobooks
    const audiobooks = await listAudiobooks();

    // Map the audiobooks to the cache format
    cachedAudiobooks = audiobooks.map((book) => ({
      title: book.title, // Use the title from the listAudiobooks response
      file: path.basename(path.normalize(book.file)),   // Use the file path from the listAudiobooks response
    }));

    // Update the titleToFileMap for quick lookups
    titleToFileMap = cachedAudiobooks.reduce((map, book) => {
      map[book.title] = path.basename(path.normalize(book.file));
      return map;
    }, {});

    resolve(audiobooks);
    console.log('Audiobook cache updated successfully');
  } catch (error) {
    console.error('Error updating audiobook cache:', error);
  }
}

async function getUserBooksInProgress(userId) {
  loadUserPositions();
  if (!userPositionsCache[userId]) {
    return [];
  }
  return Object.keys(userPositionsCache[userId]).map(title => ({
    title: title.toLowerCase(), // Normalize title to lowercase
    ...userPositionsCache[userId][title]
  }));
}

async function processFile(filePath, startTime = 0, speed = 1, action = 'seek') {
  try {
    const response = await axios.post(`${hostServiceUrl}/process`, {
      filePath,
      startTime,
      speed,
      action,
    });
    return {
      tempFilePath: path.basename(path.normalize(response.data.tempFilePath)),
      originalFilePath: path.basename(path.normalize(response.data.originalFilePath)),
    };
  } catch (error) {
    console.error(`Error processing file (${action}):`, error);
    throw error;
  }
}

// Request smbService.js to delete a temp file
async function deleteTempFile(tempFilePath) {
  try {
    await axios.delete(`${hostServiceUrl}/temp`, { data: { tempFilePath } });
  } catch (error) {
    console.error('Error deleting temp file:', error);
  }
}

async function loadUserPositionsCache() {
  try {
    if (fs.existsSync(userPositionFilePath)) {
      const fileData = fs.readFileSync(userPositionFilePath, 'utf-8');
      if (fileData.trim()) {
        const existingData = JSON.parse(fileData);
        for (const [userID, userAudiobooks] of Object.entries(existingData)) {
          userPositionsCache[userID] = userAudiobooks;
        }
      } 
    } 
  } catch (error) {
    console.error('loadUserPositionsCache: Error loading user positions from file:', error);
  }
}

function loadUserPositions() {
  try {
    if (fs.existsSync(userPositionFilePath)) {
      const fileData = fs.readFileSync(userPositionFilePath, 'utf8');
      userPositionsCache = JSON.parse(fileData);
    } else {
      userPositionsCache = {};
    }
  } catch (error) {
    console.error('Error loading user positions. Resetting to an empty object:', error);
    userPositionsCache = {}; // Reset to an empty object if the file is invalid
  }
}

let isSaving = false;

function saveUserPositionsToFile() {
  if (isSaving) {
    console.log('Save operation already in progress. Skipping this call.');
    return;
  }

  isSaving = true;

  try {
    fs.writeFileSync(userPositionFilePath, JSON.stringify(userPositionsCache, null, 2));
    console.log('User positions saved to file');
  } catch (error) {
    console.error('Error saving user positions to file:', error);
  } finally {
    isSaving = false;
  }
}

// Schedule periodic saving of user positions every 30 minutes
function scheduleUserPositionSaving() {
  setInterval(saveUserPositionsToFile, 60 * 1000); // every minute
}

// Retrieve user's last played timestamp from memory
function getUserPosition(userId, bookTitle) {
  if (!userPositionsCache[userId]) loadUserPositionsCache();
  const userPositions = userPositionsCache[userId] || {};
  return userPositions[bookTitle] || null; // Use the original title as the key
}


let isUpdatingCache = false;
// Schedule cache updates once a week
function scheduleCacheUpdates() {
  if (isUpdatingCache) {
    console.log('Cache update already in progress. Skipping this call.');
    return;
  }
  isUpdatingCache = true;
  try {
    setInterval(updateAudiobookCache, CACHE_DURATION);
  } catch (error) {
    console.error('Error updating audiobook cache');
  } finally {
    isUpdatingCache = false;
  }
}

async function getChapterCount(title) {
  let fileName = await findClosestMatch(title);
  if (!fileName) {
    throw new Error('No matching audiobook found');
  }  
  fileName = path.basename(path.normalize(fileName)); // Get the file name without the path
  const folderPath = path.join(baseDir, fileName.split('.')[0]);

  // Parse the directory to find all parts
  const files = await fs.promises.readdir(folderPath);
  const chapterCount = files?.length > 0
  ? (() => {
      return files.reduce((maxChapter, file) => {
        // Get the original file path if it's a temp file
        const filePath = tempFilenameToOriginalMap.get(path.basename(path.normalize(file))) || file;

        // Extract the chapter number from the filename
        const match = path.basename(path.normalize(filePath)).match(/Chapter_(\d+)/i);
        const chapterNumber = match ? parseInt(match[1], 10) : 0;

        // Update the maximum chapter number
        return Math.max(maxChapter, chapterNumber);
      }, 0); // Start with 0 as the initial maxChapter value
    })()
  : 0;
  return chapterCount;
}

// Load cache on startup
loadCache();
scheduleCacheUpdates();

module.exports = {
  processFile,
  deleteTempFile,
  getChapterCount,
  listAudiobooks,
  retrieveAudiobookFilePaths,
  selectAudiobookAndRetrievePaths,
  updateAudiobookCache,
  getUserPosition,
  findClosestMatch,
  getFileNameFromTitle,
  loadUserPositions, 
  scheduleUserPositionSaving,
  getUserBooksInProgress,
  saveCache
};