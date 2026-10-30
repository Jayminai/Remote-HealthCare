// Small progressive enhancements used across the site.
// (No inline scripts are used, so the Content Security Policy can block them.)
document.addEventListener('DOMContentLoaded', () => {
  // Ask for confirmation before destructive actions: <form data-confirm="Are you sure?">
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
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

  // Print buttons: <button data-print>
  document.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));

  // Keep message threads scrolled to the newest message.
  const thread = document.querySelector('.thread');
  if (thread) thread.scrollTop = thread.scrollHeight;

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

  // Reveal-on-click panels: <button data-toggle="#id">
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.toggle);
      if (target) target.hidden = !target.hidden;
    });
  });
});
