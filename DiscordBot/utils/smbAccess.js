const path = require('path');
const fs = require('fs');
const os = require('os');
const fuzzball = require('fuzzball');
const { exec, spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid'); // Import uuid
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const axios = require('axios');
const wol = require('wake_on_lan');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Explicitly load .env from the DiscordBot directory

const dvrMacAddress = process.env.DVR_MAC_ADDRESS; // MAC address for Wake-on-LAN
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

/**
 * List all audiobooks available on the smbService
 * @returns {Promise<Array>} List of audiobooks from the smbService
 */
async function listAudiobooks() {
  try {
    const response = await axios.get(`${hostServiceUrl}/audiobooks`);
    return response.data;
  } catch (error) {
    // try wol
    wol.wake(dvrMacAddress, function (error) {
      if (error) {
        console.log('Wake-on-LAN error', error);
      } else {
        console.log('Wake-on-LAN packet sent');
      }
    });
    console.error('Error listing audiobooks');
    throw error;
  }
}

/**
 * Retrieve the file paths for a specific audiobook chapter and part.
 * @param {*} fileName 
 * @param {*} chapter 
 * @param {*} part 
 * @param {*} startTime 
 * @param {*} speed 
 * @returns {Promise<Object>} 
 */
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

/**
 * Retrieve audiobook file paths based on user input and playback parameters.
 * @param {*} userInput 
 * @param {*} chapter 
 * @param {*} part 
 * @param {*} timestamp 
 * @param {*} speed 
 * @returns {Promise<Object>} 
*/
async function selectAudiobookAndRetrievePaths(userInput, chapter, part = 0, timestamp = 0, speed = 1) {
  try {
    // Find the closest matching audiobook file
    const fileName = path.basename(path.normalize(await findClosestTitleFile(userInput)));
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

function normalizeTitleKey(value) {
  return String(value ?? '')
    .replace(' (Unabridged)', '')
    .split(':')[0]
    .trim()
    .toLowerCase();
}

function getMappedFileName(title) {
  const normalizedTitle = normalizeTitleKey(title);
  if (!normalizedTitle) return null;

  for (const [mappedTitle, mappedFile] of Object.entries(titleToFileMap ?? {})) {
    if (normalizeTitleKey(mappedTitle) === normalizedTitle && typeof mappedFile === 'string' && mappedFile.trim()) {
      return path.basename(path.normalize(mappedFile));
    }
  }

  return null;
}

/** Returns the title file for the audiobook .m4b 
 *  Given the title key: userInput*/
async function findClosestTitleFile(userInput) {
  try {
    // Fetch the list of audiobooks
    const audiobooks = cachedAudiobooks ?? await listAudiobooks();
    if (!cachedAudiobooks) cachedAudiobooks = audiobooks; // Cache the audiobooks if not already cached

    const titles = audiobooks.map((book) => book.title); // Extract titles from the list

    const normalizedInput = String(userInput ?? '').trim();
    if (!normalizedInput) {
      throw new Error('No audiobook title provided to findClosestTitleFile');
    }

    // 1. Check for exact matches first
    const normalizedInputKey = normalizeTitleKey(normalizedInput);
    const exactMatch = titles.find((title) => normalizeTitleKey(title) === normalizedInputKey);
    if (exactMatch) {
      const fileName = getMappedFileName(exactMatch);
      if (fileName) return fileName;
    }

    // 2. Check for a prefix match
    const prefixPattern = new RegExp(`^${normalizedInput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const prefixMatch = titles.find((title) => prefixPattern.test(title.trim()));
    if (prefixMatch) {
      const fileName = getMappedFileName(prefixMatch);
      if (fileName) return fileName;
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
      const fileName = getMappedFileName(bestMatch[0]);
      if (fileName) return fileName;

      const fallbackBook = audiobooks.find((book) => normalizeTitleKey(book.title) === normalizeTitleKey(bestMatch[0]));
      if (fallbackBook && typeof fallbackBook.file === 'string' && fallbackBook.file.trim()) {
        return path.basename(path.normalize(fallbackBook.file));
      }
    }

    throw new Error(`No matching audiobook file found for input: ${userInput}`);
  } catch (error) {
    console.error('Error finding closest match', error);
    throw error;
  }
}

/**
 * Get the title of an audiobook from its file name.
 * @param {*} fileName 
 * @returns {Promise<string|null>} The title of the audiobook or null if not found.
 */
async function getAudiobookTitleFromFile(fileName) {
  try {
    // Fetch the list of audiobooks
    const audiobooks = cachedAudiobooks ?? await listAudiobooks();
    if (!cachedAudiobooks) cachedAudiobooks = audiobooks; // Cache the audiobooks if not already cached

    // Find the audiobook with the matching file name
    const audiobook = audiobooks.find((book) => path.basename(path.normalize(book.file)) === fileName);
    return audiobook ? audiobook.title.replace(' (Unabridged)', '').split(':')[0] : null;
  } catch (error) {
    console.error('Error retrieving audiobook title from file name:', error);
    throw error;
  }
}

/**
 * Update the audiobook cache with the latest data.
 */
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
      map[book.title.replace(' (Unabridged)', '').split(':')[0]] = path.basename(path.normalize(book.file));
      return map;
    }, {});
    console.log('Audiobook cache updated successfully');
  } catch (error) {
    console.error('Error updating audiobook cache:', error);
  }
}

/**
 * Get autocomplete choices for audiobook titles.
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{name: string, value: string}>>}
 */
async function getAudiobookAutocompleteChoices(query = '', limit = 25) {
  const maxChoices = Math.max(1, Math.min(limit, 25));
  const normalizedQuery = String(query || '').trim().toLowerCase();

  let audiobookTitles = [];

  if (Array.isArray(cachedAudiobooks) && cachedAudiobooks.length > 0) {
    audiobookTitles = cachedAudiobooks
      .map((book) => book?.title)
      .filter(Boolean);
  } else if (Object.keys(titleToFileMap).length > 0) {
    audiobookTitles = Object.keys(titleToFileMap);
  } else {
    try {
      await updateAudiobookCache();
      audiobookTitles = (cachedAudiobooks || []).map((book) => book?.title).filter(Boolean);
    } catch (error) {
      console.error('Error preparing audiobook autocomplete cache:', error);
      audiobookTitles = [];
    }
  }

  const uniqueTitles = [...new Set(audiobookTitles)];
  const filteredTitles = normalizedQuery
    ? uniqueTitles.filter((title) => title.toLowerCase().includes(normalizedQuery))
    : uniqueTitles;

  filteredTitles.sort((a, b) => {
    const aStarts = a.toLowerCase().startsWith(normalizedQuery);
    const bStarts = b.toLowerCase().startsWith(normalizedQuery);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.localeCompare(b);
  });

  return filteredTitles.slice(0, maxChoices).map((title) => {
    const normalizedValue = title.replace(' (Unabridged)', '').split(':')[0].trim();
    return {
      name: title.slice(0, 100),
      value: normalizedValue.slice(0, 100),
    };
  });
}

/**
 * Get the list of audiobooks currently in progress for a user.
 * @param {*} userId 
 * @returns {Promise<Array>} List of audiobooks in progress for the user.
 */
async function getUserBooksInProgress(userId) {
  // Only reload if file has changed (optimized)
  loadUserPositionsCacheIfNeeded();
  
  if (!userPositionsCache[userId]) {
    return [];
  }
  const books = Object.keys(userPositionsCache[userId]).map(title => ({
    title: title, // Keep the original title case for proper key matching
    ...userPositionsCache[userId][title]
  }));
  console.log(`[SMBACCESS DEBUG] getUserBooksInProgress for ${userId}: Found ${books.length} books:`, books.map(b => b.title));
  return books;
}

/**
 * Retrieve the file paths for a specific audiobook chapter and part.
 * @param {*} filePath 
 * @param {*} startTime 
 * @param {*} speed 
 * @param {*} action 
 * @returns {Promise<Object>}
*/
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

let isSaving = false;
let lastUserPositionFileModTime = 0; // Track file modification time
let lastUserPositionLoadTime = 0; // Track when we last loaded
const USER_POSITION_RELOAD_COOLDOWN = 1000; // Don't reload more than once per second

/**
 * Load user positions cache from file, but only if the file has actually changed.
 */
function loadUserPositionsCacheIfNeeded() {
  try {
    if (fs.existsSync(userPositionFilePath)) {
      const stat = fs.statSync(userPositionFilePath);
      const fileModTime = stat.mtimeMs;
      const timeSinceLastLoad = Date.now() - lastUserPositionLoadTime;
      
      // Only reload if file is newer than last load AND cooldown has passed
      if (fileModTime > lastUserPositionFileModTime && timeSinceLastLoad > USER_POSITION_RELOAD_COOLDOWN) {
        const fileData = fs.readFileSync(userPositionFilePath, 'utf-8');
        if (fileData.trim()) {
          const existingData = JSON.parse(fileData);
          userPositionsCache = existingData; // Replace entire cache atomically
          lastUserPositionFileModTime = fileModTime;
          lastUserPositionLoadTime = Date.now();
        }
      }
    } 
  } catch (error) {
    console.error('loadUserPositionsCacheIfNeeded: Error checking/loading user positions:', error);
  }
}

/**
 * Load user positions cache from file.
 */
function loadUserPositionsCache() {
  try {
    if (fs.existsSync(userPositionFilePath)) {
      const fileData = fs.readFileSync(userPositionFilePath, 'utf-8');
      if (fileData.trim()) {
        const existingData = JSON.parse(fileData);
        userPositionsCache = existingData; // Replace entire cache atomically
        const stat = fs.statSync(userPositionFilePath);
        lastUserPositionFileModTime = stat.mtimeMs;
        lastUserPositionLoadTime = Date.now();
      } 
    } 
  } catch (error) {
    console.error('loadUserPositionsCache: Error loading user positions from file:', error);
  }
}

/**
 * Load user positions (backward compatibility alias).
 */
function loadUserPositions() {
  loadUserPositionsCache();
}

/**
 * Save user positions to file.
 */
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
  // Check cache first (optimized - only reload if file changed)
  if (!userPositionsCache[userId]) {
    loadUserPositionsCacheIfNeeded();
  }
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

/**
 * Get the chapter count for a specific audiobook.
 * @param {*} title 
 * @returns {Promise<number>} The number of chapters in the audiobook. 
 */
async function getChapterCount(title) {
  let fileName = await findClosestTitleFile(title);
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

/**
 * Remove a user's position for a specific audiobook.
 * @param {*} userId 
 * @param {*} bookTitle 
 * @returns {Promise<void>}
 */
async function removeUserPosition(userId, bookTitle) {
  try {
    // Ensure cache is loaded but don't wipe existing data
    if (Object.keys(userPositionsCache).length === 0) {
      loadUserPositionsCache();
    }
    console.log(`[removeUserPosition] Attempting to remove book "${bookTitle}" for user ${userId}`);

    if (!userPositionsCache[userId]) {
      console.log(`[removeUserPosition] User ${userId} has no positions stored`);
      return;
    }

    // Log all stored keys for this user
    const storedKeys = Object.keys(userPositionsCache[userId]);
    console.log(`[removeUserPosition] Stored keys for user:`, storedKeys);

    // Try exact match first
    if (userPositionsCache[userId][bookTitle]) {
      console.log(`[removeUserPosition] Found exact match, deleting "${bookTitle}"`);
      delete userPositionsCache[userId][bookTitle];
    } else {
      // Try to find a matching key (case-insensitive, normalized comparison)
      const normalizedSearchTitle = bookTitle.toLowerCase().trim();
      const matchingKey = storedKeys.find(key => {
        const normalizedKey = key.toLowerCase().trim();
        return normalizedKey === normalizedSearchTitle || 
               normalizedKey.includes(normalizedSearchTitle) ||
               normalizedSearchTitle.includes(normalizedKey);
      });

      if (matchingKey) {
        console.log(`[removeUserPosition] Found matching key "${matchingKey}" for search "${bookTitle}", deleting...`);
        delete userPositionsCache[userId][matchingKey];
      } else {
        console.warn(`[removeUserPosition] Could not find matching key for "${bookTitle}"`);
        console.warn(`[removeUserPosition] Available keys:`, storedKeys);
        return; // Exit early if no match found
      }
    }

    // If user has no more books, remove the user entry entirely
    if (Object.keys(userPositionsCache[userId] || {}).length === 0) {
      console.log(`[removeUserPosition] User has no more books, removing user entry`);
      delete userPositionsCache[userId];
    }

    // Save to file
    console.log(`[removeUserPosition] Saving updated positions to file...`);
    saveUserPositionsToFile();
    console.log(`[removeUserPosition] Book removed successfully`);
  } catch (error) {
    console.error('[removeUserPosition] Error removing user position:', error);
  }
}

// Load cache on startup
loadCache();
loadUserPositionsCache(); // Also load user positions on startup
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
  findClosestTitleFile,
  getFileNameFromTitle,
  loadUserPositions, 
  scheduleUserPositionSaving,
  getUserBooksInProgress,
  saveCache,
  getAudiobookTitleFromFile,
  getAudiobookAutocompleteChoices,
  removeUserPosition,
  userPositionsCache,
  saveUserPositionsToFile,
};