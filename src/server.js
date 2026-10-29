const config = require('./config');
const { createApp } = require('./app');
const { ensureAdmin } = require('./db/bootstrap');
const { startReminderJob } = require('./services/reminders');

ensureAdmin();
startReminderJob();

createApp().listen(config.port, () => {
  console.log(`UHS Telemedicine running at ${config.appUrl}`);
  if (!config.smtp.host) console.log('SMTP not configured: emails are saved to the outbox (Admin > Email outbox) only.');
});
