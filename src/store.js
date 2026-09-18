const fs = require('node:fs');
const path = require('node:path');

const dataDirectory = path.join(__dirname, '..', 'data');
const dataPath = path.join(dataDirectory, 'clock-data.json');

function emptyData() {
  return { version: 1, guilds: {} };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : emptyData();
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load clock data:', error);
    return emptyData();
  }
}

let data = load();

function save() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const temporaryPath = `${dataPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryPath, dataPath);
}

function guild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      clockChannelId: null,
      panelMessageId: null,
      rosterChannelId: null,
      rosterMessageId: null,
      trackedRoleId: null,
      inactivityDays: 7,
      enforcementStartedAt: null,
      members: {},
    };
  }
  return data.guilds[guildId];
}

function member(guildId, memberId) {
  const guildData = guild(guildId);
  if (!guildData.members[memberId]) {
    guildData.members[memberId] = {
      activeShift: null,
      shifts: [],
      lastClockIn: null,
      strikes: 0,
      lastInactivityStrikeWeek: 0,
      strikeHistory: [],
    };
  }
  return guildData.members[memberId];
}

module.exports = { data: () => data, guild, member, save };
