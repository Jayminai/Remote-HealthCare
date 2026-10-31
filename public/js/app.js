// Small progressive enhancements used across the site.
// (No inline scripts are used, so the Content Security Policy can block them.)
// Listeners are attached to the document (not to each element), so they keep working for parts of the
// page that live.js replaces with fresh copies from the server.
document.addEventListener('DOMContentLoaded', () => {
  // Ask for confirmation before destructive actions: <form data-confirm="Are you sure?">
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) e.preventDefault();
  });

  // Show a spinner on the button that sent a form, and stop double submissions while the page loads.
  // Runs after the confirmation check above, so a cancelled confirm leaves the button alone.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || form.target) return;
    const btn = e.submitter || form.querySelector('button[type=submit], button:not([type])');
    if (!btn || btn.classList.contains('is-loading')) return;
    btn.classList.add('is-loading');
    if (!btn.textContent.trim()) btn.classList.add('is-loading-icon');
    btn.setAttribute('aria-busy', 'true');
    // Disable on the next tick: a disabled button is left out of the data the browser is about to send.
    setTimeout(() => { btn.disabled = true; }, 0);
  });
  // Coming back with the Back button can restore the page as it was left; reset any busy buttons.
  window.addEventListener('pageshow', () => {
    document.querySelectorAll('.is-loading').forEach((btn) => {
      btn.classList.remove('is-loading', 'is-loading-icon');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    });
  });

  // Print buttons: <button data-print>, and reveal-on-click panels: <button data-toggle="#id">
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-print]')) window.print();
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const target = document.querySelector(toggle.dataset.toggle);
      if (target) target.hidden = !target.hidden;
    }
  });

  // Phones: each table row is shown as a small card, so nothing needs sideways scrolling. Every cell is
  // labelled with its column heading (shown by the CSS in place of the hidden header row).
  const labelTables = (root) => {
    root.querySelectorAll('.table-wrap table').forEach((table) => {
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      table.classList.add(heads.length ? 'stack' : 'stack-plain');
      table.querySelectorAll('tbody tr').forEach((tr) => {
        [...tr.children].forEach((cell, i) => { if (heads[i] && cell.colSpan === 1) cell.dataset.label = heads[i]; });
      });
    });
  };
  labelTables(document);
  document.addEventListener('content:replaced', (e) => labelTables(e.detail));

  // Keep message threads scrolled to the newest message.
  const thread = document.querySelector('.thread');
  if (thread) thread.scrollTop = thread.scrollHeight;

  // Staff profile button: on wide screens it opens the profile page; on phones and tablets (where the sidebar,
  // with its sign-out button, is tucked away) it opens a menu with Profile, Settings and Sign out.
  const userMenu = document.querySelector('[data-user-menu]');
  if (userMenu) {
    const toggle = userMenu.querySelector('[data-user-menu-toggle]');
    const panel = userMenu.querySelector('[data-user-menu-panel]');
    const compact = window.matchMedia('(max-width: 960px)');
    const setOpen = (open) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', (e) => {
      if (!compact.matches) return; // follow the link
      e.preventDefault();
      setOpen(panel.hidden);
    });
    document.addEventListener('click', (e) => { if (!userMenu.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    compact.addEventListener('change', () => setOpen(false));
  }

  // Collapsible main menu on small screens.
  const header = document.querySelector('[data-header]');
  const navToggle = document.querySelector('[data-nav-toggle]');
  if (header && navToggle) {
    navToggle.addEventListener('click', () => {
      const open = header.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
  }

  // Staff portal: slide-in sidebar on small screens.
  const shell = document.querySelector('[data-staff-shell]');
  const sidebarToggle = document.querySelector('[data-staff-toggle]');
  const backdrop = document.querySelector('[data-staff-close]');
  if (shell && sidebarToggle && backdrop) {
    const setOpen = (open) => {
      shell.classList.toggle('menu-open', open);
      backdrop.hidden = !open;
      sidebarToggle.setAttribute('aria-expanded', String(open));
    };
    sidebarToggle.addEventListener('click', () => setOpen(!shell.classList.contains('menu-open')));
    backdrop.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }
});
