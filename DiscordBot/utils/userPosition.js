const userPositions = new Map();

function getUserPosition(userId) {
  return userPositions.get(userId);
}

function storeUserPosition(userId, chapter, part, timestamp) {
  userPositions.set(userId, { chapter, part, timestamp });
}

module.exports = {
  getUserPosition,
  storeUserPosition,
};