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
const REAL_SESSION_FORCE_RECENT_MS = 10 * 60 * 1000;
const REAL_SESSION_GRACE_MS = 30 * 60 * 1000;

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
    this._sessionPollInterval = null;
    this._quotaPollInterval = null;
    this._simInterval = null;
    this._budgetEmitted = false;
    this._watchDebounceTimer = null;
    this._pendingPreferredFile = null;
    this._lastWatchEventAt = 0;
    this._lastRealActivityAt = 0;
    this._lastProcessedSessionPath = null;
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
    if (this._sessionPollInterval) {
      clearInterval(this._sessionPollInterval);
      this._sessionPollInterval = null;
    }
    if (this._quotaPollInterval) {
      clearInterval(this._quotaPollInterval);
      this._quotaPollInterval = null;
    }
    if (this._watchDebounceTimer) {
      clearTimeout(this._watchDebounceTimer);
      this._watchDebounceTimer = null;
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

    if (this._hasRecentJsonlActivity(REAL_SESSION_FORCE_RECENT_MS)) {
      this._forceRealMode();
    }

    // Prefer real sessions only when they are active/recent.
    void this._processMostRecentSessionFile().then((hasRecent) => {
      if (!hasRecent && !this._hasRecentRealActivity()) this._startSimulation();
    });

    try {
      this.watcher = chokidar.watch(SESSIONS_GLOB, {
        persistent: true,
        ignoreInitial: false,
        usePolling: true,
        interval: 1000,
      });

      this._watchBootstrapTimer = setTimeout(() => {
        if (this._hasRecentJsonlActivity(REAL_SESSION_FORCE_RECENT_MS)) {
          this._forceRealMode();
          return;
        }
        void this._processMostRecentSessionFile().then((hasRecent) => {
          if (!hasRecent && !this._hasRecentRealActivity()) this._startSimulation();
        });
      }, 1500);

      const onWatchEvent = (filePath) => {
        this._lastWatchEventAt = Date.now();
        if (this._watchBootstrapTimer) {
          clearTimeout(this._watchBootstrapTimer);
          this._watchBootstrapTimer = null;
        }
        this._debouncedProcessMostRecentSessionFile(filePath);
      };

      this.watcher.on('change', onWatchEvent);
      this.watcher.on('add', onWatchEvent);

      this.watcher.on('error', () => {
        if (this.watcher) this.watcher.close();
        this.watcher = null;
        if (this._sessionPollInterval) {
          clearInterval(this._sessionPollInterval);
          this._sessionPollInterval = null;
        }
        this._startSimulation();
      });

      // Reliability fallback for Windows/OneDrive: periodically scan newest
      // session file even if watcher events are dropped.
      if (!this._sessionPollInterval) {
        this._sessionPollInterval = setInterval(() => {
          void (async () => {
            const hasRecent = await this._processMostRecentSessionFile();
            if (this._hasRecentJsonlActivity(REAL_SESSION_FORCE_RECENT_MS)) {
              this._forceRealMode();
            }
            if (!hasRecent && !this._hasRecentRealActivity()) this._startSimulation();
          })();
        }, 500);
      }
    } catch {
      this._startSimulation();
    }
  }

  _debouncedProcessMostRecentSessionFile(preferredFilePath = null) {
    if (preferredFilePath) this._pendingPreferredFile = preferredFilePath;
    if (this._watchDebounceTimer) {
      clearTimeout(this._watchDebounceTimer);
    }
    this._watchDebounceTimer = setTimeout(() => {
      const pathHint = this._pendingPreferredFile;
      this._pendingPreferredFile = null;
      this._watchDebounceTimer = null;
      void this._processMostRecentSessionFile(pathHint);
    }, 350);
  }

  _listSessionJsonl(dirPath, visited = new Set(), depth = 0, maxDepth = 24) {
    const files = [];
    if (depth > maxDepth) return files;

    let realDir;
    try {
      realDir = fs.realpathSync(dirPath);
    } catch {
      return files;
    }
    if (visited.has(realDir)) return files;
    visited.add(realDir);

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          files.push(...this._listSessionJsonl(fullPath, visited, depth + 1, maxDepth));
        }
      }
    } catch {
      return files;
    }

    const withMtime = files.map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Sort newest to oldest so active sessions are processed first.
    return withMtime.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
  }

  _hasRecentJsonlActivity(maxAgeMs) {
    const now = Date.now();
    const files = this._listSessionJsonl(CLAUDE_SESSIONS_DIR);
    for (const file of files) {
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        if (now - mtimeMs < maxAgeMs) {
          return true;
        }
      } catch {
        // ignore inaccessible files
      }
    }
    return false;
  }

  _forceRealMode() {
    this._lastRealActivityAt = Date.now();
    if (this._simInterval) {
      clearInterval(this._simInterval);
      this._simInterval = null;
    }
    if (this.metrics._simulated !== false) {
      this.metrics = {
        ...this.metrics,
        _simulated: false,
        lastUpdated: Date.now(),
      };
      this.emit('update', this.metrics);
    }
  }

  _hasRecentRealActivity() {
    return this._lastRealActivityAt > 0 && (Date.now() - this._lastRealActivityAt) <= REAL_SESSION_GRACE_MS;
  }

  async _isRecentSession(filePath, maxAgeMs = REAL_SESSION_GRACE_MS) {
    try {
      const stats = await fs.promises.stat(filePath);
      const ageMs = Date.now() - stats.mtimeMs;
      return ageMs <= maxAgeMs;
    } catch {
      return false;
    }
  }

  async _processMostRecentSessionFile(preferredFilePath = null) {
    if (this._hasRecentJsonlActivity(REAL_SESSION_FORCE_RECENT_MS)) {
      this._forceRealMode();
    }

    const candidates = this._listSessionJsonl(CLAUDE_SESSIONS_DIR);
    const newest = candidates[0] || null;
    if (!newest) {
      if (this._hasRecentRealActivity()) return true;
      return false;
    }

    if (this._lastProcessedSessionPath !== newest) {
      this._lastProcessedSessionPath = newest;
    }

    if (await this._isRecentSession(newest)) {
      return this._processSessionFile(newest);
    }

    if (this._hasRecentRealActivity()) return true;
    return false;
  }

  async _processSessionFile(filePath) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return false;

      const entries = lines.map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      this._analyzeSession(entries, filePath);
      return true;
    } catch {
      // File still being written
      return false;
    }
  }

  _analyzeSession(entries, filePath) {
    const metrics = this._freshMetrics();
    metrics.status = 'healthy';
    metrics.version = this._extractVersionFromEntries(entries) || this.metrics.version || null;
    metrics.quota = { ...this.metrics.quota };

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
    const toolCalls = this._extractToolCalls(entries);
    metrics.session.toolCalls = toolCalls.length;

    const reads = toolCalls.filter((e) =>
      ['read_file', 'view', 'Read'].includes(e.name)
    ).length;
    const edits = toolCalls.filter((e) =>
      ['write_file', 'edit_file', 'str_replace_based_edit_tool', 'Write', 'Edit'].includes(e.name)
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
      const tool = entry.name;
      const isError = entry.isError;

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
    metrics._simulated = false;

    if (this._simInterval) {
      clearInterval(this._simInterval);
      this._simInterval = null;
    }

    this.metrics = {
      ...this.metrics,
      ...metrics,
      thinking: { ...this.metrics.thinking, ...metrics.thinking },
      context: { ...this.metrics.context, ...metrics.context },
      quota: { ...this.metrics.quota, ...metrics.quota },
      session: { ...this.metrics.session, ...metrics.session },
    };
    this.activeSession = filePath;
    this._lastRealActivityAt = Date.now();
    this._lastProcessedSessionPath = filePath;

    this._checkBudgetMode();
    this.emit('update', this.metrics);
  }

  _extractToolCalls(entries) {
    const calls = [];
    const byUseId = new Map();

    const updateCallErrorById = (toolUseId, isError) => {
      const idx = byUseId.get(toolUseId);
      if (idx === undefined) return;
      calls[idx].isError = Boolean(isError);
    };

    const extractBlocks = (node) => {
      if (!node || typeof node !== 'object') return [];
      const content = node.message?.content;
      return Array.isArray(content) ? content : [];
    };

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      // Legacy/direct shape.
      if (entry.type === 'tool_use' || entry.tool_name) {
        calls.push({
          name: entry.name || entry.tool_name,
          isError: Boolean(entry.is_error || entry.error),
        });
      }

      if (entry.type === 'tool_result' && entry.tool_use_id) {
        updateCallErrorById(entry.tool_use_id, entry.is_error || entry.error);
      }

      // Current Claude Code shape: assistant message content blocks.
      const blocks = extractBlocks(entry);
      for (const block of blocks) {
        if (block?.type === 'tool_use' && block?.name) {
          const idx = calls.length;
          calls.push({
            name: block.name,
            isError: false,
          });
          if (block.id) {
            byUseId.set(block.id, idx);
          }
        }

        if (block?.type === 'tool_result' && block?.tool_use_id) {
          updateCallErrorById(block.tool_use_id, block.is_error || block.error);
        }
      }
    }

    return calls;
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
    this._quotaPollInterval = setInterval(() => {
      void this._readQuotaStats();
    }, 5000);
    void this._readQuotaStats();
  }

  async _readQuotaStats() {
    try {
      const raw = await fs.promises.readFile(CLAUDE_STATS_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Extract quota info if available
      if (data.quota !== undefined) {
        this.metrics.quota.remaining = data.quota;
        this.metrics.quota.used = 100 - data.quota;
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
          Number((this.metrics.quota.remaining / this.metrics.quota.burnRate).toFixed(1));
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

    if (this._sessionPollInterval) {
      clearInterval(this._sessionPollInterval);
      this._sessionPollInterval = null;
    }

    if (this._watchBootstrapTimer) {
      clearTimeout(this._watchBootstrapTimer);
      this._watchBootstrapTimer = null;
    }

    this.emit('simulating');
    this._budgetEmitted = false;
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
      const hoursLeft = Number((quotaRemaining / burnRate).toFixed(1));

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
