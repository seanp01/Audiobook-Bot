const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function splitAudiobook(filePath, callback) {
  const outputDir = path.dirname(filePath);
  const outputPattern = path.join(outputDir, '%03d.mp3');
  
  exec(`ffmpeg -i "${filePath}" -f segment -segment_time 600 -c copy "${outputPattern}"`, (err) => {
    if (err) {
      return callback(err);
    }
    callback(null);
  });
}

function storeUserPosition(userId, position) {
  const positions = JSON.parse(fs.readFileSync('userPositions.json', 'utf8') || '{}');
  positions[userId] = position;
  fs.writeFileSync('userPositions.json', JSON.stringify(positions));
}

function getUserPosition(userId) {
  const positions = JSON.parse(fs.readFileSync('userPositions.json', 'utf8') || '{}');
  return positions[userId] || 0;
}

module.exports = {
  splitAudiobook,
  storeUserPosition,
  getUserPosition
};