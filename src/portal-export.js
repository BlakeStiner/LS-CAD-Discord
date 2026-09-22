const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const snapshotPath = path.join(__dirname, '..', 'portal', 'dist', 'data', 'operations.json');
const weekMs = 7 * 24 * 60 * 60 * 1000;
function portalIngestUrl() {
  const configured = process.env.PORTAL_INGEST_URL?.trim();
  if (configured) return configured;
  const portalUrl = process.env.CAD_PORTAL_URL?.trim().replace(/\/+$/, '');
  return portalUrl ? `${portalUrl}/api/operations/ingest` : '';
}

function safeName(guild, memberId) {
  const member = guild.members.cache.get(memberId);
  return member?.displayName ?? `Member ${memberId.slice(-4)}`;
}

function hoursBetween(start, end) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime()) / (60 * 60 * 1000);
}

function recentShiftHistory(record) {
  return (record.shifts ?? [])
    .filter((shift) => shift.start && shift.end && shift.approvalStatus !== 'rejected')
    .sort((first, second) => new Date(second.end).getTime() - new Date(first.end).getTime())
    .slice(0, 12)
    .map((shift) => ({ department: shift.department ?? 'Lakeside EMS', clockedInAt: shift.start, clockedOutAt: shift.end }));
}

function isApprovedToday(request, nowDate) {
  const today = nowDate.toISOString().slice(0, 10);
  return request.status === 'approved' && request.startDate <= today && request.endDate >= today;
}

function activityForMember(memberName, record) {
  const activity = [];
  for (const strike of record.strikeHistory ?? []) {
    activity.push({ at: strike.at, type: 'strike', title: 'Attendance strike issued', detail: `${memberName} — ${strike.reason}` });
  }
  for (const shift of [...record.shifts, record.activeShift].filter(Boolean)) {
    for (const audit of shift.audit ?? []) {
      if (audit.action === 'clocked-in' || audit.action === 'clocked-out' || audit.action === 'automatically-clocked-out') {
        activity.push({
          at: audit.at,
          type: audit.action === 'clocked-in' ? 'clock-in' : 'clock-out',
          title: `${memberName} ${audit.action === 'clocked-in' ? 'clocked in' : 'clocked out'}`,
          detail: shift.department,
        });
      }
    }
  }
  return activity;
}

function buildPortalSnapshot(guild) {
  const guildData = store.guild(guild.id);
  const callSignsByMember = new Map(Object.entries(guildData.echoUnitAssignments ?? {}).map(([callSign, memberId]) => [String(memberId), callSign]));
  const now = new Date();
  const nowMs = now.getTime();
  const weekStart = nowMs - weekMs;
  const members = Object.entries(guildData.members).map(([memberId, record]) => ({
    id: memberId,
    name: safeName(guild, memberId),
    callSign: callSignsByMember.get(memberId) ?? null,
    department: record.activeShift?.department ?? null,
    clockedInAt: record.activeShift?.start ?? null,
    recentShifts: recentShiftHistory(record),
    strikes: record.strikes ?? 0,
    lastClockIn: record.lastClockIn ?? null,
  })).sort((first, second) => first.name.localeCompare(second.name));
  const activeShifts = members.filter(member => member.clockedInAt).map(member => ({
    id: member.id,
    name: member.name,
    callSign: member.callSign,
    department: member.department,
    clockedInAt: member.clockedInAt,
  })).sort((first, second) => new Date(first.clockedInAt) - new Date(second.clockedInAt));
  const completedHours = Object.values(guildData.members).reduce((total, record) => total + record.shifts
    .filter(shift => shift.end && shift.approvalStatus !== 'rejected' && new Date(shift.end).getTime() >= weekStart)
    .reduce((shiftTotal, shift) => shiftTotal + hoursBetween(shift.start, shift.end), 0), 0);
  const activeHours = activeShifts.reduce((total, shift) => total + hoursBetween(shift.clockedInAt, now), 0);
  const leaveRequests = guildData.leaveRequests
    .filter(request => request.status === 'approved' || request.status === 'pending')
    .filter(request => request.endDate >= now.toISOString().slice(0, 10))
    .sort((first, second) => first.startDate.localeCompare(second.startDate))
    .slice(0, 8)
    .map(request => ({ name: safeName(guild, request.memberId), startDate: request.startDate, endDate: request.endDate, status: request.status }));
  const activity = Object.entries(guildData.members)
    .flatMap(([memberId, record]) => activityForMember(safeName(guild, memberId), record))
    .concat(guildData.leaveRequests.filter(request => request.reviewedAt).map(request => ({
      at: request.reviewedAt,
      type: 'leave',
      title: `Leave request ${request.status}`,
      detail: `${safeName(guild, request.memberId)} — ${request.startDate} through ${request.endDate}`,
    })))
    .sort((first, second) => new Date(second.at) - new Date(first.at))
    .slice(0, 12);

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    roster: 'Lakeside EMS',
    metrics: {
      members: members.length,
      onDuty: activeShifts.length,
      weeklyHours: Math.round((completedHours + activeHours) * 10) / 10,
      activeStrikes: members.reduce((total, member) => total + member.strikes, 0),
      approvedLeaveToday: guildData.leaveRequests.filter(request => isApprovedToday(request, now)).length,
    },
    members,
    activeShifts,
    leaveRequests,
    activity,
  };
}

function writePortalSnapshot(guild) {
  const snapshot = buildPortalSnapshot(guild);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2));
  fs.renameSync(temporaryPath, snapshotPath);
  return snapshot;
}

async function publishPortalSnapshot(snapshot) {
  const endpoint = portalIngestUrl();
  const token = portalIngestToken();
  if (!endpoint || !token) return false;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Portal returned ${response.status}`);
    return true;
  } catch (error) {
    console.error('Could not publish portal snapshot:', error.message);
    return false;
  }
}

// The ingest URL is the portal's /api/operations/ingest route; the supervisor
// command queue hangs off the same origin and reuses the same ingest token.
function supervisorCommandsUrl() {
  const endpoint = portalIngestUrl();
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    url.pathname = (url.pathname.replace(/\/api\/operations\/ingest\/?$/, '') + '/api/supervisor/commands').replace(/^\/+/, '/');
    return url.toString();
  } catch (error) {
    console.error('PORTAL_INGEST_URL is not a valid URL:', error.message);
    return null;
  }
}

function portalIngestToken() {
  return process.env.PORTAL_INGEST_TOKEN?.trim() || process.env.CAD_INGEST_TOKEN?.trim() || '';
}

module.exports = {
  buildPortalSnapshot,
  writePortalSnapshot,
  publishPortalSnapshot,
  supervisorCommandsUrl,
  portalIngestToken,
  snapshotPath,
};
