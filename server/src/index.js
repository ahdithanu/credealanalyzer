'use strict';

const config = require('./config');
const { createApp } = require('./app');

const server = createApp().listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port }));
});

// Fargate sends SIGTERM and waits. Draining means an in-flight underwriting
// save is not cut off mid-transaction during a deploy.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'draining', signal: sig }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
