#!/usr/bin/env node

import { PulseMonitor } from './src/monitor.js';
import { TerminalDashboard } from './src/dashboard.js';

const monitor = new PulseMonitor();
const dashboard = new TerminalDashboard(monitor);

dashboard.init();
monitor.start();

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
