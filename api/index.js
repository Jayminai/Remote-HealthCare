// Vercel entry point: the whole Express app runs as one serverless function.
// vercel.json rewrites every path to this function.
const { createApp } = require('../src/app');

module.exports = createApp();
