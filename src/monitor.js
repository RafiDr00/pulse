import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';

const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSIONS_GLOB = process.platform === 'win32'
  ? path.join(CLAUDE_SESSIONS_DIR, '**', '*.jsonl').replace(/\\/g, '/')
  : `${CLAUDE_SESSIONS_DIR}/**/*.jsonl`;
const CLAUDE_STATS_FILE = path.join(os.homedir(), '.claude', 'statsig.json');

// Thresholds based on real data from AMD director's analysis
const THRESHOLDS = {
  THINKING_DEEP: 1800,       // chars — healthy (baseline was ~2200)
  THINKING_SHALLOW: 800,     // chars — degraded (regression was ~600)
  CONTEXT_WARN: 0.35,        // 35% — start watching
  CONTEXT_DANGER: 0.65,      // 65% — compress soon (real degradation starts ~40%)
  CONTEXT_CRITICAL: 0.85,    // 85% — emergency
  QUOTA_BUDGET_TRIGGER: 0.25,// 25% remaining → auto budget mode
  QUOTA_WARN: 0.40,          // 40% remaining → warning
  LOOP_THRESHOLD: 3,         // consecutive same-tool failures = loop
  BURN_SAMPLE_WINDOW: 300,   // 5 minutes for burn rate calc
};

export class PulseMonitor extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.activeSession = null;
    this.metrics = this._freshMetrics();
    this.history = [];
    this.watcher = null;
    this.budgetMode = false;
    this._tokenHistory = []; // [{time, tokens}] for burn rate
    this._watchBootstrapTimer = null;
  }

  _freshMetrics() {
    return {
      status: 'idle',           // idle | healthy | warning | danger | critical
      thinking: {
        depth: 0,               // estimated chars
        level: 'unknown',       // deep | normal | shallow | degraded
        score: 100,             // 0-100
        trend: 'stable',        // improving | stable | declining
        redacted: false,
        history: [],
      },
      context: {
        used: 0,                // tokens used
        total: 200000,          // default 200k, updated if 1M detected
        percent: 0,
        health: 'healthy',      // healthy | warming | compressing | critical
        compressions: 0,
      },
      quota: {
        used: 0,
        total: 100,             // percentage based
        remaining: 100,
        burnRate: 0,            // % per hour
        estimatedHoursLeft: null,
        sessionStart: Date.now(),
      },
      session: {
        duration: 0,            // seconds
        toolCalls: 0,
        editWithoutRead: 0,
        readEditRatio: 0,
        loops: 0,
        consecutiveFailures: 0,
        lastTool: null,
        prompts: 0,
      },
      budgetMode: false,
      version: null,
      lastUpdated: Date.now(),
    };
  }

  start() {
    this._watchSessions();
    this._pollStats();
    this.emit('started');
  }

  stop() {
    if (this._watchBootstrapTimer) {
      clearTimeout(this._watchBootstrapTimer);
      this._watchBootstrapTimer = null;
    }
    if (this._simInterval) {
      clearInterval(this._simInterval);
      this._simInterval = null;
    }
    if (this.watcher) this.watcher.close();
    this.emit('stopped');
  }

  _watchSessions() {
    // Watch for new/modified JSONL session files
    if (!fs.existsSync(CLAUDE_SESSIONS_DIR)) {
      this._startSimulation();
      return;
    }

    if (!this._hasSessionJsonl(CLAUDE_SESSIONS_DIR)) {
      this._startSimulation();
      return;
    }

    // Prime metrics from existing session files so we don't fall back to
    // simulation while real data is already present on disk.
    this._processMostRecentSessionFile();

    try {
      this.watcher = chokidar.watch(SESSIONS_GLOB, {
        persistent: true,
        ignoreInitial: false,
        usePolling: true,
        interval: 1000,
      });

      this._watchBootstrapTimer = setTimeout(() => {
        if (!this.activeSession) {
          // Only simulate if no real session files currently exist.
          if (!this._hasSessionJsonl(CLAUDE_SESSIONS_DIR)) {
            if (this.watcher) this.watcher.close();
            this.watcher = null;
            this._startSimulation();
          }
        }
      }, 1500);

      this.watcher.on('change', (filePath) => {
        if (this._watchBootstrapTimer) {
          clearTimeout(this._watchBootstrapTimer);
          this._watchBootstrapTimer = null;
        }
        this._processMostRecentSessionFile(filePath);
      });

      this.watcher.on('add', (filePath) => {
        if (this._watchBootstrapTimer) {
          clearTimeout(this._watchBootstrapTimer);
          this._watchBootstrapTimer = null;
        }
        this._processMostRecentSessionFile(filePath);
      });

      this.watcher.on('error', () => {
        if (this.watcher) this.watcher.close();
        this.watcher = null;
        this._startSimulation();
      });
    } catch {
      this._startSimulation();
    }
  }

  _hasSessionJsonl(dirPath) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          return true;
        }
        if (entry.isDirectory() && this._hasSessionJsonl(fullPath)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  _listSessionJsonl(dirPath) {
    const files = [];
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
        if (entry.isDirectory()) {
          files.push(...this._listSessionJsonl(fullPath));
        }
      }
    } catch {
      return files;
    }

    // Sort newest to oldest so active sessions are processed first.
    return files.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
  }

  _processMostRecentSessionFile(preferredFilePath = null) {
    const candidates = this._listSessionJsonl(CLAUDE_SESSIONS_DIR);
    if (preferredFilePath && fs.existsSync(preferredFilePath)) {
      candidates.unshift(preferredFilePath);
    }

    const unique = [...new Set(candidates)];
    if (unique.length === 0) return;

    const newest = unique.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    })[0];

    this._processSessionFile(newest);
  }

  _processSessionFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return;

      const entries = lines.map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      this._analyzeSession(entries, filePath);
    } catch (e) {
      // File still being written
    }
  }

  _analyzeSession(entries, filePath) {
    const metrics = this._freshMetrics();
    metrics.status = 'healthy';
    metrics.version = this._extractVersionFromEntries(entries) || this.metrics.version || null;

    // --- Thinking depth analysis ---
    const thinkingBlocks = entries.filter(e =>
      e.type === 'thinking' || e.thinking_content || e.signature
    );

    const visibleThinking = thinkingBlocks.filter(e => e.thinking_content);
    const redactedThinking = thinkingBlocks.filter(e => e.signature && !e.thinking_content);

    metrics.thinking.redacted = redactedThinking.length > visibleThinking.length;

    if (visibleThinking.length > 0) {
      const avgLen = visibleThinking.reduce((s, e) =>
        s + (e.thinking_content?.length || 0), 0) / visibleThinking.length;
      metrics.thinking.depth = Math.round(avgLen);
    } else if (redactedThinking.length > 0) {
      // Estimate from signature correlation (0.971 Pearson per AMD analysis)
      metrics.thinking.depth = 600; // degraded estimate
    }

    // Score thinking 0-100
    if (metrics.thinking.depth >= THRESHOLDS.THINKING_DEEP) {
      metrics.thinking.level = 'deep';
      metrics.thinking.score = 95;
    } else if (metrics.thinking.depth >= THRESHOLDS.THINKING_SHALLOW) {
      metrics.thinking.level = 'normal';
      metrics.thinking.score = 65;
    } else if (metrics.thinking.depth > 0) {
      metrics.thinking.level = 'degraded';
      metrics.thinking.score = 25;
    } else {
      metrics.thinking.level = 'unknown';
      metrics.thinking.score = 50;
    }

    // --- Tool call analysis (Read:Edit ratio) ---
    const toolCalls = entries.filter(e => e.type === 'tool_use' || e.tool_name);
    metrics.session.toolCalls = toolCalls.length;

    const reads = toolCalls.filter(e =>
      ['read_file', 'view', 'Read'].includes(e.name || e.tool_name)
    ).length;
    const edits = toolCalls.filter(e =>
      ['write_file', 'edit_file', 'str_replace_based_edit_tool', 'Write', 'Edit'].includes(e.name || e.tool_name)
    ).length;

    metrics.session.readEditRatio = edits > 0 ? (reads / edits).toFixed(1) : '∞';

    // Flag if edit-without-read pattern detected (< 2.0 ratio = degraded per AMD data)
    if (edits > 5 && reads / edits < 2.0) {
      metrics.session.editWithoutRead = edits - reads;
    }

    // --- Loop detection ---
    let consecutive = 0;
    let maxConsecutive = 0;
    let lastTool = null;
    let lastResult = null;

    for (const entry of toolCalls) {
      const tool = entry.name || entry.tool_name;
      const isError = entry.is_error || entry.error;

      if (tool === lastTool && isError && lastResult === 'error') {
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else {
        consecutive = 0;
      }
      lastTool = tool;
      lastResult = isError ? 'error' : 'ok';
    }

    metrics.session.loops = maxConsecutive;
    metrics.session.consecutiveFailures = consecutive;
    metrics.session.lastTool = lastTool;

    // --- Context estimation ---
    const assistantMessages = entries.filter(e =>
      e.role === 'assistant' || e.type === 'assistant'
    );
    const userMessages = entries.filter(e =>
      e.role === 'user' || e.type === 'user'
    );

    // Rough token estimation (4 chars ≈ 1 token)
    const totalChars = entries.reduce((s, e) => {
      const content = JSON.stringify(e);
      return s + content.length;
    }, 0);

    const estimatedTokens = Math.round(totalChars / 4);
    metrics.context.used = estimatedTokens;
    metrics.session.prompts = userMessages.length;

    // Determine context window size
    const hasMillionContext = entries.some(e =>
      e.model?.includes('opus') || e.context_window === 1000000
    );
    metrics.context.total = hasMillionContext ? 1000000 : 200000;
    metrics.context.percent = metrics.context.used / metrics.context.total;

    // Context health (per AMD data: degradation starts at 20-40%)
    if (metrics.context.percent < 0.20) {
      metrics.context.health = 'healthy';
    } else if (metrics.context.percent < 0.40) {
      metrics.context.health = 'warming';
    } else if (metrics.context.percent < 0.65) {
      metrics.context.health = 'compressing';
    } else {
      metrics.context.health = 'critical';
    }

    // --- Overall status ---
    const issues = [];
    if (metrics.thinking.level === 'degraded') issues.push('thinking');
    if (metrics.context.health === 'critical') issues.push('context');
    if (maxConsecutive >= THRESHOLDS.LOOP_THRESHOLD) issues.push('loop');

    if (issues.length === 0) metrics.status = 'healthy';
    else if (issues.includes('loop') || issues.length >= 2) metrics.status = 'critical';
    else metrics.status = 'warning';

    metrics.lastUpdated = Date.now();
    this.metrics = { ...this.metrics, ...metrics };
    this.activeSession = filePath;

    this._checkBudgetMode();
    this.emit('update', this.metrics);
  }

  _extractVersionFromEntries(entries) {
    const keys = [
      'version',
      'claude_code_version',
      'claudeCodeVersion',
      'client_version',
      'app_version',
    ];

    const extractSemver = (value) => {
      if (typeof value !== 'string' && typeof value !== 'number') return null;
      const text = String(value);
      const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
      return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
    };

    const scan = (node) => {
      if (!node || typeof node !== 'object') return null;

      for (const key of keys) {
        const value = node[key];
        const parsed = extractSemver(value);
        if (parsed) return parsed;
      }

      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            const parsed = scan(item) || extractSemver(item);
            if (parsed) return parsed;
          }
        } else if (value && typeof value === 'object') {
          const parsed = scan(value);
          if (parsed) return parsed;
        } else {
          const parsed = extractSemver(value);
          if (parsed) return parsed;
        }
      }

      return null;
    };

    for (const entry of entries) {
      const parsed = scan(entry);
      if (parsed) return parsed;
    }

    return null;
  }

  _pollStats() {
    // Poll Claude stats file for quota data
    setInterval(() => {
      this._readQuotaStats();
    }, 5000);
    this._readQuotaStats();
  }

  _readQuotaStats() {
    try {
      if (fs.existsSync(CLAUDE_STATS_FILE)) {
        const data = JSON.parse(fs.readFileSync(CLAUDE_STATS_FILE, 'utf8'));
        // Extract quota info if available
        if (data.quota !== undefined) {
          this.metrics.quota.remaining = data.quota;
          this.metrics.quota.used = 100 - data.quota;
        }
      }
    } catch {}

    this._updateBurnRate();
    this.emit('update', this.metrics);
  }

  _updateBurnRate() {
    const now = Date.now();
    this._tokenHistory.push({ time: now, used: this.metrics.quota.used });

    // Keep last 5 min
    this._tokenHistory = this._tokenHistory.filter(
      e => now - e.time < THRESHOLDS.BURN_SAMPLE_WINDOW * 1000
    );

    if (this._tokenHistory.length >= 2) {
      const oldest = this._tokenHistory[0];
      const newest = this._tokenHistory[this._tokenHistory.length - 1];
      const deltaUsed = newest.used - oldest.used;
      const deltaTime = (newest.time - oldest.time) / 3600000; // hours
      this.metrics.quota.burnRate = deltaTime > 0
        ? Math.round(deltaUsed / deltaTime)
        : 0;

      if (this.metrics.quota.burnRate > 0) {
        this.metrics.quota.estimatedHoursLeft =
          (this.metrics.quota.remaining / this.metrics.quota.burnRate).toFixed(1);
      }
    }
  }

  _checkBudgetMode() {
    const remainingPct = this.metrics.quota.remaining / 100;
    if (!this.budgetMode && remainingPct <= THRESHOLDS.QUOTA_BUDGET_TRIGGER) {
      this.budgetMode = true;
      this.metrics.budgetMode = true;
      this.emit('budgetMode', {
        triggered: true,
        remaining: this.metrics.quota.remaining,
        recommendations: this._getBudgetRecommendations(),
      });
    } else if (this.budgetMode && remainingPct > THRESHOLDS.QUOTA_BUDGET_TRIGGER + 0.05) {
      this.budgetMode = false;
      this.metrics.budgetMode = false;
    }
  }

  _getBudgetRecommendations() {
    return [
      'Switch to Sonnet: /model claude-sonnet-4-6',
      'Set effort low: /effort low',
      'Compress context: /compact',
      'Clear history: /clear',
    ];
  }

  // Simulation mode for dev/demo when no Claude sessions exist
  _startSimulation() {
    if (this._simInterval) {
      return;
    }

    if (this._watchBootstrapTimer) {
      clearTimeout(this._watchBootstrapTimer);
      this._watchBootstrapTimer = null;
    }

    this.emit('simulating');
    let tick = 0;

    const simulate = () => {
      tick++;
      const t = tick / 10;

      // Simulate a realistic session lifecycle
      const contextPct = Math.min(0.85, 0.02 + tick * 0.003 + Math.sin(t) * 0.02);
      const quotaRemaining = Math.max(5, 100 - tick * 0.8 - Math.random() * 2);

      // Thinking depth varies — simulate the "degradation" scenario
      let thinkingDepth, thinkingLevel, thinkingScore;
      if (tick < 30) {
        thinkingDepth = 2000 + Math.random() * 400;
        thinkingLevel = 'deep';
        thinkingScore = 92 + Math.random() * 6;
      } else if (tick < 60) {
        thinkingDepth = 1200 + Math.random() * 300;
        thinkingLevel = 'normal';
        thinkingScore = 60 + Math.random() * 15;
      } else {
        thinkingDepth = 500 + Math.random() * 200;
        thinkingLevel = tick > 80 ? 'degraded' : 'shallow';
        thinkingScore = 20 + Math.random() * 20;
      }

      const readEditRatio = Math.max(1.2, 6.6 - tick * 0.06 + Math.random());
      const loops = tick > 70 ? Math.floor(Math.random() * 4) : 0;

      let contextHealth = 'healthy';
      if (contextPct > 0.65) contextHealth = 'critical';
      else if (contextPct > 0.40) contextHealth = 'compressing';
      else if (contextPct > 0.20) contextHealth = 'warming';

      const burnRate = 8 + Math.random() * 4;
      const hoursLeft = (quotaRemaining / burnRate).toFixed(1);

      let status = 'healthy';
      if (thinkingLevel === 'degraded' || loops >= 3 || contextHealth === 'critical') {
        status = tick > 80 ? 'critical' : 'warning';
      }

      this.metrics = {
        status,
        thinking: {
          depth: Math.round(thinkingDepth),
          level: thinkingLevel,
          score: Math.round(thinkingScore),
          trend: tick < 30 ? 'stable' : 'declining',
          redacted: tick > 50,
          history: [],
        },
        context: {
          used: Math.round(contextPct * 200000),
          total: 200000,
          percent: contextPct,
          health: contextHealth,
          compressions: Math.floor(tick / 40),
        },
        quota: {
          used: Math.round(100 - quotaRemaining),
          total: 100,
          remaining: Math.round(quotaRemaining),
          burnRate: Math.round(burnRate),
          estimatedHoursLeft: hoursLeft,
          sessionStart: Date.now() - tick * 6000,
        },
        session: {
          duration: tick * 6,
          toolCalls: tick * 3 + Math.floor(Math.random() * 5),
          editWithoutRead: Math.floor(Math.max(0, tick - 40) * 0.3),
          readEditRatio: readEditRatio.toFixed(1),
          loops,
          consecutiveFailures: loops > 2 ? loops : 0,
          lastTool: ['read_file', 'edit_file', 'bash', 'write_file'][tick % 4],
          prompts: Math.floor(tick * 0.5),
        },
        budgetMode: this.budgetMode || quotaRemaining < 25,
        version: '2.1.100',
        lastUpdated: Date.now(),
        _simulated: true,
      };

      this.emit('update', this.metrics);

      if (this.metrics.budgetMode && !this._budgetEmitted) {
        this._budgetEmitted = true;
        this.emit('budgetMode', {
          triggered: true,
          remaining: Math.round(quotaRemaining),
          recommendations: this._getBudgetRecommendations(),
        });
      }
    };

    this._simInterval = setInterval(simulate, 600);
    simulate();
  }
}

export { THRESHOLDS };
