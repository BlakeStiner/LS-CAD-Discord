const refreshButton = document.querySelector('#refresh');
const syncLabel = document.querySelector('#sync-label');
const sidebarSync = document.querySelector('#sidebar-sync');
const dutyList = document.querySelector('#duty-list');
const activityList = document.querySelector('#activity-list');
const leaveList = document.querySelector('#leave-list');
const tableSummary = document.querySelector('#table-summary');

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function elapsedTime(isoDate) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function relativeTime(isoDate) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function unitLabel(shift, index) {
  const match = String(shift.department ?? '').match(/E-\d+/i);
  return match?.[0].toUpperCase() ?? `UNIT ${String(index + 1).padStart(2, '0')}`;
}

function renderSnapshot(snapshot) {
  const { metrics, activeShifts, leaveRequests, activity } = snapshot;
  document.querySelector('[data-metric="members"]').textContent = metrics.members;
  document.querySelector('[data-metric="on-duty"]').textContent = metrics.onDuty;
  document.querySelector('[data-metric="strikes"]').textContent = metrics.activeStrikes;
  document.querySelector('[data-metric="leave"]').textContent = metrics.approvedLeaveToday;
  document.querySelector('[data-metric-detail="members"]').textContent = 'Recorded roster members';
  document.querySelector('[data-metric-detail="on-duty"]').textContent = `${metrics.weeklyHours.toFixed(1)}h logged this week`;
  document.querySelector('[data-metric-detail="strikes"]').textContent = 'Current total';
  document.querySelector('[data-metric-detail="leave"]').textContent = metrics.approvedLeaveToday ? 'Members away today' : 'No members away today';

  tableSummary.textContent = activeShifts.length ? `${activeShifts.length} ACTIVE` : 'NO ACTIVE UNITS';
  dutyList.innerHTML = activeShifts.length ? activeShifts.map((shift, index) => `
    <tr><td><span class="unit-tag">${escapeHtml(unitLabel(shift, index))}</span></td><td><strong>${escapeHtml(shift.name)}</strong></td><td>${escapeHtml(shift.department)}</td><td><span class="duty-state"><i></i>On duty</span></td><td class="mono">${elapsedTime(shift.clockedInAt)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="5">No members are currently clocked in.</td></tr>';

  leaveList.innerHTML = leaveRequests.length ? leaveRequests.slice(0, 4).map(request => {
    const start = new Date(`${request.startDate}T12:00:00Z`);
    const end = new Date(`${request.endDate}T12:00:00Z`);
    const status = request.status === 'approved' ? 'approved' : 'pending';
    return `<div class="leave-row"><span class="leave-date"><b>${start.getUTCDate()}</b><small>${start.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()}</small></span><div><strong>${escapeHtml(request.name)}</strong><small>${escapeHtml(dateFormatter.format(start))} – ${escapeHtml(dateFormatter.format(end))}</small></div><span class="leave-status ${status}">${status}</span></div>`;
  }).join('') : '<p class="empty-copy">No upcoming leave requests.</p>';

  activityList.innerHTML = activity.length ? activity.slice(0, 6).map(entry => {
    const type = entry.type === 'strike' ? 'strike' : entry.type === 'leave' ? 'leave' : 'clock';
    const icon = type === 'strike' ? '!' : type === 'leave' ? '▣' : '◷';
    return `<li><span class="activity-icon ${type}">${icon}</span><div><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.detail)}</small></div><time>${relativeTime(entry.at)}</time></li>`;
  }).join('') : '<li class="empty-activity"><span>—</span><div><strong>No recent activity</strong><small>The next verified clock, leave, or attendance update will appear here.</small></div><time>—</time></li>';

  const generated = new Date(snapshot.generatedAt);
  const formatted = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(generated);
  syncLabel.textContent = `Snapshot ${formatted}`;
  sidebarSync.textContent = `Snapshot ${formatted}`;
}

async function loadSnapshot() {
  const response = await fetch('data/operations.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
  const snapshot = await response.json();
  if (snapshot.schemaVersion !== 1 || !snapshot.metrics) throw new Error('Unsupported operations snapshot.');
  renderSnapshot(snapshot);
}

function showNoSnapshotState() {
  syncLabel.textContent = 'No operations snapshot published';
  sidebarSync.textContent = 'Awaiting snapshot';
}

refreshButton?.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = '↻ Syncing';
  syncLabel.textContent = 'Refreshing snapshot';
  try { await loadSnapshot(); } catch { showNoSnapshotState(); } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = '↻ Refresh';
  }
});

loadSnapshot().catch(showNoSnapshotState);

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelector('.nav-link.active')?.classList.remove('active');
    link.classList.add('active');
  });
});