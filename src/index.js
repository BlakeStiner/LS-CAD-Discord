require('dotenv').config();
const { randomUUID } = require('node:crypto');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  StringSelectMenuBuilder,
} = require('discord.js');
const commands = require('./commands');
const store = require('./store');
const { writePortalSnapshot, publishPortalSnapshot, supervisorCommandsUrl, portalIngestToken } = require('./portal-export');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
});
client.on(Events.Error, error => {
  console.error('Discord client error:', error);
});
const panelMoves = new Map();
const panelMoveTimers = new Map();
const rosterRefreshes = new Map();
const unitRosterRefreshes = new Map();
let shiftReminderCheckRunning = false;
let supervisorCommandCheckRunning = false;
const PANEL_REPOST_DELAY_MS = 6000;
const PANEL_RETIRE_DELAY_MS = 15000;
const ROSTER_OPTIONS = [
  'Lakeside EMS',
  'Lakeside Police Department',
  'Lakeside Sheriff Office',
  'Nevada State Patrol',
];
const ECHO_UNITS = Array.from({ length: 51 }, (_, index) => `E-${400 + index}`);

function timestamp(dateOrMs) {
  return `<t:${Math.floor(new Date(dateOrMs).getTime() / 1000)}:F>`;
}

function relativeTime(dateOrMs) {
  return `<t:${Math.floor(new Date(dateOrMs).getTime() / 1000)}:R>`;
}

function duration(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function ensureShiftMetadata(shift) {
  if (!shift.id) shift.id = randomUUID();
  if (!shift.approvalStatus) shift.approvalStatus = 'recorded';
  if (!Array.isArray(shift.audit)) shift.audit = [];
  return shift;
}

function shiftReference(shift) {
  return ensureShiftMetadata(shift).id.slice(0, 8);
}

function findShift(record, reference) {
  const normalized = reference.trim().toLowerCase();
  const matches = record.shifts.filter(shift => ensureShiftMetadata(shift).id.toLowerCase().startsWith(normalized));
  return matches.length === 1 ? matches[0] : null;
}

function parseIsoDate(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid ISO 8601 date and time.`);
  return parsed.toISOString();
}

function parseLeaveDate(value, label) {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) throw new Error(`${label} is not a valid calendar date.`);
  return normalized;
}

function leaveRange(request) {
  return {
    start: new Date(`${request.startDate}T00:00:00.000Z`).getTime(),
    end: new Date(`${request.endDate}T23:59:59.999Z`).getTime(),
  };
}

function leaveRequestReference(request) {
  return request.id.slice(0, 8);
}

function findLeaveRequest(requests, memberId, reference) {
  const normalized = reference.trim().toLowerCase();
  const matches = requests.filter(request => request.memberId === memberId && request.id.toLowerCase().startsWith(normalized));
  return matches.length === 1 ? matches[0] : null;
}

function leavesOverlap(first, second) {
  const firstRange = leaveRange(first);
  const secondRange = leaveRange(second);
  return firstRange.start <= secondRange.end && secondRange.start <= firstRange.end;
}

function approvedLeaveMilliseconds(requests, memberId, baseline, now) {
  return requests
    .filter(request => request.memberId === memberId && request.status === 'approved')
    .reduce((total, request) => {
      const range = leaveRange(request);
      return total + Math.max(0, Math.min(now, range.end) - Math.max(baseline, range.start));
    }, 0);
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Lakeside Medical • Shift Clock')
    .setDescription([
      'Manage your shift using the controls below.',
      '',
      '🟢 **Clock In** — Start your shift.',
      '🔴 **Clock Out** — End your shift.',
      '🕐 **My Status** — Check your current status.',
    ].join('\n'))
    .setFooter({ text: 'Use this panel whenever you start or finish duty.' })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clock:in').setLabel('Clock In').setEmoji('🟢').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('clock:out').setLabel('Clock Out').setEmoji('🔴').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('clock:status').setLabel('My Status').setEmoji('🕐').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function isClockPanel(message) {
  return message.author?.id === client.user?.id
    && message.components?.some(row => row.components.some(component => component.customId === 'clock:in'));
}

function retiredPanelPayload() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('Lakeside Medical • Shift Clock')
      .setDescription('This clock panel has moved to the newest message below.')
      .setFooter({ text: 'Use the current Shift Clock panel to start or finish duty.' })],
    components: [],
  };
}

async function retirePanel(panel) {
  await panel.edit(retiredPanelPayload()).catch(error => console.error(`Could not disable stale clock panel ${panel.id}:`, error));
  const timer = setTimeout(() => {
    panel.delete().catch(error => console.error(`Could not remove stale clock panel ${panel.id}:`, error));
  }, PANEL_RETIRE_DELAY_MS);
  timer.unref?.();
}

// The replacement is persisted before prior controls are disabled, so the newest
// panel is always available before an older panel is retired.
async function publishFreshPanel(guild, channel) {
  const guildData = store.guild(guild.id);
  const panel = await channel.send(panelPayload());
  guildData.clockChannelId = channel.id;
  guildData.panelMessageId = panel.id;
  store.save();

  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recentMessages) {
    const stalePanels = recentMessages.filter(message => message.id !== panel.id && isClockPanel(message));
    for (const stalePanel of stalePanels.values()) await retirePanel(stalePanel);
  }
  return panel;
}

// A restart should preserve the existing current panel. Only publish when the
// configured panel is missing, rather than invalidating a visible control.
async function ensurePanel(guild, channel) {
  const guildData = store.guild(guild.id);
  const configuredPanel = guildData.panelMessageId
    ? await channel.messages.fetch(guildData.panelMessageId).catch(() => null)
    : null;
  if (configuredPanel && isClockPanel(configuredPanel)) return configuredPanel;

  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const newestPanel = recentMessages
    ? [...recentMessages.values()].filter(isClockPanel).sort((first, second) => second.createdTimestamp - first.createdTimestamp)[0]
    : null;
  if (newestPanel) {
    guildData.panelMessageId = newestPanel.id;
    guildData.clockChannelId = channel.id;
    store.save();
    return newestPanel;
  }
  return publishFreshPanel(guild, channel);
}

// Discord cannot pin a message to the bottom of a feed. Wait for a short quiet
// period before reposting, rather than deleting the panel for every message.
function schedulePanelMove(guild) {
  if (!store.guild(guild.id).clockChannelId) return;
  const existingTimer = panelMoveTimers.get(guild.id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    panelMoveTimers.delete(guild.id);
    movePanelToBottom(guild).catch(error => console.error(`Could not move clock panel for ${guild.id}:`, error));
  }, PANEL_REPOST_DELAY_MS);
  timer.unref?.();
  panelMoveTimers.set(guild.id, timer);
}

async function movePanelToBottom(guild) {
  if (panelMoves.has(guild.id)) return panelMoves.get(guild.id);
  const work = (async () => {
    const guildData = store.guild(guild.id);
    if (!guildData.clockChannelId) return;
    const channel = await guild.channels.fetch(guildData.clockChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    await publishFreshPanel(guild, channel);
  })();
  panelMoves.set(guild.id, work);
  try {
    return await work;
  } finally {
    panelMoves.delete(guild.id);
  }
}
async function sendClockLog(guild, embed) {
  const guildData = store.guild(guild.id);
  if (!guildData.clockChannelId) return;
  const channel = await guild.channels.fetch(guildData.clockChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch(console.error);
    await movePanelToBottom(guild);
  }
}

function rosterFields(title, entries) {
  if (!entries.length) return [{ name: title, value: 'None', inline: false }];
  const fields = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current}\n${entry}` : entry;
    if (next.length > 1024) {
      fields.push({ name: fields.length ? `${title} (continued)` : title, value: current, inline: false });
      current = entry;
    } else {
      current = next;
    }
  }
  if (current) fields.push({ name: fields.length ? `${title} (continued)` : title, value: current, inline: false });
  return fields;
}

async function buildDutyRoster(guild) {
  const guildData = store.guild(guild.id);
  let members;
  if (guildData.trackedRoleId) {
    // Guild member cache is populated by the GuildMembers intent and by every
    // clock interaction. Reusing it avoids Discord's gateway member-fetch rate
    // limit when a roster refresh follows a clock-in.
    members = guild.members.cache.filter(member => !member.user.bot && member.roles.cache.has(guildData.trackedRoleId));
  } else {
    const knownMembers = await Promise.all(Object.keys(guildData.members).map(id => guild.members.fetch(id).catch(() => null)));
    members = knownMembers.filter(member => member && !member.user.bot);
  }

  const onDuty = [];
  const offDuty = [];
  for (const member of members.values()) {
    const record = guildData.members[member.id];
    if (record?.activeShift) {
      onDuty.push(`• ${member} — **${record.activeShift.department}** since ${relativeTime(record.activeShift.start)}`);
    } else {
      offDuty.push(`• ${member}`);
    }
  }

  const scope = guildData.trackedRoleId ? `<@&${guildData.trackedRoleId}>` : 'members with recorded clock activity';
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Lakeside Medical • Live Duty Roster')
    .setDescription(`Roster scope: ${scope}`)
    .addFields([...rosterFields(`On duty — ${onDuty.length}`, onDuty), ...rosterFields(`Off duty — ${offDuty.length}`, offDuty)].slice(0, 25))
    .setFooter({ text: 'Updates automatically when shifts begin or end.' })
    .setTimestamp();
}

async function refreshDutyRoster(guild) {
  if (rosterRefreshes.has(guild.id)) return rosterRefreshes.get(guild.id);
  const work = (async () => {
    const guildData = store.guild(guild.id);
    if (!guildData.rosterChannelId) return;
    const channel = await guild.channels.fetch(guildData.rosterChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const payload = { embeds: [await buildDutyRoster(guild)] };
    const existing = guildData.rosterMessageId
      ? await channel.messages.fetch(guildData.rosterMessageId).catch(() => null)
      : null;
    if (existing) {
      await existing.edit(payload);
    } else {
      const rosterMessage = await channel.send(payload);
      guildData.rosterMessageId = rosterMessage.id;
      store.save();
    }
  })();
  rosterRefreshes.set(guild.id, work);
  try {
    return await work;
  } finally {
    rosterRefreshes.delete(guild.id);
  }
}

async function refreshAllDutyRosters() {
  for (const guildId of Object.keys(store.data().guilds)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (guild) await refreshDutyRoster(guild).catch(error => console.error(`Could not refresh duty roster for ${guildId}:`, error));
  }
}

async function refreshAllPortalSnapshots() {
  for (const guildId of Object.keys(store.data().guilds)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (guild) {
      const snapshot = writePortalSnapshot(guild);
      await publishPortalSnapshot(snapshot);
    }
  }
}

function normalizeEchoUnit(value) {
  const match = /^E-(\d{3})$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 400 && number <= 450 ? `E-${number}` : null;
}

function echoUnitAssignments(guildData) {
  if (!guildData.echoUnitAssignments || typeof guildData.echoUnitAssignments !== 'object' || Array.isArray(guildData.echoUnitAssignments)) guildData.echoUnitAssignments = {};
  return guildData.echoUnitAssignments;
}

function buildUnitRoster(guild) {
  const assignments = echoUnitAssignments(store.guild(guild.id));
  const fields = [];
  for (let index = 0; index < ECHO_UNITS.length; index += 17) {
    const units = ECHO_UNITS.slice(index, index + 17);
    fields.push({
      name: `${units[0]} – ${units.at(-1)}`,
      value: units.map(unit => `**${unit}** — ${assignments[unit] ? `<@${assignments[unit]}>` : 'Unassigned'}`).join('\n'),
      inline: true,
    });
  }
  const assignedCount = Object.keys(assignments).filter(unit => ECHO_UNITS.includes(unit)).length;
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Lakeside Medical • Echo Unit Roster')
    .setDescription(`Echo units **E-400 through E-450** • **${assignedCount}/51** assigned`)
    .addFields(fields)
    .setFooter({ text: 'Member mentions reflect current Discord nicknames automatically.' })
    .setTimestamp();
}

async function refreshUnitRoster(guild) {
  if (unitRosterRefreshes.has(guild.id)) return unitRosterRefreshes.get(guild.id);
  const work = (async () => {
    const guildData = store.guild(guild.id);
    if (!guildData.unitRosterChannelId) return;
    const channel = await guild.channels.fetch(guildData.unitRosterChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const payload = { embeds: [buildUnitRoster(guild)] };
    const existing = guildData.unitRosterMessageId ? await channel.messages.fetch(guildData.unitRosterMessageId).catch(() => null) : null;
    if (existing) await existing.edit(payload);
    else {
      const message = await channel.send(payload);
      guildData.unitRosterMessageId = message.id;
      store.save();
    }
  })();
  unitRosterRefreshes.set(guild.id, work);
  try { return await work; } finally { unitRosterRefreshes.delete(guild.id); }
}

async function refreshAllUnitRosters() {
  for (const guildId of Object.keys(store.data().guilds)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (guild) await refreshUnitRoster(guild).catch(error => console.error(`Could not refresh unit roster for ${guildId}:`, error));
  }
}
function statusEmbed(user, record) {
  const completed = record.shifts.filter(shift => shift.end && ensureShiftMetadata(shift).approvalStatus !== 'rejected');
  const totalMs = completed.reduce((total, shift) => total + (new Date(shift.end) - new Date(shift.start)), 0);
  const fields = [
    { name: 'Strikes', value: String(record.strikes), inline: true },
    { name: 'Completed shifts', value: String(completed.length), inline: true },
    { name: 'Total recorded time', value: duration(totalMs), inline: true },
    { name: 'Last clock-in', value: record.lastClockIn ? `${timestamp(record.lastClockIn)} (${relativeTime(record.lastClockIn)})` : 'No recorded clock-ins', inline: false },
  ];
  if (record.activeShift) {
    fields.push({ name: 'Active shift', value: `**${record.activeShift.department}** since ${timestamp(record.activeShift.start)}\nElapsed: ${duration(Date.now() - new Date(record.activeShift.start))}`, inline: false });
  }
  return new EmbedBuilder().setColor(record.activeShift ? 0x2ecc71 : 0x5865f2).setTitle(`${user.username}'s clock status`).addFields(fields).setTimestamp();
}

async function checkInactivity() {
  const now = Date.now();
  for (const [guildId, guildData] of Object.entries(store.data().guilds)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;
    let eligibleIds = Object.keys(guildData.members);
    if (guildData.trackedRoleId) {
      const members = await guild.members.fetch().catch(() => null);
      if (!members) continue;
      eligibleIds = members.filter(member => !member.user.bot && member.roles.cache.has(guildData.trackedRoleId)).map(member => member.id);
    }
    for (const memberId of eligibleIds) {
      const record = store.member(guildId, memberId);
      if (record.activeShift) continue;
      const discordMember = await guild.members.fetch(memberId).catch(() => null);
      const baseline = Math.max(
        record.lastClockIn ? new Date(record.lastClockIn).getTime() : 0,
        guildData.enforcementStartedAt ? new Date(guildData.enforcementStartedAt).getTime() : 0,
        discordMember?.joinedTimestamp ?? 0,
      );
      if (!baseline) continue;
      const approvedLeaveMs = approvedLeaveMilliseconds(guildData.leaveRequests, memberId, baseline, now);
      const elapsed = Math.max(0, now - baseline - approvedLeaveMs);
      const gracePeriod = guildData.inactivityDays * 24 * 60 * 60 * 1000;
      const expectedStrikes = elapsed < gracePeriod ? 0 : 1 + Math.floor((elapsed - gracePeriod) / (7 * 24 * 60 * 60 * 1000));
      const strikesToAdd = expectedStrikes - record.lastInactivityStrikeWeek;
      if (strikesToAdd <= 0) continue;
      record.strikes += strikesToAdd;
      record.lastInactivityStrikeWeek = expectedStrikes;
      record.strikeHistory.push({ at: new Date().toISOString(), delta: strikesToAdd, reason: `No clock-in since ${new Date(baseline).toISOString()}; approved leave excluded` });
      await sendClockLog(guild, new EmbedBuilder().setColor(0xe74c3c).setTitle('Attendance strike issued').setDescription(`${discordMember ?? `<@${memberId}>`} received **${strikesToAdd}** inactivity strike${strikesToAdd === 1 ? '' : 's'}.`).addFields({ name: 'Last clock-in', value: timestamp(baseline), inline: true }, { name: 'Current strike count', value: String(record.strikes), inline: true }).setTimestamp());
      store.save();
    }
  }
}

async function sendShiftReminder(memberId, embed) {
  const user = await client.users.fetch(memberId).catch(() => null);
  if (!user) return false;
  return user.send({ embeds: [embed] })
    .then(() => true)
    .catch(error => {
      console.warn(`Could not DM shift reminder to ${memberId}:`, error.message);
      return false;
    });
}

async function checkShiftReminders() {
  if (shiftReminderCheckRunning) return;
  shiftReminderCheckRunning = true;
  try {
    const now = Date.now();
    const eightHours = 8 * 60 * 60 * 1000;
    const twelveHours = 12 * 60 * 60 * 1000;
    const twentyFourHours = 24 * 60 * 60 * 1000;

    for (const [guildId, guildData] of Object.entries(store.data().guilds)) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;

      for (const [memberId, record] of Object.entries(guildData.members)) {
        if (!record.activeShift) continue;
        const shift = record.activeShift;
        const elapsed = now - new Date(shift.start).getTime();

        if (elapsed >= twentyFourHours) {
          const end = new Date().toISOString();
          const completedShift = ensureShiftMetadata({ ...shift, end, endReason: 'automatic-24-hour-limit' });
          completedShift.audit.push({ at: end, action: 'automatically-clocked-out', by: client.user.id });
          record.shifts.push(completedShift);
          record.activeShift = null;
          store.save();

          await sendShiftReminder(memberId, new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Shift automatically clocked out')
            .setDescription(`Your **${completedShift.department}** shift reached the 24-hour limit and has been clocked out automatically.`)
            .addFields({ name: 'Started', value: timestamp(completedShift.start), inline: true }, { name: 'Recorded duration', value: duration(new Date(end) - new Date(completedShift.start)), inline: true })
            .setTimestamp());
          await sendClockLog(guild, new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Shift automatically clocked out')
            .setDescription(`<@${memberId}>'s **${completedShift.department}** shift reached the 24-hour limit.`)
            .addFields({ name: 'Started', value: timestamp(completedShift.start), inline: true }, { name: 'Recorded duration', value: duration(new Date(end) - new Date(completedShift.start)), inline: true })
            .setTimestamp());
          await refreshDutyRoster(guild);
          continue;
        }

        if (elapsed >= eightHours && !shift.eightHourReminderSentAt) {
          shift.eightHourReminderSentAt = new Date().toISOString();
          store.save();
          await sendShiftReminder(memberId, new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('8-hour shift reminder')
            .setDescription(`You have been clocked in for **${shift.department}** for 8 hours. Please clock out when your shift is complete.`)
            .addFields({ name: 'Clocked in', value: timestamp(shift.start), inline: true })
            .setTimestamp());
        }

        if (elapsed >= twelveHours && !shift.twelveHourReminderSentAt) {
          shift.twelveHourReminderSentAt = new Date().toISOString();
          store.save();
          await sendShiftReminder(memberId, new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle('12-hour shift reminder')
            .setDescription(`You have been clocked in for **${shift.department}** for 12 hours. Please clock out as soon as your shift is complete.`)
            .addFields({ name: 'Clocked in', value: timestamp(shift.start), inline: true })
            .setTimestamp());
        }
      }
    }
  } finally {
    shiftReminderCheckRunning = false;
  }
}

function portalHeaders() {
  return {
    authorization: `Bearer ${portalIngestToken()}`,
    'content-type': 'application/json',
  };
}

async function supervisorGuild() {
  if (DISCORD_GUILD_ID) return client.guilds.fetch(DISCORD_GUILD_ID).catch(() => null);
  const guilds = [...client.guilds.cache.values()];
  return guilds.length === 1 ? guilds[0] : null;
}

async function publishPortalSnapshotForGuild(guild) {
  try {
    await publishPortalSnapshot(writePortalSnapshot(guild));
  } catch (error) {
    console.error(`Could not republish portal snapshot for ${guild.id}:`, error);
  }
}

async function executeSupervisorCommand(guild, command) {
  const member = await guild.members.fetch(command.memberId).catch(() => null);
  if (!member || member.user.bot) return 'No change: the selected Discord member is no longer available in the server.';
  const record = store.member(guild.id, command.memberId);
  const supervisor = command.requestedByName?.trim() || 'A supervisor';

  if (command.action === 'clock-in') {
    if (!ROSTER_OPTIONS.includes(command.department)) return 'No change: the requested department is not a valid roster.';
    if (record.activeShift) return `No change: ${member.displayName} is already clocked in for ${record.activeShift.department}.`;
    const start = new Date().toISOString();
    record.activeShift = {
      id: randomUUID(),
      start,
      department: command.department,
      source: 'supervisor',
      approvalStatus: 'recorded',
      audit: [{ at: start, action: 'supervisor-clocked-in', by: command.requestedById, byName: supervisor, commandId: command.id }],
    };
    record.lastClockIn = start;
    record.lastInactivityStrikeWeek = 0;
    store.save();
    const dmDelivered = await sendShiftReminder(member.id, new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Supervisor clock-in recorded')
      .setDescription(`${supervisor} clocked you in for **${command.department}** from the operations portal.`)
      .addFields({ name: 'Department', value: command.department, inline: true }, { name: 'Clocked in', value: timestamp(start), inline: true })
      .setTimestamp());
    await sendClockLog(guild, new EmbedBuilder().setColor(0x2ecc71).setTitle('Supervisor started a shift').setDescription(`${member} was clocked in for **${command.department}** by **${supervisor}** via the operations portal.`).addFields({ name: 'Started', value: timestamp(start), inline: true }).setTimestamp());
    await refreshDutyRoster(guild).catch(error => console.error(`Could not refresh duty roster for supervisor command ${command.id}:`, error));
    await publishPortalSnapshotForGuild(guild);
    return `Clocked ${member.displayName} in for ${command.department}, recorded at ${start}.${dmDelivered ? ' Direct-message confirmation delivered.' : ' Direct-message confirmation could not be delivered; the member may block server direct messages.'}`;
  }

  if (command.action === 'clock-out') {
    if (!record.activeShift) return `No change: ${member.displayName} is not currently clocked in.`;
    const end = new Date().toISOString();
    const shift = ensureShiftMetadata({ ...record.activeShift, end, endReason: 'supervisor-manual-clock-out' });
    shift.audit.push({ at: end, action: 'supervisor-clocked-out', by: command.requestedById, byName: supervisor, commandId: command.id });
    record.shifts.push(shift);
    record.activeShift = null;
    store.save();
    const recordedDuration = duration(new Date(end) - new Date(shift.start));
    const dmDelivered = await sendShiftReminder(member.id, new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Supervisor clock-out recorded')
      .setDescription(`${supervisor} clocked you out of **${shift.department}** from the operations portal.`)
      .addFields({ name: 'Department', value: shift.department, inline: true }, { name: 'Clocked out', value: timestamp(end), inline: true }, { name: 'Recorded duration', value: recordedDuration, inline: true })
      .setTimestamp());
    await sendClockLog(guild, new EmbedBuilder().setColor(0xe74c3c).setTitle('Supervisor completed a shift').setDescription(`${member} was clocked out of **${shift.department}** by **${supervisor}** via the operations portal.`).addFields({ name: 'Clocked out', value: timestamp(end), inline: true }, { name: 'Recorded duration', value: recordedDuration, inline: true }).setTimestamp());
    await refreshDutyRoster(guild).catch(error => console.error(`Could not refresh duty roster for supervisor command ${command.id}:`, error));
    await publishPortalSnapshotForGuild(guild);
    return `Clocked ${member.displayName} out of ${shift.department}; recorded duration ${recordedDuration}.${dmDelivered ? ' Direct-message confirmation delivered.' : ' Direct-message confirmation could not be delivered; the member may block server direct messages.'}`;
  }

  if (command.action === 'clock-reminder') {
    if (!record.activeShift) return `No change: ${member.displayName} is not currently clocked in.`;
    const dmDelivered = await sendShiftReminder(member.id, new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('Clock-out reminder from a supervisor')
      .setDescription(`${supervisor} asked you to clock out through the operations portal when your **${record.activeShift.department}** shift is complete.`)
      .addFields({ name: 'Department', value: record.activeShift.department, inline: true }, { name: 'Clocked in', value: timestamp(record.activeShift.start), inline: true })
      .setTimestamp());
    await sendClockLog(guild, new EmbedBuilder().setColor(0xf1c40f).setTitle('Supervisor clock-out reminder').setDescription(`${member} was sent a clock-out reminder by **${supervisor}** via the operations portal.`).setTimestamp());
    return dmDelivered
      ? `Clock-out reminder delivered to ${member.displayName}.`
      : `Clock-out reminder could not be delivered to ${member.displayName}; Discord rejected the direct message (privacy settings).`;
  }

  return 'No change: the requested supervisor action is not supported.';
}

async function acknowledgeSupervisorCommand(id, result) {
  const url = supervisorCommandsUrl();
  if (!url) throw new Error('PORTAL_INGEST_URL is not configured.');
  const response = await fetch(url, {
    method: 'POST',
    headers: portalHeaders(),
    body: JSON.stringify({ id, result }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Portal returned ${response.status}`);
}

async function checkSupervisorCommands() {
  const url = supervisorCommandsUrl();
  if (!url || !portalIngestToken() || supervisorCommandCheckRunning) return;
  supervisorCommandCheckRunning = true;
  try {
    const response = await fetch(url, { headers: portalHeaders(), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Portal returned ${response.status}`);
    const payload = await response.json();
    const queued = Array.isArray(payload.commands) ? payload.commands : [];
    if (!queued.length) return;
    const guild = await supervisorGuild();
    if (!guild) {
      console.warn('Deferring supervisor commands because no single Discord guild could be resolved.');
      return;
    }
    for (const command of queued) {
      if (!Number.isSafeInteger(command?.id) || typeof command?.memberId !== 'string' || !command.memberId || typeof command?.action !== 'string') continue;
      let result;
      if (store.hasProcessedSupervisorCommand(guild.id, command.id)) {
        result = 'Already processed by this bot; no further change was made.';
      } else {
        try {
          result = await executeSupervisorCommand(guild, command);
        } catch (error) {
          console.error(`Supervisor command ${command.id} failed:`, error);
          result = 'The supervisor action failed while the bot was processing it; no shift change was recorded.';
        }
        store.markSupervisorCommandProcessed(guild.id, command.id);
        store.save();
      }
      await acknowledgeSupervisorCommand(command.id, result).catch(error => console.warn(`Could not acknowledge supervisor command ${command.id}:`, error.message));
    }
  } catch (error) {
    console.warn('Could not check supervisor commands:', error.message);
  } finally {
    supervisorCommandCheckRunning = false;
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Ready as ${readyClient.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} ${DISCORD_GUILD_ID ? 'guild' : 'global'} commands.`);
  for (const [guildId, guildData] of Object.entries(store.data().guilds)) {
    if (!guildData.clockChannelId) continue;
    const guild = await readyClient.guilds.fetch(guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(guildData.clockChannelId).catch(() => null) : null;
    if (guild && channel?.isTextBased()) await ensurePanel(guild, channel).catch(error => console.error(`Could not reconcile clock panel for ${guildId}:`, error));
  }
  await checkInactivity();
  await checkShiftReminders();
  await refreshAllDutyRosters();
  for (const guildId of Object.keys(store.data().guilds)) {
    const guild = await readyClient.guilds.fetch(guildId).catch(() => null);
    if (guild) await guild.members.fetch().catch(() => null);
  }
  await refreshAllPortalSnapshots();
  await refreshAllUnitRosters();
  await checkSupervisorCommands();
  setInterval(checkSupervisorCommands, 15 * 1000);
  setInterval(checkInactivity, 60 * 60 * 1000);
  setInterval(checkShiftReminders, 60 * 1000);
  setInterval(refreshAllDutyRosters, 5 * 60 * 1000);
  setInterval(refreshAllPortalSnapshots, 60 * 1000);
  setInterval(refreshAllUnitRosters, 5 * 60 * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.guildId) return;
    if (interaction.isChatInputCommand()) {
      const guildData = store.guild(interaction.guildId);
      if (interaction.commandName === 'clock-panel') {
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel?.isTextBased() || channel.isDMBased()) return interaction.reply({ content: 'Choose a server text channel for the clock panel.', ephemeral: true });
        await publishFreshPanel(interaction.guild, channel);
        return interaction.reply({ content: `Clock panel is ready in ${channel}.`, ephemeral: true });
      }
      if (interaction.commandName === 'duty-roster') {
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel?.isTextBased() || channel.isDMBased()) return interaction.reply({ content: 'Choose a server text channel for the duty roster.', ephemeral: true });
        guildData.rosterChannelId = channel.id;
        guildData.rosterMessageId = null;
        store.save();
        await refreshDutyRoster(interaction.guild);
        return interaction.reply({ content: `Live duty roster is ready in ${channel}.`, ephemeral: true });
      }
      if (interaction.commandName === 'clock-config') {
        const trackedRole = interaction.options.getRole('tracked-role');
        const inactivityDays = interaction.options.getInteger('inactivity-days');
        if (trackedRole) {
          const changedRole = guildData.trackedRoleId !== trackedRole.id;
          guildData.trackedRoleId = trackedRole.id;
          if (changedRole || !guildData.enforcementStartedAt) guildData.enforcementStartedAt = new Date().toISOString();
        }
        if (inactivityDays) guildData.inactivityDays = inactivityDays;
        store.save();
        await refreshDutyRoster(interaction.guild);
        return interaction.reply({ content: `Attendance checks: **${guildData.inactivityDays} day(s)**. Tracking role: ${guildData.trackedRoleId ? `<@&${guildData.trackedRoleId}>` : 'members with clock history only'}.`, ephemeral: true });
      }
      if (interaction.commandName === 'unit-roster') {
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel?.isTextBased() || channel.isDMBased()) return interaction.reply({ content: 'Choose a server text channel for the Echo unit roster.', ephemeral: true });
        guildData.unitRosterChannelId = channel.id;
        guildData.unitRosterMessageId = null;
        store.save();
        await refreshUnitRoster(interaction.guild);
        return interaction.reply({ content: `Echo unit roster is ready in ${channel}.`, ephemeral: true });
      }
      if (interaction.commandName === 'unit-assign') {
        const user = interaction.options.getUser('member', true);
        const unit = normalizeEchoUnit(interaction.options.getString('unit', true));
        if (!unit) return interaction.reply({ content: 'Use an Echo unit from **E-400** through **E-450**.', ephemeral: true });
        const assignments = echoUnitAssignments(guildData);
        const currentHolder = assignments[unit];
        if (currentHolder && currentHolder !== user.id) return interaction.reply({ content: `**${unit}** is already assigned to <@${currentHolder}>. Unassign it first before replacing the holder.`, ephemeral: true });
        const previousUnit = Object.keys(assignments).find(assignedUnit => assignments[assignedUnit] === user.id);
        if (previousUnit && previousUnit !== unit) delete assignments[previousUnit];
        assignments[unit] = user.id;
        store.save();
        await refreshUnitRoster(interaction.guild);
        return interaction.reply({ content: `${user} is assigned to **${unit}**${previousUnit && previousUnit !== unit ? ` (moved from **${previousUnit}**)` : ''}.`, ephemeral: true });
      }
      if (interaction.commandName === 'unit-unassign') {
        const unit = normalizeEchoUnit(interaction.options.getString('unit', true));
        if (!unit) return interaction.reply({ content: 'Use an Echo unit from **E-400** through **E-450**.', ephemeral: true });
        const assignments = echoUnitAssignments(guildData);
        const memberId = assignments[unit];
        if (!memberId) return interaction.reply({ content: `**${unit}** is already unassigned.`, ephemeral: true });
        delete assignments[unit];
        store.save();
        await refreshUnitRoster(interaction.guild);
        return interaction.reply({ content: `Removed <@${memberId}> from **${unit}**.`, ephemeral: true });
      }      if (interaction.commandName === 'clock-config') {
        const trackedRole = interaction.options.getRole('tracked-role');
        const inactivityDays = interaction.options.getInteger('inactivity-days');
        if (trackedRole) {
          const changedRole = guildData.trackedRoleId !== trackedRole.id;
          guildData.trackedRoleId = trackedRole.id;
          if (changedRole || !guildData.enforcementStartedAt) guildData.enforcementStartedAt = new Date().toISOString();
        }
        if (inactivityDays) guildData.inactivityDays = inactivityDays;
        store.save();
        await refreshDutyRoster(interaction.guild);
        return interaction.reply({ content: `Attendance checks: **${guildData.inactivityDays} day(s)**. Tracking role: ${guildData.trackedRoleId ? `<@&${guildData.trackedRoleId}>` : 'members with clock history only'}.`, ephemeral: true });
      }
      if (interaction.commandName === 'loa-request') {
        const reason = interaction.options.getString('reason', true).trim();
        let startDate;
        let endDate;
        try {
          startDate = parseLeaveDate(interaction.options.getString('start-date', true), 'Start date');
          endDate = parseLeaveDate(interaction.options.getString('end-date', true), 'End date');
        } catch (error) {
          return interaction.reply({ content: error.message, ephemeral: true });
        }
        if (endDate < startDate) return interaction.reply({ content: 'The end date must be on or after the start date.', ephemeral: true });
        const request = {
          id: randomUUID(),
          memberId: interaction.user.id,
          startDate,
          endDate,
          reason,
          status: 'pending',
          requestedAt: new Date().toISOString(),
          reviewedAt: null,
          reviewedBy: null,
          reviewNote: null,
        };
        const conflictingRequest = guildData.leaveRequests.find(existing => existing.memberId === request.memberId && existing.status !== 'declined' && leavesOverlap(existing, request));
        if (conflictingRequest) {
          return interaction.reply({ content: `You already have a **${conflictingRequest.status}** leave request (\`${leaveRequestReference(conflictingRequest)}\`) that overlaps those dates.`, ephemeral: true });
        }
        guildData.leaveRequests.push(request);
        store.save();
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('Leave request submitted')
          .setDescription('Your request is pending manager review.')
          .addFields(
            { name: 'Request ID', value: `\`${leaveRequestReference(request)}\``, inline: true },
            { name: 'Leave dates', value: `${request.startDate} through ${request.endDate}`, inline: true },
            { name: 'Reason', value: reason, inline: false },
          )
          .setTimestamp()], ephemeral: true });
      }
      if (interaction.commandName === 'loa-status') {
        const user = interaction.options.getUser('member') ?? interaction.user;
        const requests = guildData.leaveRequests
          .filter(request => request.memberId === user.id)
          .sort((first, second) => second.requestedAt.localeCompare(first.requestedAt));
        if (!requests.length) return interaction.reply({ content: `${user} has no recorded leave-of-absence requests.`, ephemeral: true });
        const canViewReasons = user.id === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        const fields = requests.slice(0, 10).map(request => ({
          name: `\`${leaveRequestReference(request)}\` — ${request.status}`,
          value: `${request.startDate} through ${request.endDate}${canViewReasons ? `\nReason: ${request.reason}` : ''}${request.reviewNote && canViewReasons ? `\nReview note: ${request.reviewNote}` : ''}`,
          inline: false,
        }));
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`${user.username}'s leave requests`)
          .setDescription(requests.length > 10 ? `Showing the 10 most recent of ${requests.length} requests.` : 'Date ranges are inclusive.')
          .addFields(fields)
          .setTimestamp()], ephemeral: true });
      }
      if (interaction.commandName === 'loa-review') {
        const user = interaction.options.getUser('member', true);
        const request = findLeaveRequest(guildData.leaveRequests, user.id, interaction.options.getString('request-id', true));
        if (!request) return interaction.reply({ content: 'No unique leave request matched that member and ID. Use the short ID shown by `/loa-status`.', ephemeral: true });
        if (request.status !== 'pending') return interaction.reply({ content: `Leave request \`${leaveRequestReference(request)}\` is already **${request.status}**.`, ephemeral: true });
        const decision = interaction.options.getString('decision', true);
        if (decision === 'approved') {
          const overlap = guildData.leaveRequests.find(existing => existing.id !== request.id && existing.memberId === user.id && existing.status === 'approved' && leavesOverlap(existing, request));
          if (overlap) return interaction.reply({ content: `This overlaps approved leave request \`${leaveRequestReference(overlap)}\`. Decline or adjust one of the requests first.`, ephemeral: true });
        }
        const note = interaction.options.getString('note')?.trim() || null;
        request.status = decision;
        request.reviewedAt = new Date().toISOString();
        request.reviewedBy = interaction.user.id;
        request.reviewNote = note;
        store.save();
        const color = decision === 'approved' ? 0x2ecc71 : 0xe74c3c;
        const decisionLabel = decision === 'approved' ? 'approved' : 'declined';
        await interaction.reply({ content: `Leave request \`${leaveRequestReference(request)}\` for ${user} was **${decisionLabel}**.`, ephemeral: true });
        await user.send({ embeds: [new EmbedBuilder()
          .setColor(color)
          .setTitle(`Leave request ${decisionLabel}`)
          .setDescription(`Your leave request for **${request.startDate} through ${request.endDate}** was ${decisionLabel}.`)
          .addFields(note ? { name: 'Review note', value: note, inline: false } : { name: 'Review note', value: 'No note provided.', inline: false })
          .setTimestamp()] }).catch(() => null);
        await sendClockLog(interaction.guild, new EmbedBuilder()
          .setColor(color)
          .setTitle(`Leave request ${decisionLabel}`)
          .setDescription(`${user}'s leave request was ${decisionLabel}.`)
          .addFields({ name: 'Leave dates', value: `${request.startDate} through ${request.endDate}`, inline: true }, { name: 'Reviewed by', value: `${interaction.user}`, inline: true })
          .setTimestamp());
        return;
      }
      if (interaction.commandName === 'clock-status') {
        const user = interaction.options.getUser('member') ?? interaction.user;
        return interaction.reply({ embeds: [statusEmbed(user, store.member(interaction.guildId, user.id))], ephemeral: true });
      }
      if (interaction.commandName === 'clock-report') {
        const user = interaction.options.getUser('member') ?? interaction.user;
        const days = interaction.options.getInteger('days') ?? 30;
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const record = store.member(interaction.guildId, user.id);
        const shifts = record.shifts.filter(shift => shift.end && new Date(shift.start).getTime() >= cutoff).sort((a, b) => new Date(b.start) - new Date(a.start));
        const text = shifts.length ? shifts.slice(0, 15).map(shift => `• \`${shiftReference(shift)}\` — ${timestamp(shift.start)} — **${shift.department}**, ${duration(new Date(shift.end) - new Date(shift.start))} *[${shift.approvalStatus}]*`).join('\n') : 'No completed shifts in this window.';
        store.save();
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${user.username}'s last ${days} days`).setDescription(text).setFooter({ text: shifts.length > 15 ? `Showing 15 of ${shifts.length} shifts` : `${shifts.length} shifts` })], ephemeral: true });
      }
      if (interaction.commandName === 'clock-strike') {
        const user = interaction.options.getUser('member', true);
        const action = interaction.options.getString('action', true);
        const reason = interaction.options.getString('reason') ?? 'Manual administrator adjustment';
        const record = store.member(interaction.guildId, user.id);
        const delta = action === 'add' ? 1 : action === 'remove' ? -1 : -record.strikes;
        record.strikes = Math.max(0, record.strikes + delta);
        record.strikeHistory.push({ at: new Date().toISOString(), delta, reason, by: interaction.user.id });
        store.save();
        return interaction.reply({ content: `${user}'s strike count is now **${record.strikes}**.`, ephemeral: true });
      }
      if (interaction.commandName === 'time-add') {
        const user = interaction.options.getUser('member', true);
        const department = interaction.options.getString('roster', true);
        const reason = interaction.options.getString('reason', true);
        let start;
        let end;
        try {
          start = parseIsoDate(interaction.options.getString('start', true), 'Start time');
          end = parseIsoDate(interaction.options.getString('end', true), 'End time');
        } catch (error) {
          return interaction.reply({ content: error.message, ephemeral: true });
        }
        if (new Date(end) <= new Date(start)) return interaction.reply({ content: 'End time must be after the start time.', ephemeral: true });
        const shift = {
          id: randomUUID(),
          start,
          end,
          department,
          source: 'manual',
          approvalStatus: 'pending',
          audit: [{ at: new Date().toISOString(), action: 'manual-shift-added', by: interaction.user.id, reason }],
        };
        store.member(interaction.guildId, user.id).shifts.push(shift);
        store.save();
        await interaction.reply({ content: `Added pending shift \`${shiftReference(shift)}\` for ${user}: **${department}**, ${duration(new Date(end) - new Date(start))}.`, ephemeral: true });
        await sendClockLog(interaction.guild, new EmbedBuilder().setColor(0xf1c40f).setTitle('Manual shift awaiting approval').setDescription(`${user} received a manual **${department}** shift.`).addFields({ name: 'Shift ID', value: `\`${shiftReference(shift)}\``, inline: true }, { name: 'Duration', value: duration(new Date(end) - new Date(start)), inline: true }, { name: 'Reason', value: reason, inline: false }).setTimestamp());
        return;
      }
      if (interaction.commandName === 'time-edit') {
        const user = interaction.options.getUser('member', true);
        const record = store.member(interaction.guildId, user.id);
        const shift = findShift(record, interaction.options.getString('shift-id', true));
        if (!shift) return interaction.reply({ content: 'No unique completed shift matched that ID. Use the short ID shown by `/clock-report`.', ephemeral: true });
        const roster = interaction.options.getString('roster');
        const startInput = interaction.options.getString('start');
        const endInput = interaction.options.getString('end');
        if (!roster && !startInput && !endInput) return interaction.reply({ content: 'Provide at least one corrected roster, start time, or end time.', ephemeral: true });
        let start;
        let end;
        try {
          start = startInput ? parseIsoDate(startInput, 'Start time') : shift.start;
          end = endInput ? parseIsoDate(endInput, 'End time') : shift.end;
        } catch (error) {
          return interaction.reply({ content: error.message, ephemeral: true });
        }
        if (new Date(end) <= new Date(start)) return interaction.reply({ content: 'End time must be after the start time.', ephemeral: true });
        const reason = interaction.options.getString('reason', true);
        const before = { department: shift.department, start: shift.start, end: shift.end, approvalStatus: shift.approvalStatus };
        shift.department = roster ?? shift.department;
        shift.start = start;
        shift.end = end;
        shift.approvalStatus = 'pending';
        ensureShiftMetadata(shift).audit.push({ at: new Date().toISOString(), action: 'shift-corrected', by: interaction.user.id, reason, before });
        store.save();
        await interaction.reply({ content: `Corrected shift \`${shiftReference(shift)}\` for ${user}; it is now pending approval.`, ephemeral: true });
        await sendClockLog(interaction.guild, new EmbedBuilder().setColor(0xf1c40f).setTitle('Shift correction awaiting approval').setDescription(`${user}'s **${shift.department}** shift was corrected.`).addFields({ name: 'Shift ID', value: `\`${shiftReference(shift)}\``, inline: true }, { name: 'Reason', value: reason, inline: false }).setTimestamp());
        return;
      }
      if (interaction.commandName === 'time-approve') {
        const user = interaction.options.getUser('member', true);
        const record = store.member(interaction.guildId, user.id);
        const shift = findShift(record, interaction.options.getString('shift-id', true));
        if (!shift) return interaction.reply({ content: 'No unique completed shift matched that ID. Use the short ID shown by `/clock-report`.', ephemeral: true });
        if (shift.approvalStatus !== 'pending') return interaction.reply({ content: `Shift \`${shiftReference(shift)}\` is already marked **${shift.approvalStatus}**.`, ephemeral: true });
        const decision = interaction.options.getString('decision', true);
        const note = interaction.options.getString('note') ?? 'No review note provided.';
        shift.approvalStatus = decision;
        ensureShiftMetadata(shift).audit.push({ at: new Date().toISOString(), action: `shift-${decision}`, by: interaction.user.id, note });
        store.save();
        await interaction.reply({ content: `Shift \`${shiftReference(shift)}\` for ${user} was **${decision}**.`, ephemeral: true });
        await sendClockLog(interaction.guild, new EmbedBuilder().setColor(decision === 'approved' ? 0x2ecc71 : 0xe74c3c).setTitle(`Shift ${decision}`).setDescription(`${user}'s **${shift.department}** shift was ${decision}.`).addFields({ name: 'Shift ID', value: `\`${shiftReference(shift)}\``, inline: true }, { name: 'Review note', value: note, inline: false }).setTimestamp());
        return;
      }
    }

    if (interaction.isButton()) {
      const record = store.member(interaction.guildId, interaction.user.id);
      if (interaction.customId === 'clock:in') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (record.activeShift) return interaction.editReply({ content: `You are already clocked in for **${record.activeShift.department}** since ${timestamp(record.activeShift.start)}.` });
        const rosterSelect = new StringSelectMenuBuilder()
          .setCustomId('clock:roster')
          .setPlaceholder('Select your roster')
          .addOptions(ROSTER_OPTIONS.map(roster => ({ label: roster, value: roster })));
        return interaction.editReply({
          content: 'Select the roster you are starting a shift for.',
          components: [new ActionRowBuilder().addComponents(rosterSelect)],
        });
      }
      if (interaction.customId === 'clock:out') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!record.activeShift) return interaction.editReply({ content: 'You are not currently clocked in.' });
        const end = new Date().toISOString();
        const shift = ensureShiftMetadata({ ...record.activeShift, end });
        shift.audit.push({ at: end, action: 'clocked-out', by: interaction.user.id });
        record.shifts.push(shift);
        record.activeShift = null;
        store.save();
        await interaction.editReply({ content: `Clocked out of **${shift.department}**. Shift duration: **${duration(new Date(end) - new Date(shift.start))}**.` });
        await sendClockLog(interaction.guild, new EmbedBuilder().setColor(0xe74c3c).setTitle('Shift completed').setDescription(`${interaction.user} clocked out of **${shift.department}**.`).addFields({ name: 'Started', value: timestamp(shift.start), inline: true }, { name: 'Duration', value: duration(new Date(end) - new Date(shift.start)), inline: true }).setTimestamp());
        await refreshDutyRoster(interaction.guild);
        return;
      }
      if (interaction.customId === 'clock:status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({ embeds: [statusEmbed(interaction.user, record)] });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'clock:roster') {
      await interaction.deferUpdate();
      const record = store.member(interaction.guildId, interaction.user.id);
      if (record.activeShift) return interaction.editReply({ content: 'You already have an active shift.', components: [] });
      const department = interaction.values[0];
      const start = new Date().toISOString();
      record.activeShift = {
        id: randomUUID(),
        start,
        department,
        source: 'clock',
        approvalStatus: 'recorded',
        audit: [{ at: start, action: 'clocked-in', by: interaction.user.id }],
      };
      record.lastClockIn = start;
      record.lastInactivityStrikeWeek = 0;
      store.save();
      await interaction.editReply({ content: `Clocked in for **${department}** at ${timestamp(start)}.`, components: [] });
      await sendClockLog(interaction.guild, new EmbedBuilder().setColor(0x2ecc71).setTitle('Shift started').setDescription(`${interaction.user} clocked in for **${department}**.`).addFields({ name: 'Started', value: timestamp(start), inline: true }).setTimestamp());
      await refreshDutyRoster(interaction.guild);
    }
  } catch (error) {
    if (error?.code === 10062) {
      console.warn(`Ignoring expired interaction ${interaction.id}.`);
      return;
    }
    console.error('Interaction error:', error);
    const payload = { content: 'Something went wrong while handling that request. Please try again.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;
  const guildData = store.guild(message.guild.id);
  if (message.channelId !== guildData.clockChannelId) return;
  schedulePanelMove(message.guild);
});

client.login(DISCORD_TOKEN);