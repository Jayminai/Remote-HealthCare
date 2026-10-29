// Small progressive enhancements used across the site.
// (No inline scripts are used, so the Content Security Policy can block them.)
document.addEventListener('DOMContentLoaded', () => {
  // Ask for confirmation before destructive actions: <form data-confirm="Are you sure?">
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // Print buttons: <button data-print>
  document.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));

  // Keep message threads scrolled to the newest message.
  const thread = document.querySelector('.thread');
  if (thread) thread.scrollTop = thread.scrollHeight;

  // Reveal-on-click panels: <button data-toggle="#id">
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.toggle);
      if (target) target.hidden = !target.hidden;
    });
  });
});
