const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = 3001; // Port for the service
const audiobooksDir = 'D:\\Audiobooks'; // Path to the audiobooks directory on the host PC
const tempDir = path.join(__dirname, 'temp'); // Temporary directory for processing
const os = require('os'); // Import the os module

const dvrDeviceName = process.env.DVR_DEVICE_NAME;

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
app.get('/audiobooks', (req, res) => {
    try {
      const files = fs.readdirSync(audiobooksDir);
      const audiobooks = files.map(file => ({
        title: path.basename(file, path.extname(file)),
        file: `\\\\${dvrDeviceName}\\Audiobooks\\${file}`, // Include the computer name in the network path
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
    const normalizedPath = normalizePath(filePath);
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

// Endpoint to convert a file
app.post('/convert', (req, res) => {
    const { filePath, startTime, duration } = req.body;
  
    // Normalize the path based on the platform
    const normalizedPath = normalizePath(filePath);
    const fullPath = path.join(audiobooksDir, normalizedPath);
    const outputFilePath = path.join(tempDir, `${uuidv4()}.mp3`);
  
    const ffmpeg = spawn('ffmpeg', [
      '-i', fullPath,
      '-ss', startTime,
      '-t', duration,
      '-acodec', 'libmp3lame',
      '-b:a', '192k',
      outputFilePath,
    ]);
  
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        const networkPath = `\\\\${dvrDeviceName}\\Audiobooks\\${path.basename(outputFilePath)}`;
        res.json({ outputFilePath: networkPath }); // Include the computer name in the network path
      } else {
        console.error('Error converting file');
        res.status(500).json({ error: 'Failed to convert file' });
      }
    });
  });

// Start the service
app.listen(port, () => {
  console.log(`SMB service running on port ${port}`);
});