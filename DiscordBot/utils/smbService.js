const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const app = express();
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Explicitly load .env from the DiscordBot directory

const port = process.env.DVR_PORT; // Port for the service
const coverArtPort = process.env.COVER_ART_PORT; // Port for the image server
const dvrDeviceName = process.env.DVR_DEVICE_NAME;
const localDrive = process.env.LOCAL_DRIVE_LETTER; // Local drive letter (e.g., 'C:') 
const downloadPort = process.env.DOWNLOAD_PORT; // Port for the download server
const audiobooksDir = `${localDrive}\\Audiobooks`; // Path to the audiobooks directory on the host PC
const tempDir = path.join(audiobooksDir, 'temp'); // Temporary directory for processing
const os = require('os'); // Import the os module
const imageDirectory = path.join(audiobooksDir, 'temp');

const downloadHost = express();
const imageHost = express(); 

// Log ALL requests to downloadHost
downloadHost.use((req, res, next) => {
  console.log(`[DOWNLOAD] ${req.method} ${req.url} from ${req.ip}`);
  console.log(`[DOWNLOAD] Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
  console.log(`[DOWNLOAD] Headers:`, JSON.stringify(req.headers, null, 2));
  
  // Check if file exists
  if (req.url.startsWith('/downloads/')) {
    const fileName = decodeURIComponent(req.url.replace('/downloads/', ''));
    const fullPath = path.join(audiobooksDir, fileName);
    console.log(`[DOWNLOAD] Looking for file: ${fullPath}`);
    console.log(`[DOWNLOAD] File exists: ${fs.existsSync(fullPath)}`);
  }
  
  // Track response errors
  res.on('error', (err) => {
    console.error('[DOWNLOAD] Response error:', err);
  });
  
  res.on('close', () => {
    console.log(`[DOWNLOAD] Response closed for ${req.url}`);
  });
  
  res.on('finish', () => {
    console.log(`[DOWNLOAD] Response finished for ${req.url}`);
  });
  
  next();
});

imageHost.use('/images', express.static(imageDirectory, {
  fallthrough: false, // Ensure that requests are not passed to the next middleware if the file is not found
  setHeaders: (res, path) => {
    res.set('Content-Type', 'image/jpeg'); // Set the content type to image/jpeg
  }
}));

imageHost.listen(coverArtPort, '0.0.0.0', () => {
  console.log(`Image server running on port ${coverArtPort}/images/`);
});

imageHost.use((err, req, res, next) => {
  console.error('Error serving image');
  res.status(500).send('Internal Server Error');
});

imageHost.get('*', (req, res) => {
  console.log('Request for:', req.url);
  res.status(404).send('Not Found');
});

downloadHost.use('/downloads', express.static(audiobooksDir, {
  fallthrough: false,
  setHeaders: (res, filePath) => {
    // Force download instead of inline display
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
    res.set('Content-Type', 'audio/m4b');
    res.set('Accept-Ranges', 'bytes'); // Enable range requests for resume/progress
    console.log(`[DOWNLOAD] Serving file: ${filePath}`);
  }
}));

// Error handler must be BEFORE listen
downloadHost.use((err, req, res, next) => {
  console.error('[DOWNLOAD] Error serving download:', err);
  console.error('[DOWNLOAD] Error stack:', err.stack);
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

// Catch-all 404 handler
downloadHost.use((req, res) => {
  console.log('404 - Not found:', req.url);
  res.status(404).send('File Not Found');
});

downloadHost.listen(downloadPort, '0.0.0.0', () => {
  console.log(`Download server running on port ${downloadPort}/downloads/`);
});

// Ensure the temp directory exists
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
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

// Middleware to parse JSON requests
app.use(express.json());

// Endpoint to list audiobooks
app.get('/audiobooks', async (req, res) => {
  try {
      const files = fs.readdirSync(audiobooksDir).filter(file => path.extname(file).toLowerCase() === '.m4b');
      const audiobooks = await Promise.all(files.map(async (file) => {
          const fullPath = path.join(audiobooksDir, file);
          return new Promise((resolve) => {
              execFile('ffprobe', [
                  '-v', 'error',
                  '-show_entries', 'format=duration:format_tags=artist,title,genre',
                  '-of', 'json',
                  fullPath
              ], (err, stdout) => {
                  if (err) {
                      console.error(`Error retrieving metadata for file ${file}:`);
                      resolve({
                          title: path.basename(file, path.extname(file)),
                          author: 'Unknown Author',
                          genre: 'Unknown Genre',
                          playtime: 'Unknown Duration',
                          file: `${path.basename(file)}`
                      });
                      return;
                  }

                  const metadata = JSON.parse(stdout);
                  const tags = metadata.format.tags || {};
                  const duration = metadata.format.duration || 'Unknown Duration';

                  resolve({
                      title: tags.title || path.basename(file, path.extname(file)),
                      author: tags.artist || 'Unknown Author',
                      genre: tags.genre || 'Unknown Genre',
                      playtime: duration,
                      file: `${path.basename(file)}`
                  });
              });
          });
      }));
      res.json(audiobooks);
  } catch (error) {
      console.error('Error listing audiobooks:', error);
      res.status(500).json({ error: 'Failed to list audiobooks' });
  }
});

// Endpoint to retrieve metadata
app.post('/metadata', (req, res) => {
  const { filePath } = req.body;

  // Normalize the path based on the platform
  const normalizedPath = normalizePath(path.basename(path.normalize(filePath)));
  const fullPath = path.join(audiobooksDir, normalizedPath);

  execFile('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=artist,title', '-of', 'json', fullPath], (err, stdout) => {
    if (err) {
      console.error('Error retrieving metadata:', err);
      return res.status(500).json({ error: 'Failed to retrieve metadata' });
    }

    const metadata = JSON.parse(stdout);
    const tags = metadata.format.tags || {};
    res.json({
      author: tags.artist || 'Unknown Author',
      title: tags.title || 'Unknown Title',
    });
  });
});

// Endpoint to generate a cover image
app.post('/cover', (req, res) => {
  const { filePath } = req.body;

  // Normalize the path based on the platform
  const normalizedPath = normalizePath(filePath);
  const fullPath = path.join(audiobooksDir, normalizedPath);
  const coverImagePath = path.join(tempDir, `${uuidv4()}.jpg`);

  const ffmpeg = spawn('ffmpeg', ['-i', fullPath, '-an', '-vcodec', 'copy', coverImagePath]);

  ffmpeg.on('close', (code) => {
    if (code === 0) {
      res.json({ coverImagePath });
    } else {
      console.error('Error generating cover image');
      res.status(500).json({ error: 'Failed to generate cover image' });
    }
  });
});

app.post('/process', async (req, res) => {
  const { filePath, startTime, speed, action } = req.body;

  try {
    const normalizedPath = normalizePath(filePath);
    const fullPath = path.join(`${audiobooksDir}`, normalizedPath);

    const tempFileName = `${uuidv4()}.mp3`;
    const tempFilePath = path.join(tempDir, tempFileName);

    const ffmpegArgs = ['-loglevel', 'error', '-i', fullPath];

    // Add specific ffmpeg arguments based on the action
    if ((action === 'seek' || action === 'skip' || action === 'speed') && startTime > 0) {
      ffmpegArgs.push('-ss', startTime / 1000);
    }
    if (action === 'speed' && speed !== 1) {
      ffmpegArgs.push('-filter:a', `atempo=${speed}`);
    } 
    ffmpegArgs.push('-vn', '-b:a', '192k', '-c:a', 'libmp3lame', tempFilePath);
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        res.json({ tempFilePath: path.basename(tempFilePath), originalFilePath: path.basename(fullPath) }); // Include originalFilePath in the response
      } else {
        console.error('Error processing file with ffmpeg');
        res.status(500).json({ error: 'Failed to process file' });
      }
    });
  } catch (error) {
    console.error('Error processing file:', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

// Add endpoint to delete temp files
app.delete('/temp', (req, res) => {
  const { tempFilePath } = req.body;

  try {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    console.error('Error deleting temp file:', error);
    res.status(500).json({ error: 'Failed to delete temp file' });
  }
});

// Start the service
app.listen(port, () => {
  console.log(`SMB service running on port ${port}`);
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  console.error('Stack:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});