const refreshButton = document.querySelector('#refresh');
const syncLabel = document.querySelector('#sync-label');
const pageTitle = document.querySelector('#page-title');

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

function renderSnapshot(snapshot) {
  const { metrics, activeShifts, leaveRequests, activity } = snapshot;
  document.querySelector('[data-metric="members"]').textContent = metrics.members;
  document.querySelector('[data-metric="on-duty"]').textContent = metrics.onDuty;
  document.querySelector('[data-metric="strikes"]').textContent = metrics.activeStrikes;
  document.querySelector('[data-metric="leave"]').textContent = metrics.approvedLeaveToday;
  document.querySelector('[data-metric-detail="members"]').textContent = 'Recorded roster members';
  document.querySelector('[data-metric-detail="on-duty"]').textContent = `${metrics.weeklyHours.toFixed(1)}h this week`;
  document.querySelector('[data-metric-detail="strikes"]').textContent = 'Current total';
  document.querySelector('[data-metric-detail="leave"]').textContent = metrics.approvedLeaveToday ? 'Members away today' : 'No members away today';

  const dutyList = document.querySelector('#duty-list');
  dutyList.innerHTML = activeShifts.length ? activeShifts.map((shift, index) => `
    <div class="duty-row"><span class="avatar ${['avatar-cyan', 'avatar-yellow', 'avatar-purple'][index % 3]}">${escapeHtml(shift.name.slice(0, 2).toUpperCase())}</span><div><strong>${escapeHtml(shift.name)}</strong><small>${escapeHtml(shift.department)}</small></div><time>${elapsedTime(shift.clockedInAt)}</time><span class="status-dot"></span></div>`).join('') : '<p class="panel-note">No members are currently clocked in.</p>';

  const leaveList = document.querySelector('#leave-list');
  leaveList.innerHTML = leaveRequests.length ? leaveRequests.slice(0, 4).map(request => {
    const date = new Date(`${request.startDate}T12:00:00Z`);
    const status = request.status === 'approved' ? 'approved' : 'pending';
    return `<div class="leave-date"><span class="date-box"><b>${date.getUTCDate()}</b><small>${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()}</small></span><div><strong>${escapeHtml(request.name)}</strong><small>${escapeHtml(status === 'approved' ? 'Approved leave' : 'Pending review')} · ${escapeHtml(dateFormatter.format(date))}–${escapeHtml(dateFormatter.format(new Date(`${request.endDate}T12:00:00Z`)))}</small></div><span class="pill ${status}">${status}</span></div>`;
  }).join('') : '<p class="panel-note">No upcoming leave requests.</p>';

  const activityList = document.querySelector('#activity-list');
  activityList.innerHTML = activity.length ? activity.slice(0, 6).map(entry => {
    const cssClass = entry.type === 'strike' ? 'strike' : entry.type === 'leave' ? 'leave-icon' : 'plus';
    const icon = entry.type === 'strike' ? '!' : entry.type === 'leave' ? '▣' : '+';
    return `<li><span class="activity-icon ${cssClass}">${icon}</span><div><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.detail)}</small></div><time>${relativeTime(entry.at)}</time></li>`;
  }).join('') : '<li><span class="activity-icon leave-icon">▣</span><div><strong>No recent activity</strong><small>The portal will list clock, leave, and attendance updates here.</small></div><time>—</time></li>';

  const generated = new Date(snapshot.generatedAt);
  syncLabel.textContent = `Snapshot ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(generated)}`;
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
}

refreshButton?.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = '↻ Syncing';
  syncLabel.textContent = 'Refreshing portal snapshot';
  try {
    await loadSnapshot();
  } catch {
    showNoSnapshotState();
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = '↻ Refresh';
  }
});

loadSnapshot().catch(showNoSnapshotState);

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelector('.nav-link.active')?.classList.remove('active');
    link.classList.add('active');
    pageTitle.textContent = link.dataset.view === 'Dashboard' ? 'Lakeside EMS' : link.dataset.view;
  });
});

document.querySelectorAll('.view-toggle button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelector('.view-toggle .selected')?.classList.remove('selected');
    button.classList.add('selected');
  });
});