const refreshButton = document.querySelector('#refresh');
const syncLabel = document.querySelector('#sync-label');
const pageTitle = document.querySelector('#page-title');

refreshButton?.addEventListener('click', () => {
  refreshButton.disabled = true;
  refreshButton.textContent = '↻ Syncing';
  syncLabel.textContent = 'Refreshing portal data';
  window.setTimeout(() => {
    const now = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date());
    refreshButton.disabled = false;
    refreshButton.textContent = '↻ Refresh';
    syncLabel.textContent = `Synced at ${now}`;
  }, 650);
});

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