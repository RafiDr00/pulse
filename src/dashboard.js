import blessed from 'blessed';
import chalk from 'chalk';

const C = {
  bg: '#0b1020',
  surface: '#111827',
  budgetTint: '#2f2509',
  accent: '#7c3aed',
  accentDark: '#4c1d95',
  green: '#10b981',
  yellow: '#f59e0b',
  red: '#ef4444',
  redDim: '#7f1d1d',
  muted: '#475569',
  dim: '#334155',
  cyan: '#06b6d4',
};

const STATUS_ICONS = {
  healthy: '●',
  warning: '◉',
  critical: '⬤',
  idle: '○',
};

const STATUS_PERIODS = {
  healthy: 800,
  warning: 400,
  critical: 200,
};

const ANSI_RE = /\x1B\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

function ansiLen(text) {
  return stripAnsi(text).length;
}

function padAnsiRight(text, width) {
  const gap = Math.max(0, width - ansiLen(text));
  return `${text}${''.padEnd(gap)}`;
}

function trimToWidth(text, width) {
  if (width <= 0) return '';
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  return plain.slice(0, width);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeBar(percent, width = 20) {
  const fill = Math.round(clamp(percent, 0, 1) * width);
  return `${'█'.repeat(fill)}${'░'.repeat(width - fill)}`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  if (s < 3600) {
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return `${mins}m ${rem}s`;
  }
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatHoursMinutes(hoursValue) {
  const hours = Number.parseFloat(hoursValue);
  if (!Number.isFinite(hours) || hours < 0) return '--';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (m === 60) return `${h + 1}h 0m`;
  return `${h}h ${m}m`;
}

function parseVersion(version) {
  const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionInRange(version, min, max) {
  const v = parseVersion(version);
  const a = parseVersion(min);
  const b = parseVersion(max);
  if (!v || !a || !b) return false;
  const asNum = (x) => x[0] * 1_000_000 + x[1] * 1_000 + x[2];
  const n = asNum(v);
  return n >= asNum(a) && n <= asNum(b);
}

function statusColor(status) {
  if (status === 'healthy') return C.green;
  if (status === 'warning') return C.yellow;
  if (status === 'critical') return C.red;
  return C.muted;
}

function thinkingColor(level) {
  if (level === 'deep' || level === 'normal') return C.green;
  if (level === 'shallow') return C.yellow;
  if (level === 'degraded') return C.red;
  return C.muted;
}

function contextColor(health) {
  if (health === 'healthy') return C.green;
  if (health === 'warming') return C.cyan;
  if (health === 'compressing') return C.yellow;
  if (health === 'critical') return C.red;
  return C.muted;
}

function quotaColorFromConsumption(usedPct) {
  if (usedPct >= 65) return C.red;
  if (usedPct >= 35) return C.yellow;
  return C.green;
}

function scoreColor(score) {
  if (score >= 70) return C.green;
  if (score >= 40) return C.yellow;
  return C.red;
}

function burnRateColor(rate) {
  if (rate >= 20) return C.red;
  if (rate >= 10) return C.yellow;
  return C.green;
}

export class TerminalDashboard {
  constructor(monitor) {
    this.monitor = monitor;
    this.screen = null;
    this.widgets = {};
    this.latestMetrics = null;
    this._lastEvents = {
      status: null,
      thinkingLevel: null,
      contextHealth: null,
      budgetMode: false,
      loopAboveThreshold: null,
      loopTriggered: false,
    };
    this.events = [];
    this.clock = this._timeString();
    this.dotBright = true;
    this.blinkInterval = null;
    this.clockInterval = null;
    this.loopFlashInterval = null;
    this.loopFlashOn = false;
    this.overlayOpen = false;
    this.responseOverlayText = '';
    this.responseLineCount = 1;
  }

  init() {
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: 'pulse',
    });

    this._buildLayout();
    this._bindKeys();

    this.monitor.on('update', (metrics) => {
      this._update(metrics);
    });

    this.clockInterval = setInterval(() => {
      this.clock = this._timeString();
      this._update();
    }, 1000);

    this.screen.on('resize', () => this._update());
    this.screen.program.clear();
    this.screen.program.write('\x1b[2J\x1b[0;0H');
    this.screen.program.flush();
    this.screen.clearRegion(0, this.screen.width, 0, this.screen.height);
    this._update();
  }

  _buildLayout() {
    this.widgets.header = blessed.box({
      top: 0,
      left: '0%',
      width: '100%',
      height: 1,
      style: { bg: C.bg },
    });

    this.widgets.status1 = blessed.box({
      top: 1,
      left: '0%',
      width: '25%',
      height: 5,
      style: { bg: C.bg },
    });

    this.widgets.status2 = blessed.box({
      top: 1,
      left: '25%',
      width: '25%',
      height: 5,
      style: { bg: C.bg },
    });

    this.widgets.status3 = blessed.box({
      top: 1,
      left: '50%',
      width: '25%',
      height: 5,
      style: { bg: C.bg },
    });

    this.widgets.status4 = blessed.box({
      top: 1,
      left: '75%',
      width: '25%',
      height: 5,
      style: { bg: C.bg },
    });

    this.widgets.thinking = blessed.box({
      top: 6,
      left: '0%',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { bg: C.surface, border: { fg: C.accent } },
      padding: { left: 1, right: 1 },
    });

    this.widgets.context = blessed.box({
      top: 6,
      left: '50%',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { bg: C.surface, border: { fg: C.accent } },
      padding: { left: 1, right: 1 },
    });

    this.widgets.budget = blessed.box({
      top: 14,
      left: '0%',
      width: '100%',
      height: 5,
      border: { type: 'line' },
      style: { bg: C.budgetTint, border: { fg: C.yellow } },
      padding: { left: 1, right: 1 },
      hidden: true,
    });

    this.widgets.response = blessed.box({
      top: 19,
      left: '0%',
      width: '100%',
      height: 5,
      border: { type: 'line' },
      style: { bg: C.surface, border: { fg: C.accent } },
      padding: { left: 1, right: 1 },
    });

    this.widgets.session = blessed.box({
      top: 24,
      left: '0%',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { bg: C.surface, border: { fg: C.accent } },
      padding: { left: 1, right: 1 },
    });

    this.widgets.events = blessed.box({
      top: 24,
      left: '50%',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { bg: C.surface, border: { fg: C.accent } },
      padding: { left: 1, right: 1 },
      scrollable: true,
      alwaysScroll: true,
    });

    this.widgets.footer = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { bg: '#2d1b69', fg: '#cbd5e1' },
    });

    this.widgets.actionsOverlay = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      style: { bg: '#020617', fg: '#e2e8f0' },
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
      scrollable: true,
      alwaysScroll: true,
      hidden: true,
      tags: false,
    });

    Object.values(this.widgets).forEach((widget) => {
      this.screen.append(widget);
    });
  }

  _syncDotBlink(status) {
    const period = STATUS_PERIODS[status];
    if (!period) {
      if (this.blinkInterval) {
        clearInterval(this.blinkInterval);
        this.blinkInterval = null;
      }
      this.dotBright = true;
      return;
    }

    if (this.blinkInterval && this._blinkPeriod === period) {
      return;
    }

    if (this.blinkInterval) {
      clearInterval(this.blinkInterval);
      this.blinkInterval = null;
    }

    this._blinkPeriod = period;
    this.blinkInterval = setInterval(() => {
      this.dotBright = !this.dotBright;
      this._render();
    }, period);
  }

  _captureEvents(metrics) {
    if (this._lastEvents.status !== null && this._lastEvents.status !== metrics.status) {
      this._pushEvent(
        statusColor(metrics.status),
        `status ${this._lastEvents.status} -> ${metrics.status}`,
      );
    }
    this._lastEvents.status = metrics.status;

    if (this._lastEvents.thinkingLevel !== null && this._lastEvents.thinkingLevel !== metrics.thinking.level) {
      this._pushEvent(
        thinkingColor(metrics.thinking.level),
        `thinking ${this._lastEvents.thinkingLevel} -> ${metrics.thinking.level}`,
      );
    }
    this._lastEvents.thinkingLevel = metrics.thinking.level;

    const loopAboveThreshold = metrics.session.loops >= 3;
    if (loopAboveThreshold && !this._lastEvents.loopTriggered) {
      this._pushEvent(C.red, `⚠ loop detected — ${metrics.session.loops} failures`);
      this._lastEvents.loopTriggered = true;
    }
    if (!loopAboveThreshold) {
      this._lastEvents.loopTriggered = false;
    }
    this._lastEvents.loopAboveThreshold = loopAboveThreshold;

    if (this._lastEvents.contextHealth !== null && this._lastEvents.contextHealth !== metrics.context.health) {
      this._pushEvent(
        contextColor(metrics.context.health),
        `context ${this._lastEvents.contextHealth} -> ${metrics.context.health}`,
      );
    }
    this._lastEvents.contextHealth = metrics.context.health;

    const budgetMode = Boolean(metrics.budgetMode);
    if (this._lastEvents.budgetMode !== null && this._lastEvents.budgetMode !== budgetMode) {
      if (budgetMode) {
        this._pushEvent(C.yellow, `budget mode enabled at ${metrics.quota.remaining}% remaining`);
      } else {
        this._pushEvent(C.muted, 'budget mode disabled');
      }
    }
    this._lastEvents.budgetMode = budgetMode;
  }

  _pushEvent(color, message) {
    const stamp = this._timeString();
    this.events.push({ color, message, stamp });
    if (this.events.length > 250) {
      this.events.shift();
    }
  }

  _timeString() {
    return new Date().toLocaleTimeString([], { hour12: false });
  }

  _layoutRows(showBudget, responseHeight) {
    const headerH = 1;
    const statusH = 5;
    const row1H = 8;
    const budgetH = showBudget ? 5 : 0;
    const responseH = Math.max(3, responseHeight || 3);
    const footerH = 1;

    this.widgets.header.top = 0;
    this.widgets.header.height = headerH;

    this.widgets.status1.top = headerH;
    this.widgets.status2.top = headerH;
    this.widgets.status3.top = headerH;
    this.widgets.status4.top = headerH;
    this.widgets.status1.height = statusH;
    this.widgets.status2.height = statusH;
    this.widgets.status3.height = statusH;
    this.widgets.status4.height = statusH;

    this.widgets.thinking.top = headerH + statusH;
    this.widgets.context.top = headerH + statusH;
    this.widgets.thinking.height = row1H;
    this.widgets.context.height = row1H;

    this.widgets.budget.top = headerH + statusH + row1H;
    this.widgets.budget.height = 5;

    if (showBudget) this.widgets.budget.show();
    else this.widgets.budget.hide();

    this.widgets.response.top = headerH + statusH + row1H + budgetH;
    this.widgets.response.height = responseH;

    const row2Top = headerH + statusH + row1H + budgetH + responseH;
    const row2Height = Math.max(9, this.screen.height - row2Top - footerH);

    this.widgets.session.top = row2Top;
    this.widgets.events.top = row2Top;
    this.widgets.session.height = row2Height;
    this.widgets.events.height = row2Height;
  }

  _update(metrics) {
    if (metrics) {
      this.latestMetrics = metrics;
      this._captureEvents(metrics);
      this._syncDotBlink(metrics.status);
    }
    this._render();
  }

  _render() {
    const m = this.latestMetrics || this.monitor.metrics;
    if (!this.screen || !m) return;

    const responseEntries = this._buildResponseEntries(m);
    const responseHeight = Math.min(14, Math.max(4, responseEntries.length + 3));
    this.responseLineCount = responseEntries.length;

    this._layoutRows(Boolean(m.budgetMode), responseHeight);
    this._renderHeader(m);
    this._renderStatusRow(m);
    this._renderThinkingPanel(m);
    this._renderContextPanel(m);
    this._renderBudgetBanner(m);
    this._renderResponsePanel(responseEntries);
    this._renderSessionPanel(m);
    this._renderEventsPanel();
    this._renderFooter();

    this.screen.render();
  }

  _renderHeader(metrics) {
    const status = metrics.status || 'idle';
    const color = statusColor(status);
    const icon = STATUS_ICONS[status] || STATUS_ICONS.idle;
    const dot = this.dotBright ? chalk.hex(color)(icon) : chalk.hex(C.dim)(icon);

    const logo = chalk.hex(C.accent).bold('pulse▸');
    const badge = chalk.hex(color).bold(`${dot} ${status.toUpperCase()}`);
    const version = chalk.hex(C.muted)('claude-code');
    const sim = metrics._simulated ? chalk.hex(C.muted)('[SIMULATED]') : '';
    const time = chalk.hex(C.dim)(this.clock);

    const left = [logo, badge, version, sim].filter(Boolean).join('  ');
    const width = Math.max(0, this.screen.width);
    const gap = Math.max(1, width - ansiLen(left) - ansiLen(time));
    this.widgets.header.setContent(`${left}${''.padEnd(gap)}${time}`);
  }

  _renderStatusRow(metrics) {
    const thinkingValue = metrics.thinking.level.toUpperCase();
    const thinkingValueColor = thinkingColor(metrics.thinking.level);
    const thinkingBarColor = scoreColor(metrics.thinking.score);

    const contextPct = Math.round(metrics.context.percent * 100);
    const contextValueColor = contextColor(metrics.context.health);
    const contextBarColor = quotaColorFromConsumption(contextPct);

    const quotaUsedPct = clamp(metrics.quota.used, 0, 100);
    const quotaColor = quotaColorFromConsumption(quotaUsedPct);

    const burnColor = burnRateColor(metrics.quota.burnRate);
    const burnPct = clamp(metrics.quota.burnRate / 30, 0, 1);

    const w1 = Math.max(10, Number(this.widgets.status1.width) || 20);
    const w2 = Math.max(10, Number(this.widgets.status2.width) || 20);
    const w3 = Math.max(10, Number(this.widgets.status3.width) || 20);
    const w4 = Math.max(10, Number(this.widgets.status4.width) || 20);

    const barW1 = Math.min(20, Math.max(10, w1));
    const barW2 = Math.min(20, Math.max(10, w2));
    const barW3 = Math.min(20, Math.max(10, w3));
    const barW4 = Math.min(20, Math.max(10, w4));

    this.widgets.status1.setContent([
      trimToWidth(chalk.hex(C.muted).bold('THINKING'), w1),
      trimToWidth(chalk.hex(thinkingValueColor).bold(thinkingValue), w1),
      trimToWidth(chalk.hex(thinkingBarColor)(makeBar(metrics.thinking.score / 100, barW1)), w1),
      trimToWidth(chalk.hex(C.dim)(`score ${metrics.thinking.score}/100`), w1),
    ].join('\n'));

    this.widgets.status2.setContent([
      trimToWidth(chalk.hex(C.muted).bold('CONTEXT'), w2),
      trimToWidth(chalk.hex(contextValueColor).bold(`${contextPct}%`), w2),
      trimToWidth(chalk.hex(contextBarColor)(makeBar(metrics.context.percent, barW2)), w2),
      trimToWidth(chalk.hex(C.dim)(`${metrics.context.used}/${metrics.context.total} tokens`), w2),
    ].join('\n'));

    this.widgets.status3.setContent([
      trimToWidth(chalk.hex(C.muted).bold('QUOTA'), w3),
      trimToWidth(chalk.hex(quotaColor).bold(`${metrics.quota.remaining}%`), w3),
      trimToWidth(chalk.hex(quotaColor)(makeBar(quotaUsedPct / 100, barW3)), w3),
      trimToWidth(chalk.hex(C.dim)(`used ${quotaUsedPct}%`), w3),
    ].join('\n'));

    this.widgets.status4.setContent([
      trimToWidth(chalk.hex(C.muted).bold('BURN RATE'), w4),
      trimToWidth(chalk.hex(burnColor).bold(`${metrics.quota.burnRate}%/h`), w4),
      trimToWidth(chalk.hex(burnColor)(makeBar(burnPct, barW4)), w4),
      trimToWidth(chalk.hex(C.dim)(`${metrics.quota.estimatedHoursLeft || '--'}h left`), w4),
    ].join('\n'));
  }

  _renderThinkingPanel(metrics) {
    const t = metrics.thinking;
    const s = metrics.session || {};
    const levelColor = thinkingColor(t.level);
    const scoreCol = scoreColor(t.score);

    this.widgets.thinking.style.border.fg = t.level === 'degraded' ? C.red : C.accent;

    const trendArrow = t.trend === 'declining' ? '↓' : t.trend === 'improving' ? '↑' : '→';
    const trendColor = t.trend === 'declining' ? C.red : t.trend === 'improving' ? C.green : C.muted;

    const lines = [
      chalk.hex(C.accent).bold('THINKING DEPTH'),
      `${chalk.hex(C.muted)('depth:')} ${chalk.hex(levelColor).bold(`${t.depth} chars`)}`,
      `${chalk.hex(C.muted)('level:')} ${chalk.hex(levelColor).bold(t.level.toUpperCase())}`,
      `${chalk.hex(C.muted)('score:')} ${chalk.hex(scoreCol)(makeBar(t.score / 100, 20))} ${t.score}`,
      `${chalk.hex(C.muted)('trend:')} ${chalk.hex(trendColor)(`${trendArrow} ${t.trend}`)}`,
    ];

    if (Number(s.editWithoutRead) > 0) {
      lines.push(chalk.hex(C.red)(`⚠ edit-without-read: ${s.editWithoutRead}`));
    }

    if (t.redacted) {
      lines.push(chalk.hex(C.yellow)('⚠ thinking redacted by Anthropic'));
    }

    this.widgets.thinking.setContent(lines.join('\n'));
  }

  _renderContextPanel(metrics) {
    const c = metrics.context;
    const pct = Math.round(c.percent * 100);
    const healthColor = contextColor(c.health);
    const barColor = c.health === 'critical'
      ? C.red
      : c.health === 'compressing'
        ? C.yellow
        : quotaColorFromConsumption(pct);
    const barWidth = Math.max(20, this.widgets.context.width - 8);

    this.widgets.context.style.border.fg = c.health === 'critical'
      ? C.red
      : c.health === 'compressing'
        ? C.yellow
        : C.accent;

    let healthMessage = '';
    if (c.health === 'warming') {
      healthMessage = chalk.hex(C.cyan)('◌ context warming up');
    } else if (c.health === 'compressing') {
      healthMessage = chalk.hex(C.yellow)('◌ context compressing — watch for drift');
    } else if (c.health === 'critical') {
      healthMessage = chalk.hex(C.red)('⚠ context critical — end session now');
    }

    const lines = [
      chalk.hex(C.accent).bold('CONTEXT WINDOW'),
      chalk.hex(healthColor).bold(`${pct}% used`),
      `${chalk.hex(C.muted)('tokens:')} ${chalk.hex(C.dim)(`${c.used} / ${c.total}`)}`,
      chalk.hex(barColor)(makeBar(c.percent, barWidth)),
      healthMessage,
      c.health === 'critical' ? chalk.hex(C.red)('quality degradation is happening now — this is not a warning') : '',
    ].filter(Boolean);

    this.widgets.context.setContent(lines.join('\n'));
  }

  _renderBudgetBanner(metrics) {
    if (!metrics.budgetMode) {
      this.widgets.budget.setContent('');
      return;
    }

    const first = chalk.hex(C.yellow).bold(`⚡ BUDGET MODE ACTIVE — quota at ${metrics.quota.remaining}%`);
    const second = chalk.hex(C.dim)('run: ') + chalk.hex(C.yellow)('/model claude-sonnet-4-6') +
      chalk.hex(C.dim)('  ·  ') + chalk.hex(C.yellow)('/effort low') +
      chalk.hex(C.dim)('  ·  ') + chalk.hex(C.yellow)('/compact on');

    const hours = Number.parseFloat(metrics.quota.estimatedHoursLeft);
    const timeColor = Number.isFinite(hours)
      ? (hours < 0.5 ? C.red : hours <= 1.5 ? C.yellow : C.green)
      : C.muted;
    const third = chalk.hex(C.dim)('time remaining: ') + chalk.hex(timeColor)(formatHoursMinutes(metrics.quota.estimatedHoursLeft));
    const panelWidth = Math.max(10, Number(this.widgets.budget.width) || this.screen.width || 80);

    this.widgets.budget.setContent([
      padAnsiRight(trimToWidth(first, panelWidth), panelWidth),
      padAnsiRight(trimToWidth(second, panelWidth), panelWidth),
      padAnsiRight(trimToWidth(third, panelWidth), panelWidth),
    ].join('\n'));
  }

  _buildResponseEntries(metrics) {
    const entries = [];
    const pushLines = (severity, lines) => entries.push({ severity, lines });

    if (metrics.session.loops >= 3) {
      pushLines(1, [
        chalk.hex(C.red).bold('⚠ LOOP DETECTED — INTERRUPT IMMEDIATELY'),
        chalk.hex('#e2e8f0')('action: press Ctrl+C in your Claude Code terminal right now'),
        chalk.hex('#e2e8f0')('then when you restart tell Claude exactly what failed and why'),
      ]);
    }

    if (metrics.context.health === 'critical') {
      pushLines(2, [
        chalk.hex(C.red).bold('⚠ CONTEXT CRITICAL'),
        chalk.hex('#e2e8f0')('action: end this session now — continued work will silently degrade'),
        chalk.hex('#e2e8f0')('then if clauditor installed: run clauditor rotate to preserve context for next session'),
      ]);
    } else if (metrics.context.health === 'compressing') {
      pushLines(3, [
        chalk.hex(C.yellow).bold('◌ CONTEXT COMPRESSING'),
        chalk.hex('#e2e8f0')('action: run /compact to summarize — session is still salvageable'),
      ]);
    }

    if (metrics.thinking.level === 'degraded') {
      pushLines(4, [
        chalk.hex(C.red).bold('⚠ THINKING DEGRADED'),
        chalk.hex('#e2e8f0')('action: type /effort high in Claude Code to restore reasoning depth'),
        chalk.hex(C.yellow)('risk: Claude edited files without reading them first — review recent changes carefully'),
      ]);
    }

    if (metrics.budgetMode) {
      pushLines(5, [
        chalk.hex(C.yellow).bold('⚡ QUOTA LOW — budget mode active'),
        chalk.hex('#e2e8f0')(`estimated time remaining: ${formatHoursMinutes(metrics.quota.estimatedHoursLeft)} at current burn rate`),
        chalk.hex('#e2e8f0')('action: finish your current task only — do not start anything new'),
      ]);
    }

    entries.sort((a, b) => a.severity - b.severity);
    const flatLines = entries.flatMap((e) => e.lines);
    this.responseOverlayText = flatLines.length > 0
      ? flatLines.join('\n\n')
      : '◌ all systems nominal — no action required';

    return flatLines.length > 0
      ? flatLines
      : [chalk.hex(C.dim)('◌ all systems nominal — no action required')];
  }

  _renderResponsePanel(lines) {
    const panelWidth = Math.max(10, Number(this.widgets.response.width) || this.screen.width || 80);
    const nominalOnly = lines.length === 1 && stripAnsi(lines[0]) === '◌ all systems nominal — no action required';
    this.widgets.response.style.border.fg = nominalOnly ? C.muted : C.accent;
    this.widgets.response.setContent(
      lines.map((line) => padAnsiRight(trimToWidth(line, panelWidth), panelWidth)).join('\n'),
    );
  }

  _renderSessionPanel(metrics) {
    const s = metrics.session;
    const ratioRaw = String(s.readEditRatio);
    const ratio = Number.parseFloat(ratioRaw);
    const ratioFinite = Number.isFinite(ratio);
    const ratioColor = !ratioFinite || ratio > 5 ? C.green : ratio >= 2 ? C.yellow : C.red;
    const loopColor = s.loops >= 3 ? C.red : C.muted;
    const ratioWarn = !ratioFinite || ratio >= 2 ? '' : ` ${chalk.hex(C.red)('⚠ edit-first')}`;
    const ratioOk = (!ratioFinite || ratio > 5) ? ` ${chalk.hex(C.green)('✓')}` : '';
    const loopWarn = s.loops >= 3 ? ` ${chalk.hex(C.red).bold('⚠ STUCK')}` : '';

    const lines = [
      `${chalk.hex(C.muted)('duration:')} ${chalk.hex(C.green)(formatDuration(s.duration))}`,
      `${chalk.hex(C.muted)('prompts:')} ${chalk.hex(C.green).bold(String(s.prompts))}`,
      `${chalk.hex(C.muted)('tool calls:')} ${chalk.hex(C.green).bold(String(s.toolCalls))}`,
      `${chalk.hex(C.muted)('read:edit:')} ${chalk.hex(ratioColor).bold(String(s.readEditRatio))}${ratioOk}${ratioWarn}`,
      `${chalk.hex(C.muted)('loops:')} ${chalk.hex(loopColor).bold(String(s.loops))}${loopWarn}`,
      `${chalk.hex(C.muted)('last tool:')} ${chalk.hex(C.dim)(s.lastTool || 'none')}`,
    ];

    this._syncLoopFlash(s.loops);
    const panelWidth = Math.max(10, Number(this.widgets.session.width) || Math.floor(this.screen.width / 2) || 40);
    this.widgets.session.setContent(lines.map((line) => padAnsiRight(trimToWidth(line, panelWidth), panelWidth)).join('\n'));
  }

  _syncLoopFlash(loops) {
    if (loops >= 3) {
      if (this.loopFlashInterval) return;
      this.loopFlashInterval = setInterval(() => {
        this.loopFlashOn = !this.loopFlashOn;
        this.widgets.session.style.border.fg = this.loopFlashOn ? C.red : C.accent;
        this.screen.render();
      }, 300);
      return;
    }

    if (this.loopFlashInterval) {
      clearInterval(this.loopFlashInterval);
      this.loopFlashInterval = null;
    }
    this.loopFlashOn = false;
    this.widgets.session.style.border.fg = C.accent;
  }

  _renderEventsPanel() {
    const panelWidth = Math.max(20, this.widgets.events.width - 4);
    const available = Math.max(1, this.widgets.events.height - 2);
    const tail = this.events.slice(-available);

    const lines = [];
    tail.forEach((entry) => {
      const dot = chalk.hex(entry.color)('●');
      const stamp = String(entry.stamp || '').slice(-8);
      const messageWidth = Math.max(1, panelWidth - 12);
      const msg = stripAnsi(entry.message).slice(0, messageWidth);
      const line = padAnsiRight(`${dot} ${msg}  ${chalk.hex(C.dim)(stamp)}`, panelWidth);
      lines.push(line);
    });

    this.widgets.events.setContent(lines.join('\n'));
    this.widgets.events.setScrollPerc(100);
  }

  _renderFooter() {
    const left = '[q] quit  [b] budget mode  [r] reset  [a] actions';
    const right = 'pulse';
    const width = Math.max(0, this.screen.width);
    const middle = Math.max(1, width - left.length - right.length);
    this.widgets.footer.setContent(`${left}${' '.padEnd(middle)}${right}`);
  }

  _bindKeys() {
    this.screen.key(['q', 'C-c'], () => {
      if (this.clockInterval) clearInterval(this.clockInterval);
      if (this.blinkInterval) clearInterval(this.blinkInterval);
      if (this.loopFlashInterval) clearInterval(this.loopFlashInterval);
      this.monitor.stop();
      this.screen.destroy();
      process.stdout.write('\x1b[0m\x1b[?25h\x1b[2J\x1b[0;0H');
      process.exit(0);
    });

    this.screen.key(['b'], () => {
      const next = !this.monitor.budgetMode;
      this.monitor.budgetMode = next;
      if (this.monitor.metrics) {
        this.monitor.metrics.budgetMode = next;
      }
      if (this.latestMetrics) {
        this.latestMetrics.budgetMode = next;
      }
      if (next) {
        const remaining = this.latestMetrics?.quota?.remaining ?? this.monitor.metrics?.quota?.remaining ?? 0;
        this._pushEvent(C.yellow, `budget mode enabled at ${remaining}% remaining`);
      } else {
        this._pushEvent(C.muted, 'budget mode disabled');
      }
      this._lastEvents.budgetMode = next;
      this._render();
    });

    this.screen.key(['r'], () => {
      this.events = [];
      this._render();
    });

    this.screen.key(['a'], () => {
      if (this.overlayOpen) return;
      this.overlayOpen = true;
      this.widgets.actionsOverlay.setContent(
        `${chalk.hex(C.accent).bold('RESPONSE ACTIONS')}\n\n${this.responseOverlayText}\n\n${chalk.hex(C.dim)('Press any key to close.')}`,
      );
      this.widgets.actionsOverlay.show();
      this.screen.render();

      const dismiss = () => {
        if (!this.overlayOpen) return;
        this.overlayOpen = false;
        this.widgets.actionsOverlay.hide();
        this._render();
      };

      setTimeout(() => {
        this.screen.once('keypress', dismiss);
      }, 0);
    });
  }
}
