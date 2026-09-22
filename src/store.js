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
      unitRosterChannelId: null,
      unitRosterMessageId: null,
      echoUnitAssignments: {},
      trackedRoleId: null,
      inactivityDays: 7,
      enforcementStartedAt: null,
      processedSupervisorCommandIds: [],
      leaveRequests: [],
      members: {},
    };
  }
  if (!Array.isArray(data.guilds[guildId].leaveRequests)) data.guilds[guildId].leaveRequests = [];
  if (!Array.isArray(data.guilds[guildId].processedSupervisorCommandIds)) data.guilds[guildId].processedSupervisorCommandIds = [];
  if (!data.guilds[guildId].echoUnitAssignments || typeof data.guilds[guildId].echoUnitAssignments !== 'object' || Array.isArray(data.guilds[guildId].echoUnitAssignments)) data.guilds[guildId].echoUnitAssignments = {};
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

function processedSupervisorCommandIds(guildId) {
  const guildData = guild(guildId);
  if (!Array.isArray(guildData.processedSupervisorCommandIds)) guildData.processedSupervisorCommandIds = [];
  return guildData.processedSupervisorCommandIds;
}

// A command that was executed but not acknowledged is served again by the
// portal, so executed IDs are remembered to keep shifts single-counted.
function hasProcessedSupervisorCommand(guildId, commandId) {
  return processedSupervisorCommandIds(guildId).includes(commandId);
}

function markSupervisorCommandProcessed(guildId, commandId) {
  const ids = processedSupervisorCommandIds(guildId);
  if (!ids.includes(commandId)) ids.push(commandId);
  if (ids.length > 200) ids.splice(0, ids.length - 200);
}

module.exports = {
  data: () => data,
  guild,
  member,
  save,
  hasProcessedSupervisorCommand,
  markSupervisorCommandProcessed,
};