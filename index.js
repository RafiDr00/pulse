#!/usr/bin/env node

import { PulseMonitor } from './src/monitor.js';
import { TerminalDashboard } from './src/dashboard.js';

// Hard reset terminal so no previous shell output bleeds behind the UI.
process.stdout.write('\x1bc');

const monitor = new PulseMonitor();
const dashboard = new TerminalDashboard(monitor);

dashboard.init();
monitor.start();

process.on('uncaughtException', (error) => {
	process.stderr.write(`pulse fatal uncaughtException: ${error?.stack || error}\n`);
	process.exit(1);
});

process.on('unhandledRejection', (reason) => {
	process.stderr.write(`pulse fatal unhandledRejection: ${reason?.stack || reason}\n`);
	process.exit(1);
});
