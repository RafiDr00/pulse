#!/usr/bin/env node

import { PulseMonitor } from './src/monitor.js';
import { TerminalDashboard } from './src/dashboard.js';

// Hard reset terminal so no previous shell output bleeds behind the UI.
process.stdout.write('\x1bc');

const monitor = new PulseMonitor();
const dashboard = new TerminalDashboard(monitor);

dashboard.init();
monitor.start();

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
