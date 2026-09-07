/**
 * NumReach — Countdown Number Game Solver
 * Fast local number puzzle solver and challenge generator.
 * Zero external dependencies. Vanilla JavaScript.
 */

(() => {
  'use strict';

  /* ==========================================================================
     STATE MANAGEMENT & CONSTANTS
     ========================================================================== */

  const STORAGE_KEYS = {
    HISTORY: 'numtarget_history_v1',
    STATS: 'numtarget_stats_v1',
    AUDIO_ENABLED: 'numtarget_audio_enabled_v1'
  };

  const appState = {
    currentMode: 'solve', // 'home' | 'solve' | 'game'
    audioEnabled: localStorage.getItem(STORAGE_KEYS.AUDIO_ENABLED) !== 'false',
    
    // Mode 1: Solver State
    solver: {
      numbers: [2, 3, 7, 10, 25],
      target: 847,
      allowedOps: ['+', '-', '*', '/'],
      mustUseAll: false,
      allowDecimals: false,
      allowNegatives: false,
      maxSolutions: 5,
      isSolving: false
    },

    // Mode 2: Make Me A Problem State
    game: {
      difficulty: 'medium', // 'easy' | 'medium' | 'hard' | 'custom'
      customConfig: {
        numCount: 6,
        minTarget: 100,
        maxTarget: 999,
        maxOps: 4,
        allowedOps: ['+', '-', '*', '/']
      },
      currentPuzzle: null, // { target, numbers, solutionExpr, steps, hints: [] }
      userEquationTokens: [], // Array of { type: 'num'|'op'|'paren', val: string, id: string, sourceIndex?: number }
      revealedHints: 0,
      isSolved: false
    },

    // Global Stats & History
    stats: {
      attempted: 0,
      solved: 0,
      currentStreak: 0,
      bestStreak: 0
    },
    history: []
  };

  /* ==========================================================================
     AUDIO SYNTHESIS (Zero External Files, Web Audio API)
     ========================================================================== */

  let audioCtx = null;

  function initAudio() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
      } catch (e) {
        console.warn('AudioContext not supported or blocked');
      }
    }
  }

  function playTone(freq, type = 'sine', duration = 0.15, gainVal = 0.08) {
    if (!appState.audioEnabled) return;
    try {
      initAudio();
      if (!audioCtx || audioCtx.state === 'suspended') {
        audioCtx?.resume();
      }
      if (!audioCtx) return;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(gainVal, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (err) {
      // Audio play failed gracefully
    }
  }

  function playSuccessSound() {
    if (!appState.audioEnabled) return;
    playTone(523.25, 'triangle', 0.12, 0.09); // C5
    setTimeout(() => playTone(659.25, 'triangle', 0.12, 0.09), 110); // E5
    setTimeout(() => playTone(783.99, 'triangle', 0.25, 0.1), 220); // G5
    setTimeout(() => playTone(1046.50, 'sine', 0.35, 0.12), 340); // C6
  }

  function playClickSound() {
    playTone(320, 'sine', 0.05, 0.04);
  }

  function playErrorSound() {
    playTone(220, 'sawtooth', 0.12, 0.06);
    setTimeout(() => playTone(180, 'sawtooth', 0.15, 0.06), 120);
  }

  /* ==========================================================================
     LOCAL STORAGE HANDLING
     ========================================================================== */

  function loadSavedData() {
    try {
      const savedStats = localStorage.getItem(STORAGE_KEYS.STATS);
      if (savedStats) {
        appState.stats = Object.assign(appState.stats, JSON.parse(savedStats));
      }
      const savedHist = localStorage.getItem(STORAGE_KEYS.HISTORY);
      if (savedHist) {
        appState.history = JSON.parse(savedHist);
      }
    } catch (e) {
      console.warn('Could not read from localStorage', e);
    }
  }

  function saveStats() {
    try {
      localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(appState.stats));
    } catch (e) {}
  }

  function addHistoryEntry(entry) {
    appState.history.unshift({
      id: Date.now().toString(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }),
      ...entry
    });
    // Keep max 30 entries
    if (appState.history.length > 30) appState.history.pop();
    try {
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(appState.history));
    } catch (e) {}
  }

  /* ==========================================================================
     TOAST NOTIFICATION HELPER
     ========================================================================== */

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${escapeHTML(message)}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ==========================================================================
     MATHEMATICAL EXPRESSION & EVALUATION UTILITIES
     ========================================================================== */

  /**
   * Safe parser for mathematical expressions.
   * Supports numbers, +, -, *, /, x, ×, ÷, and balanced parentheses.
   */
  function evaluateExpressionSafe(rawExpr) {
    if (!rawExpr || typeof rawExpr !== 'string') return { isValid: false, error: 'Empty expression' };

    // Standardize operator characters
    let cleaned = rawExpr
      .replace(/×/g, '*')
      .replace(/x/gi, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/\s+/g, '');

    if (!cleaned) return { isValid: false, error: 'Empty expression' };

    // Tokenize
    const tokens = [];
    let i = 0;
    while (i < cleaned.length) {
      const ch = cleaned[i];
      if (/\d/.test(ch) || ch === '.') {
        let numStr = '';
        while (i < cleaned.length && (/[\d.]/.test(cleaned[i]))) {
          numStr += cleaned[i];
          i++;
        }
        tokens.push({ type: 'num', val: parseFloat(numStr) });
      } else if (['+', '-', '*', '/', '(', ')'].includes(ch)) {
        tokens.push({ type: 'op', val: ch });
        i++;
      } else {
        return { isValid: false, error: `Invalid character: ${ch}` };
      }
    }

    if (tokens.length === 0) return { isValid: false, error: 'No tokens' };

    // Parse using Shunting-yard algorithm to Reverse Polish Notation (RPN)
    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const outputQueue = [];
    const opStack = [];

    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (tok.type === 'num') {
        outputQueue.push(tok);
      } else if (tok.val === '(') {
        opStack.push(tok);
      } else if (tok.val === ')') {
        let foundOpen = false;
        while (opStack.length > 0) {
          const top = opStack.pop();
          if (top.val === '(') {
            foundOpen = true;
            break;
          }
          outputQueue.push(top);
        }
        if (!foundOpen) return { isValid: false, error: 'Mismatched parentheses' };
      } else {
        // Operator
        // Check for unary minus or adjacent operators error
        if (t === 0 && tok.val === '-') {
          return { isValid: false, error: 'Unary negative numbers are not permitted at start' };
        }
        if (t > 0 && tokens[t - 1].type === 'op' && tokens[t - 1].val !== ')') {
          return { isValid: false, error: 'Consecutive operators are not permitted' };
        }

        while (
          opStack.length > 0 &&
          opStack[opStack.length - 1].val !== '(' &&
          precedence[opStack[opStack.length - 1].val] >= precedence[tok.val]
        ) {
          outputQueue.push(opStack.pop());
        }
        opStack.push(tok);
      }
    }

    while (opStack.length > 0) {
      const top = opStack.pop();
      if (top.val === '(' || top.val === ')') {
        return { isValid: false, error: 'Mismatched parentheses' };
      }
      outputQueue.push(top);
    }

    // Evaluate RPN
    const evalStack = [];
    for (const tok of outputQueue) {
      if (tok.type === 'num') {
        evalStack.push(tok.val);
      } else {
        if (evalStack.length < 2) {
          return { isValid: false, error: 'Incomplete mathematical expression' };
        }
        const b = evalStack.pop();
        const a = evalStack.pop();
        let res = 0;
        if (tok.val === '+') res = a + b;
        else if (tok.val === '-') res = a - b;
        else if (tok.val === '*') res = a * b;
        else if (tok.val === '/') {
          if (b === 0) return { isValid: false, error: 'Division by zero' };
          res = a / b;
        }
        evalStack.push(res);
      }
    }

    if (evalStack.length !== 1) {
      return { isValid: false, error: 'Invalid expression structure' };
    }

    return { isValid: true, result: evalStack[0] };
  }

  /**
   * Format equation with standard math symbols: × and ÷
   */
  function formatMathDisplay(exprStr) {
    if (!exprStr) return '';
    return exprStr
      .replace(/\*/g, ' × ')
      .replace(/\//g, ' ÷ ')
      .replace(/\+/g, ' + ')
      .replace(/-/g, ' − ')
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
  }

  /* ==========================================================================
     ALGORITHM 1: RECURSIVE PAIR-COMBINATION SOLVER
     ========================================================================== */

  /**
   * High performance pair-combination Countdown target solver.
   * Recursively combines numbers, tracks closest and exact solutions,
   * prunes redundant branches, and computes complexity metrics.
   */
  function solveNumTarget(config) {
    const {
      numbers,
      target,
      allowedOps = ['+', '-', '*', '/'],
      mustUseAll = false,
      allowDecimals = false,
      allowNegatives = false,
      maxSolutions = 5
    } = config;

    const startTime = performance.now();
    let stepsExplored = 0;
    const MAX_STEPS = 180000; // Safeguard against freezing
    const exactSolutionsMap = new Map(); // key: canonical expression string -> solution object

    let closest = null;
    let closestDiff = Infinity;

    // Initial pool of expressions
    // Each item represents:
    // { val, expr, steps: [{a, op, b, res}], opCount, parenDepth, maxIntermediate, usedCount }
    const initialPool = numbers.map((n, idx) => ({
      val: n,
      expr: String(n),
      steps: [],
      opCount: 0,
      parenDepth: 0,
      maxIntermediate: n,
      usedIndices: [idx],
      hasDivision: false
    }));

    // Record initial values if any equals target or is closer
    for (const item of initialPool) {
      const diff = Math.abs(item.val - target);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = item;
      }
      if (diff === 0 && (!mustUseAll || numbers.length === 1)) {
        exactSolutionsMap.set(item.expr, item);
      }
    }

    // Memoization set for explored states
    // Key: sorted values in the pool + '|' + sorted usedIndices
    const visitedStates = new Set();

    function getPoolKey(pool) {
      const vals = pool.map(x => Number(x.val.toFixed(4))).sort((a, b) => a - b).join(',');
      const used = pool.map(x => x.usedIndices.join(',')).sort().join(';');
      return `${vals}|${used}`;
    }

    function search(pool) {
      stepsExplored++;
      if (stepsExplored > MAX_STEPS) return;
      if (exactSolutionsMap.size >= maxSolutions) return;

      const stateKey = getPoolKey(pool);
      if (visitedStates.has(stateKey)) return;
      visitedStates.add(stateKey);

      const n = pool.length;

      // Check current items in pool
      for (let i = 0; i < n; i++) {
        const item = pool[i];
        const diff = Math.abs(item.val - target);

        if (diff < closestDiff && (!mustUseAll || item.usedIndices.length === numbers.length)) {
          closestDiff = diff;
          closest = item;
        }

        if (diff < 0.000001) {
          if (!mustUseAll || item.usedIndices.length === numbers.length) {
            const canon = canonicalizeExpr(item.expr);
            if (!exactSolutionsMap.has(canon)) {
              exactSolutionsMap.set(canon, item);
              if (exactSolutionsMap.size >= maxSolutions) return;
            }
          }
        }
      }

      if (n <= 1) return;

      // Pair combination: pick i < j
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const A = pool[i];
          const B = pool[j];

          // Next pool without i and j
          const nextPoolBase = pool.filter((_, idx) => idx !== i && idx !== j);

          // Operator combinations
          for (const op of allowedOps) {
            if (exactSolutionsMap.size >= maxSolutions) return;

            if (op === '+') {
              // Commutative: A + B == B + A (only do once)
              const resVal = A.val + B.val;
              const newSteps = [...A.steps, ...B.steps, { a: A.val, op: '+', b: B.val, res: resVal, exprA: A.expr, exprB: B.expr }];
              const expr = `(${A.expr} + ${B.expr})`;
              const newItem = {
                val: resVal,
                expr,
                steps: newSteps,
                opCount: A.opCount + B.opCount + 1,
                parenDepth: Math.max(A.parenDepth, B.parenDepth) + 1,
                maxIntermediate: Math.max(A.maxIntermediate, B.maxIntermediate, resVal),
                usedIndices: [...A.usedIndices, ...B.usedIndices],
                hasDivision: A.hasDivision || B.hasDivision
              };
              search([...nextPoolBase, newItem]);
            }

            if (op === '*') {
              // Commutative: A * B == B * A
              // Pruning: multiplying by 1 is generally redundant unless strictly necessary
              if (A.val === 1 && B.val === 1 && !mustUseAll) continue;
              const resVal = A.val * B.val;
              const newSteps = [...A.steps, ...B.steps, { a: A.val, op: '×', b: B.val, res: resVal, exprA: A.expr, exprB: B.expr }];
              const expr = `(${A.expr} * ${B.expr})`;
              const newItem = {
                val: resVal,
                expr,
                steps: newSteps,
                opCount: A.opCount + B.opCount + 1,
                parenDepth: Math.max(A.parenDepth, B.parenDepth) + 1,
                maxIntermediate: Math.max(A.maxIntermediate, B.maxIntermediate, resVal),
                usedIndices: [...A.usedIndices, ...B.usedIndices],
                hasDivision: A.hasDivision || B.hasDivision
              };
              search([...nextPoolBase, newItem]);
            }

            if (op === '-') {
              // A - B
              if (allowNegatives || A.val >= B.val) {
                // Skip subtracting 0 as it doesn't change value
                if (B.val !== 0) {
                  const resVal = A.val - B.val;
                  const newSteps = [...A.steps, ...B.steps, { a: A.val, op: '−', b: B.val, res: resVal, exprA: A.expr, exprB: B.expr }];
                  const expr = `(${A.expr} - ${B.expr})`;
                  const newItem = {
                    val: resVal,
                    expr,
                    steps: newSteps,
                    opCount: A.opCount + B.opCount + 1,
                    parenDepth: Math.max(A.parenDepth, B.parenDepth) + 1,
                    maxIntermediate: Math.max(A.maxIntermediate, B.maxIntermediate, resVal),
                    usedIndices: [...A.usedIndices, ...B.usedIndices],
                    hasDivision: A.hasDivision || B.hasDivision
                  };
                  search([...nextPoolBase, newItem]);
                }
              }

              // B - A (if distinct from A - B)
              if (A.val !== B.val) {
                if (allowNegatives || B.val >= A.val) {
                  if (A.val !== 0) {
                    const resVal = B.val - A.val;
                    const newSteps = [...B.steps, ...A.steps, { a: B.val, op: '−', b: A.val, res: resVal, exprA: B.expr, exprB: A.expr }];
                    const expr = `(${B.expr} - ${A.expr})`;
                    const newItem = {
                      val: resVal,
                      expr,
                      steps: newSteps,
                      opCount: A.opCount + B.opCount + 1,
                      parenDepth: Math.max(A.parenDepth, B.parenDepth) + 1,
                      maxIntermediate: Math.max(A.maxIntermediate, B.maxIntermediate, resVal),
                      usedIndices: [...A.usedIndices, ...B.usedIndices],
                      hasDivision: A.hasDivision || B.hasDivision
                    };
                    search([...nextPoolBase, newItem]);
                  }
                }
              }
            }

            if (op === '/') {
              // A / B
              if (B.val !== 0) {
                // If decimals not allowed, check integer divisibility
                const isIntegerDiv = (A.val % B.val === 0);
                if (allowDecimals || isIntegerDiv) {
                  if (B.val !== 1) { // dividing by 1 is redundant
                    const resVal = A.val / B.val;
                    const newSteps = [...A.steps, ...B.steps, { a: A.val, op: '÷', b: B.val, res: resVal, exprA: A.expr, exprB: B.expr }];
                    const expr = `(${A.expr} / ${B.expr})`;
                    const newItem = {
                      val: resVal,
                      expr,
                      steps: newSteps,
                      opCount: A.opCount + B.opCount + 1,
                      parenDepth: Math.max(A.parenDepth, B.parenDepth) + 1,
                      maxIntermediate: Math.max(A.maxIntermediate, B.maxIntermediate, resVal),
                      usedIndices: [...A.usedIndices, ...B.usedIndices],
                      hasDivision: true
                    };
                    search([...nextPoolBase, newItem]);
                  }
                }
              }

              // B / A
              if (A.val !== 0 && A.val !== B.val) {
                const isIntegerDiv = (B.val % A.val === 0);
                if (allowDecimals || isIntegerDiv) {
                  if (A.val !== 1) {
                    const resVal = B.val / A.val;
                    const newSteps = [...B.steps, ...A.steps, { a: B.val, op: '÷', b: A.val, res: resVal, exprA: B.expr, exprB: A.expr }];
                    const expr = `(${B.expr} / ${A.expr})`;
                    const newItem = {
                      val: resVal,
                      expr,
                      steps: newSteps,
                      opCount: A.opCount + B.opCount + 1,
                      parenDepth: Math.max(A.parenDepth, B.parenDepth) + 1,
                      maxIntermediate: Math.max(A.maxIntermediate, B.maxIntermediate, resVal),
                      usedIndices: [...A.usedIndices, ...B.usedIndices],
                      hasDivision: true
                    };
                    search([...nextPoolBase, newItem]);
                  }
                }
              }
            }
          }
        }
      }
    }

    search(initialPool);

    const durationMs = Math.round(performance.now() - startTime);

    // Score and rank all exact solutions
    const solutions = Array.from(exactSolutionsMap.values()).map(sol => {
      return {
        ...sol,
        difficulty: calculateDifficulty(sol)
      };
    });

    // Sort by complexity score ascending (simpler solutions first)
    solutions.sort((a, b) => a.difficulty.score - b.difficulty.score);

    // Format best closest solution if no exact match
    let closestSolution = null;
    if (closest) {
      closestSolution = {
        ...closest,
        diff: Math.abs(closest.val - target),
        difficulty: calculateDifficulty(closest)
      };
    }

    return {
      target,
      exactFound: solutions.length > 0,
      solutions: solutions.slice(0, maxSolutions),
      closest: closestSolution,
      stepsExplored,
      durationMs,
      hitLimit: stepsExplored >= MAX_STEPS
    };
  }

  /**
   * Canonicalize expression string to filter out trivial commutative duplicates
   */
  function canonicalizeExpr(expr) {
    let clean = expr.replace(/\s+/g, '');
    // Strip redundant outer parens
    if (clean.startsWith('(') && clean.endsWith(')')) {
      let depth = 0;
      let ok = true;
      for (let i = 0; i < clean.length - 1; i++) {
        if (clean[i] === '(') depth++;
        if (clean[i] === ')') depth--;
        if (depth === 0) { ok = false; break; }
      }
      if (ok) clean = clean.slice(1, -1);
    }
    return clean;
  }

  /**
   * Difficulty metric based on:
   * - Number of operations
   * - Presence of division
   * - Magnitude of intermediate calculations
   * - Depth of parentheses
   */
  function calculateDifficulty(item) {
    let score = (item.opCount || 1) * 4;
    if (item.hasDivision) score += 8;
    if (item.maxIntermediate > 1000) score += 6;
    if (item.maxIntermediate > 5000) score += 6;
    score += (item.parenDepth || 0) * 3;

    let level = 'Easy';
    let labelClass = 'easy';

    if (score >= 32) {
      level = 'Expert';
      labelClass = 'expert';
    } else if (score >= 22) {
      level = 'Hard';
      labelClass = 'hard';
    } else if (score >= 14) {
      level = 'Medium';
      labelClass = 'medium';
    }

    return {
      score,
      level,
      labelClass,
      opCount: item.opCount,
      hasDivision: item.hasDivision,
      maxIntermediate: item.maxIntermediate
    };
  }

  /* ==========================================================================
     ALGORITHM 2: GUARANTEED SOLVABLE PROBLEM GENERATOR
     ========================================================================== */

  /**
   * Generates a problem that is GUARANTEED to be solvable.
   * Method:
   * 1. Pick a selection of numbers according to difficulty.
   * 2. Build a valid randomized expression tree forward step-by-step.
   * 3. Target is the calculated result.
   * 4. Numbers used in the tree + distractor numbers form the available numbers.
   * 5. The exact tree steps are preserved for multi-level hints!
   */
  function generatePuzzle(difficulty = 'medium', customConfig = null) {
    const largePool = [25, 50, 75, 100];
    const smallPool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    let minTarget = 50;
    let maxTarget = 300;
    let targetOpsCount = 2;
    let poolSize = 5;
    let largeCount = 1;
    let allowedOps = ['+', '-', '*', '/'];

    if (difficulty === 'easy') {
      minTarget = 20;
      maxTarget = 120;
      targetOpsCount = 2;
      poolSize = 4;
      largeCount = 0;
      allowedOps = ['+', '-', '*'];
    } else if (difficulty === 'medium') {
      minTarget = 100;
      maxTarget = 500;
      targetOpsCount = 3;
      poolSize = 5;
      largeCount = 1;
      allowedOps = ['+', '-', '*', '/'];
    } else if (difficulty === 'hard') {
      minTarget = 101;
      maxTarget = 999;
      targetOpsCount = 4;
      poolSize = 6;
      largeCount = 2;
      allowedOps = ['+', '-', '*', '/'];
    } else if (difficulty === 'custom' && customConfig) {
      poolSize = customConfig.numCount || 5;
      minTarget = customConfig.minTarget || 50;
      maxTarget = customConfig.maxTarget || 999;
      targetOpsCount = Math.min(poolSize - 1, customConfig.maxOps || 3);
      allowedOps = customConfig.allowedOps?.length ? customConfig.allowedOps : ['+', '-', '*', '/'];
      largeCount = poolSize >= 6 ? 2 : 1;
    }

    // Try up to 60 iterations to generate a non-trivial, clean puzzle within target range
    for (let attempt = 0; attempt < 60; attempt++) {
      // Pick starting numbers
      const chosenNumbers = [];
      // Pick large numbers
      const shuffledLarge = [...largePool].sort(() => Math.random() - 0.5);
      for (let l = 0; l < largeCount && l < shuffledLarge.length; l++) {
        chosenNumbers.push(shuffledLarge[l]);
      }
      // Pick small numbers (allow up to 2 of each small number as in Countdown)
      const fullSmall = [...smallPool, ...smallPool].sort(() => Math.random() - 0.5);
      while (chosenNumbers.length < poolSize && fullSmall.length > 0) {
        chosenNumbers.push(fullSmall.pop());
      }

      // We will pick a subset of `targetOpsCount + 1` numbers to combine
      const numbersToUse = [...chosenNumbers].sort(() => Math.random() - 0.5).slice(0, targetOpsCount + 1);
      
      // Build expression nodes
      let activeNodes = numbersToUse.map(n => ({
        val: n,
        expr: String(n),
        steps: [],
        rawNum: n
      }));

      const milestoneValues = [];
      let valid = true;

      // Iteratively combine two nodes
      while (activeNodes.length > 1) {
        // Pick two random nodes
        const i1 = Math.floor(Math.random() * activeNodes.length);
        let i2 = Math.floor(Math.random() * (activeNodes.length - 1));
        if (i2 >= i1) i2++;

        const nodeA = activeNodes[i1];
        const nodeB = activeNodes[i2];
        const rest = activeNodes.filter((_, idx) => idx !== i1 && idx !== i2);

        // Pick an operation that gives clean non-trivial positive integer
        const validOps = [];
        for (const op of allowedOps) {
          if (op === '+') validOps.push({ op: '+', a: nodeA, b: nodeB, val: nodeA.val + nodeB.val });
          if (op === '*') {
            if (nodeA.val > 1 && nodeB.val > 1 && nodeA.val * nodeB.val <= maxTarget * 2) {
              validOps.push({ op: '×', a: nodeA, b: nodeB, val: nodeA.val * nodeB.val });
            }
          }
          if (op === '-') {
            if (nodeA.val > nodeB.val && nodeA.val - nodeB.val > 0) {
              validOps.push({ op: '−', a: nodeA, b: nodeB, val: nodeA.val - nodeB.val });
            } else if (nodeB.val > nodeA.val && nodeB.val - nodeA.val > 0) {
              validOps.push({ op: '−', a: nodeB, b: nodeA, val: nodeB.val - nodeA.val });
            }
          }
          if (op === '/') {
            if (nodeB.val > 1 && nodeA.val % nodeB.val === 0) {
              validOps.push({ op: '÷', a: nodeA, b: nodeB, val: nodeA.val / nodeB.val });
            } else if (nodeA.val > 1 && nodeB.val % nodeA.val === 0) {
              validOps.push({ op: '÷', a: nodeB, b: nodeA, val: nodeB.val / nodeA.val });
            }
          }
        }

        if (validOps.length === 0) {
          valid = false;
          break;
        }

        const chosenOp = validOps[Math.floor(Math.random() * validOps.length)];
        const stepExpr = `(${chosenOp.a.expr} ${chosenOp.op} ${chosenOp.b.expr})`;
        const newSteps = [
          ...chosenOp.a.steps,
          ...chosenOp.b.steps,
          {
            stepDesc: `${chosenOp.a.val} ${chosenOp.op} ${chosenOp.b.val} = ${chosenOp.val}`,
            val: chosenOp.val
          }
        ];

        milestoneValues.push(chosenOp.val);

        activeNodes = [
          ...rest,
          {
            val: chosenOp.val,
            expr: stepExpr,
            steps: newSteps
          }
        ];
      }

      if (!valid || activeNodes.length !== 1) continue;

      const finalVal = activeNodes[0].val;

      // Check if target is inside range and not trivial
      if (
        finalVal >= minTarget &&
        finalVal <= maxTarget &&
        !chosenNumbers.includes(finalVal) &&
        Number.isInteger(finalVal)
      ) {
        // Construct progressive hints
        const allSteps = activeNodes[0].steps;
        const hints = [];

        // Hint 1: Strategy hint
        const sortedUsedNums = numbersToUse.sort((a, b) => b - a);
        if (sortedUsedNums[0] >= 25 && finalVal >= 100) {
          hints.push(`💡 Strategy Tip: Try using ${sortedUsedNums[0]} as a major anchor to get close to ${finalVal}.`);
        } else {
          hints.push(`💡 Strategy Tip: Look at combinations that produce numbers near ${Math.round(finalVal / 10) * 10}.`);
        }

        // Hint 2: Milestone intermediate result
        if (allSteps.length > 1) {
          const midStep = allSteps[0];
          hints.push(`🎯 Intermediate Goal: A key milestone value along the way is ${midStep.val}.`);
        } else {
          hints.push(`🎯 Intermediate Goal: You can reach this in very few concise steps.`);
        }

        // Hint 3: Clue on first equation part
        if (allSteps.length > 0) {
          hints.push(`🔍 Partial Equation Clue: One of the steps is "${allSteps[0].stepDesc}".`);
        }

        return {
          target: finalVal,
          availableNumbers: chosenNumbers.sort(() => Math.random() - 0.5),
          solutionExpr: activeNodes[0].expr,
          steps: allSteps,
          hints
        };
      }
    }

    // Reliable fallback in the rare case random generation attempts timed out
    return {
      target: 847,
      availableNumbers: [25, 50, 3, 7, 10, 2],
      solutionExpr: '((25 * 10 * 3) + (7 * 14))', // classic 847 or 848
      steps: [
        { stepDesc: '25 × 10 = 250', val: 250 },
        { stepDesc: '250 × 3 = 750', val: 750 },
        { stepDesc: '50 + 50 - 3 = 97', val: 97 },
        { stepDesc: '750 + 97 = 847', val: 847 }
      ],
      hints: [
        '💡 Strategy Tip: Multiplying larger numbers like 25 and 10 will quickly boost your value.',
        '🎯 Intermediate Goal: Aim for a milestone intermediate of 250 or 750.',
        '🔍 Partial Equation Clue: Start with 25 × 10 = 250.'
      ]
    };
  }

  /* ==========================================================================
     UI CONTROLLER & EVENT WIRING
     ========================================================================== */

  function initApp() {
    loadSavedData();
    setupNavigation();
    setupSolveMode();
    setupGameMode();
    setupModals();
    updateHeaderStatsBadge();

    // Sound toggle state
    const soundBtn = document.getElementById('sound-toggle-btn');
    if (soundBtn) {
      soundBtn.classList.toggle('active', appState.audioEnabled);
      soundBtn.addEventListener('click', () => {
        appState.audioEnabled = !appState.audioEnabled;
        localStorage.setItem(STORAGE_KEYS.AUDIO_ENABLED, String(appState.audioEnabled));
        soundBtn.classList.toggle('active', appState.audioEnabled);
        showToast(appState.audioEnabled ? 'Sound enabled' : 'Sound muted');
      });
    }

    // Default to 'solve' mode or load clean view
    switchMode('solve');
  }

  /* Navigation & Mode Switching */
  function setupNavigation() {
    const brand = document.getElementById('site-brand');
    if (brand) {
      brand.addEventListener('click', (e) => {
        e.preventDefault();
        switchMode('home');
      });
    }

    const tabSolve = document.getElementById('tab-mode-solve');
    const tabGame = document.getElementById('tab-mode-game');

    if (tabSolve) tabSolve.addEventListener('click', () => switchMode('solve'));
    if (tabGame) tabGame.addEventListener('click', () => switchMode('game'));

    const heroCardSolve = document.getElementById('hero-card-solve');
    const heroCardGame = document.getElementById('hero-card-game');

    if (heroCardSolve) heroCardSolve.addEventListener('click', () => switchMode('solve'));
    if (heroCardGame) heroCardGame.addEventListener('click', () => switchMode('game'));
  }

  function switchMode(modeName) {
    appState.currentMode = modeName;
    playClickSound();

    // Update Tab Buttons
    const tabSolve = document.getElementById('tab-mode-solve');
    const tabGame = document.getElementById('tab-mode-game');
    if (tabSolve) tabSolve.classList.toggle('active', modeName === 'solve');
    if (tabGame) tabGame.classList.toggle('active', modeName === 'game');

    // Update View Sections
    const homeView = document.getElementById('view-home');
    const solveView = document.getElementById('view-solve');
    const gameView = document.getElementById('view-game');

    if (homeView) homeView.classList.toggle('active', modeName === 'home');
    if (solveView) solveView.classList.toggle('active', modeName === 'solve');
    if (gameView) gameView.classList.toggle('active', modeName === 'game');

    if (modeName === 'game' && !appState.game.currentPuzzle) {
      generateAndDisplayProblem();
    }
  }

  /* ==========================================================================
     MODE 1: SOLVE MY NUMBERS CONTROLLER
     ========================================================================== */

  function setupSolveMode() {
    const numInput = document.getElementById('solve-num-input');
    const addBtn = document.getElementById('solve-add-num-btn');
    const clearBtn = document.getElementById('solve-clear-nums-btn');
    const exampleBtn = document.getElementById('solve-example-btn');
    const targetInput = document.getElementById('solve-target-input');
    const solveBtn = document.getElementById('solve-submit-btn');

    // Render initial chips
    renderSolverChips();

    // Add Number on button click or Enter
    if (addBtn && numInput) {
      const handleAdd = () => {
        const val = numInput.value.trim();
        if (!val) return;

        // Support comma-separated or space-separated list
        const parts = val.split(/[,\s]+/).map(p => parseFloat(p)).filter(n => !isNaN(n));
        if (parts.length === 0) {
          showToast('Please enter valid numeric values', 'warning');
          return;
        }

        appState.solver.numbers.push(...parts);
        numInput.value = '';
        renderSolverChips();
        playClickSound();
      };

      addBtn.addEventListener('click', handleAdd);
      numInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAdd();
        }
      });
    }

    // Clear Numbers
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        appState.solver.numbers = [];
        renderSolverChips();
        playClickSound();
      });
    }

    // Try Example Button
    if (exampleBtn) {
      exampleBtn.addEventListener('click', () => {
        const examples = [
          { numbers: [25, 50, 75, 100, 3, 6], target: 952 },
          { numbers: [2, 3, 7, 10, 25], target: 847 },
          { numbers: [1, 3, 7, 10, 25, 50], target: 765 },
          { numbers: [4, 8, 25, 50, 75, 100], target: 494 },
          { numbers: [5, 6, 8, 9, 25, 100], target: 673 }
        ];
        const ex = examples[Math.floor(Math.random() * examples.length)];
        appState.solver.numbers = [...ex.numbers];
        appState.solver.target = ex.target;
        if (targetInput) targetInput.value = ex.target;
        renderSolverChips();
        playClickSound();
        showToast(`Loaded example target: ${ex.target}`);
      });
    }

    // Target input changes
    if (targetInput) {
      targetInput.value = appState.solver.target;
      targetInput.addEventListener('input', () => {
        const val = parseFloat(targetInput.value);
        if (!isNaN(val)) {
          appState.solver.target = val;
        }
      });
      targetInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          executeSolver();
        }
      });
    }

    // Settings checkboxes & selects
    const opAdd = document.getElementById('op-add');
    const opSub = document.getElementById('op-sub');
    const opMul = document.getElementById('op-mul');
    const opDiv = document.getElementById('op-div');
    const toggleMustUseAll = document.getElementById('toggle-must-use-all');
    const toggleAllowDecimals = document.getElementById('toggle-allow-decimals');
    const toggleAllowNegatives = document.getElementById('toggle-allow-negatives');
    const selectMaxSolutions = document.getElementById('select-max-solutions');

    const updateSolverSettings = () => {
      const ops = [];
      if (opAdd?.checked) ops.push('+');
      if (opSub?.checked) ops.push('-');
      if (opMul?.checked) ops.push('*');
      if (opDiv?.checked) ops.push('/');
      appState.solver.allowedOps = ops.length ? ops : ['+'];
      appState.solver.mustUseAll = !!toggleMustUseAll?.checked;
      appState.solver.allowDecimals = !!toggleAllowDecimals?.checked;
      appState.solver.allowNegatives = !!toggleAllowNegatives?.checked;
      appState.solver.maxSolutions = parseInt(selectMaxSolutions?.value || '5', 10);
    };

    [opAdd, opSub, opMul, opDiv, toggleMustUseAll, toggleAllowDecimals, toggleAllowNegatives, selectMaxSolutions].forEach(el => {
      el?.addEventListener('change', updateSolverSettings);
    });

    // Primary SOLVE button
    if (solveBtn) {
      solveBtn.addEventListener('click', executeSolver);
    }
  }

  function renderSolverChips() {
    const container = document.getElementById('solver-chips-container');
    if (!container) return;

    container.innerHTML = '';
    if (appState.solver.numbers.length === 0) {
      container.innerHTML = '<span class="chips-empty-hint">No numbers added yet. Enter numbers above.</span>';
      return;
    }

    appState.solver.numbers.forEach((num, index) => {
      const chip = document.createElement('div');
      chip.className = 'num-chip';
      chip.innerHTML = `
        <span>${num}</span>
        <button class="chip-remove-btn" title="Remove" aria-label="Remove ${num}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;

      chip.querySelector('.chip-remove-btn').addEventListener('click', () => {
        appState.solver.numbers.splice(index, 1);
        renderSolverChips();
        playClickSound();
      });

      container.appendChild(chip);
    });
  }

  function executeSolver() {
    if (appState.solver.isSolving) return;

    if (appState.solver.numbers.length < 2) {
      showToast('Please provide at least 2 numbers to combine', 'warning');
      playErrorSound();
      return;
    }

    const targetVal = parseFloat(document.getElementById('solve-target-input')?.value);
    if (isNaN(targetVal)) {
      showToast('Please enter a valid numeric target', 'warning');
      playErrorSound();
      return;
    }

    appState.solver.target = targetVal;

    const loader = document.getElementById('solver-loader');
    const resultsCard = document.getElementById('solver-results-card');
    const solveBtn = document.getElementById('solve-submit-btn');

    loader?.classList.add('active');
    resultsCard?.classList.remove('active');
    if (solveBtn) solveBtn.disabled = true;
    appState.solver.isSolving = true;

    // Run asynchronously to allow UI paint
    setTimeout(() => {
      try {
        const result = solveNumTarget({
          numbers: appState.solver.numbers,
          target: appState.solver.target,
          allowedOps: appState.solver.allowedOps,
          mustUseAll: appState.solver.mustUseAll,
          allowDecimals: appState.solver.allowDecimals,
          allowNegatives: appState.solver.allowNegatives,
          maxSolutions: appState.solver.maxSolutions
        });

        displaySolverResults(result);

        // Record in history
        if (result.exactFound || result.closest) {
          const primarySolution = result.exactFound ? result.solutions[0] : result.closest;
          addHistoryEntry({
            mode: 'Solver',
            target: result.target,
            numbers: [...appState.solver.numbers],
            equation: formatMathDisplay(primarySolution.expr) + ' = ' + primarySolution.val,
            exact: result.exactFound,
            diff: result.exactFound ? 0 : Math.abs(primarySolution.val - result.target)
          });
        }

        if (result.exactFound) {
          playSuccessSound();
        } else {
          playTone(400, 'sine', 0.15, 0.08);
        }
      } catch (err) {
        console.error('Solver execution error', err);
        showToast('Error during solving: ' + err.message, 'danger');
      } finally {
        loader?.classList.remove('active');
        if (solveBtn) solveBtn.disabled = false;
        appState.solver.isSolving = false;
      }
    }, 40);
  }

  function displaySolverResults(result) {
    const resultsCard = document.getElementById('solver-results-card');
    if (!resultsCard) return;

    resultsCard.classList.add('active');

    const statusBanner = document.getElementById('result-status-banner');
    const eqDisplay = document.getElementById('result-equation-text');
    const metaRow = document.getElementById('result-meta-row');
    const stepTraceBox = document.getElementById('result-step-trace');
    const alternativesContainer = document.getElementById('result-alternatives');
    const altSectionWrapper = document.getElementById('alt-solutions-wrapper');

    const primarySolution = result.exactFound ? result.solutions[0] : result.closest;

    if (!primarySolution) {
      if (statusBanner) {
        statusBanner.className = 'result-status-banner closest';
        statusBanner.innerHTML = `<span>NO COMBINATIONS FOUND</span><span>Diff: ∞</span>`;
      }
      if (eqDisplay) eqDisplay.textContent = 'Unable to form valid expression with current constraints.';
      return;
    }

    const diff = Math.abs(primarySolution.val - result.target);
    const isExact = diff < 0.000001;

    // Status Banner
    if (statusBanner) {
      statusBanner.className = `result-status-banner ${isExact ? 'exact' : 'closest'}`;
      statusBanner.innerHTML = isExact
        ? `<span>EXACT MATCH FOUND ✓</span><span>Target: ${result.target}</span>`
        : `<span>CLOSEST RESULT REACHED</span><span>Off by ±${diff.toFixed(2)}</span>`;
    }

    // Formatted Equation
    const cleanExpr = formatMathDisplay(primarySolution.expr);
    if (eqDisplay) {
      eqDisplay.textContent = `${cleanExpr} = ${primarySolution.val}`;
    }

    // Metadata & Difficulty pill
    const diffData = primarySolution.difficulty;
    if (metaRow) {
      metaRow.innerHTML = `
        <span class="diff-badge ${isExact ? 'zero' : 'nonzero'}">
          ${isExact ? 'Exact 0 Diff' : `Diff: ${diff}`}
        </span>
        <span class="difficulty-pill ${diffData.labelClass}">
          Difficulty: ${diffData.level} (Complexity ${diffData.score})
        </span>
        <span>Ops used: ${diffData.opCount}</span>
        <span>Search: ${result.stepsExplored.toLocaleString()} states in ${result.durationMs}ms</span>
      `;
    }

    // Step-by-step trace
    if (stepTraceBox) {
      if (primarySolution.steps && primarySolution.steps.length > 0) {
        stepTraceBox.style.display = 'flex';
        stepTraceBox.innerHTML = `
          <div class="step-trace-title">Step-by-Step Calculation Breakdown</div>
          ${primarySolution.steps.map((st, i) => `
            <div class="step-item">
              <span class="step-number">${i + 1}.</span>
              <span>${formatMathDisplay(st.exprA || String(st.a))} ${st.op} ${formatMathDisplay(st.exprB || String(st.b))} = <strong>${st.res}</strong></span>
            </div>
          `).join('')}
        `;
      } else {
        stepTraceBox.style.display = 'none';
      }
    }

    // Alternative Solutions
    const altSolutions = result.solutions.slice(1);
    if (altSolutions.length > 0 && alternativesContainer && altSectionWrapper) {
      altSectionWrapper.style.display = 'block';
      alternativesContainer.innerHTML = altSolutions.map((alt, idx) => `
        <div class="alt-solution-card">
          <div class="alt-equation">${formatMathDisplay(alt.expr)} = ${alt.val}</div>
          <div class="difficulty-pill ${alt.difficulty.labelClass}">${alt.difficulty.level}</div>
        </div>
      `).join('');
    } else if (altSectionWrapper) {
      altSectionWrapper.style.display = 'none';
    }

    // Wire Copy & Share buttons
    const copyBtn = document.getElementById('btn-copy-solver-eq');
    const shareBtn = document.getElementById('btn-share-solver-puzzle');

    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(`${cleanExpr} = ${primarySolution.val}`);
        showToast('Equation copied to clipboard!');
        playClickSound();
      };
    }

    if (shareBtn) {
      shareBtn.onclick = () => {
        const text = `🎯 NumReach (Countdown Number Game Solver): Can you reach ${result.target} using: ${appState.solver.numbers.join(', ')}? Try it on NumReach!`;
        navigator.clipboard.writeText(text);
        showToast('Shareable puzzle challenge copied!');
        playClickSound();
      };
    }

    // Smooth scroll down to results
    resultsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ==========================================================================
     MODE 2: MAKE ME A PROBLEM CONTROLLER
     ========================================================================== */

  function setupGameMode() {
    // Difficulty pill buttons
    const diffBtns = document.querySelectorAll('.diff-btn');
    const customPanel = document.getElementById('game-custom-panel');

    diffBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        diffBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const diff = btn.dataset.diff;
        appState.game.difficulty = diff;

        if (customPanel) {
          customPanel.classList.toggle('active', diff === 'custom');
        }
        playClickSound();
      });
    });

    // Custom configuration inputs
    const customNumCount = document.getElementById('custom-num-count');
    const customMinTarget = document.getElementById('custom-min-target');
    const customMaxTarget = document.getElementById('custom-max-target');
    const customMaxOps = document.getElementById('custom-max-ops');

    const updateCustomConfig = () => {
      if (customNumCount) appState.game.customConfig.numCount = parseInt(customNumCount.value, 10);
      if (customMinTarget) appState.game.customConfig.minTarget = parseInt(customMinTarget.value, 10);
      if (customMaxTarget) appState.game.customConfig.maxTarget = parseInt(customMaxTarget.value, 10);
      if (customMaxOps) appState.game.customConfig.maxOps = parseInt(customMaxOps.value, 10);
    };

    [customNumCount, customMinTarget, customMaxTarget, customMaxOps].forEach(el => {
      el?.addEventListener('change', updateCustomConfig);
    });

    // Generate Problem Button
    const generateBtn = document.getElementById('game-generate-btn');
    if (generateBtn) {
      generateBtn.addEventListener('click', () => {
        generateAndDisplayProblem();
      });
    }

    // Keypad Operation Buttons
    const keypadBtns = document.querySelectorAll('.keypad-btn[data-token]');
    keypadBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tokenVal = btn.dataset.token;
        appendEquationToken({
          type: ['+', '-', '*', '/'].includes(tokenVal) ? 'op' : 'paren',
          val: tokenVal,
          id: 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)
        });
        playClickSound();
      });
    });

    // Keypad Action Buttons (Backspace, Clear)
    const btnBackspace = document.getElementById('keypad-btn-backspace');
    const btnClear = document.getElementById('keypad-btn-clear');

    if (btnBackspace) {
      btnBackspace.addEventListener('click', () => {
        removeLastEquationToken();
        playClickSound();
      });
    }

    if (btnClear) {
      btnClear.addEventListener('click', () => {
        clearEquationTokens();
        playClickSound();
      });
    }

    // Manual equation typing text field synced two-way
    const manualInput = document.getElementById('manual-equation-input');
    if (manualInput) {
      manualInput.addEventListener('input', () => {
        syncFromManualInput(manualInput.value);
      });
      manualInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          checkUserGameAnswer();
        }
      });
    }

    // Game Action Buttons
    const checkBtn = document.getElementById('game-check-btn');
    const hintBtn = document.getElementById('game-hint-btn');
    const revealBtn = document.getElementById('game-reveal-btn');
    const newProblemBtn = document.getElementById('game-new-problem-btn');
    const sharePuzzleBtn = document.getElementById('game-share-puzzle-btn');

    if (checkBtn) checkBtn.addEventListener('click', checkUserGameAnswer);
    if (hintBtn) hintBtn.addEventListener('click', revealNextHint);
    if (revealBtn) revealBtn.addEventListener('click', revealGameSolution);
    if (newProblemBtn) newProblemBtn.addEventListener('click', generateAndDisplayProblem);
    if (sharePuzzleBtn) {
      sharePuzzleBtn.addEventListener('click', () => {
        if (!appState.game.currentPuzzle) return;
        const text = `🎯 NumReach (Countdown Number Game Solver): Can you reach ${appState.game.currentPuzzle.target} using [ ${appState.game.currentPuzzle.availableNumbers.join(', ')} ]? Try it out on NumReach!`;
        navigator.clipboard.writeText(text);
        showToast('Puzzle copied to clipboard! Share with your friends.');
        playClickSound();
      });
    }
  }

  function generateAndDisplayProblem() {
    playClickSound();
    const puzzle = generatePuzzle(appState.game.difficulty, appState.game.customConfig);
    appState.game.currentPuzzle = puzzle;
    appState.game.revealedHints = 0;
    appState.game.isSolved = false;

    // Reset Builder Tokens
    clearEquationTokens();

    // Reset Hints & Solution Displays
    const hintsContainer = document.getElementById('hints-display-list');
    const hintsCard = document.getElementById('game-hints-card');
    const revealedBox = document.getElementById('game-revealed-solution');
    const feedbackBanner = document.getElementById('game-feedback-banner');

    if (hintsContainer) hintsContainer.innerHTML = '';
    if (hintsCard) hintsCard.style.display = 'none';
    if (revealedBox) revealedBox.classList.remove('active');
    if (feedbackBanner) feedbackBanner.classList.remove('active');

    // Display Target
    const targetHero = document.getElementById('game-target-number');
    if (targetHero) {
      targetHero.textContent = puzzle.target;
    }

    // Render Available Number Buttons
    renderGameNumberButtons();

    // Increment Attempted Stats
    appState.stats.attempted++;
    saveStats();
    updateHeaderStatsBadge();

    showToast(`New ${appState.game.difficulty} challenge ready! Reach ${puzzle.target}.`);
  }

  function renderGameNumberButtons() {
    const grid = document.getElementById('game-numbers-grid');
    if (!grid || !appState.game.currentPuzzle) return;

    grid.innerHTML = '';

    // Count available occurrences vs used in userEquationTokens
    const available = appState.game.currentPuzzle.availableNumbers;
    const usedCounts = {};
    for (const tok of appState.game.userEquationTokens) {
      if (tok.type === 'num') {
        const val = Number(tok.val);
        usedCounts[val] = (usedCounts[val] || 0) + 1;
      }
    }

    // We render one button per unique number or list item
    available.forEach((num, originalIdx) => {
      // Check if this specific index was used
      const isUsed = appState.game.userEquationTokens.some(t => t.type === 'num' && t.sourceIndex === originalIdx);

      const btn = document.createElement('button');
      btn.className = `game-num-btn ${isUsed ? 'disabled' : ''}`;
      btn.innerHTML = `<span>${num}</span>`;
      btn.title = isUsed ? 'Number already used' : `Click to add ${num}`;

      if (!isUsed) {
        btn.addEventListener('click', () => {
          appendEquationToken({
            type: 'num',
            val: String(num),
            id: 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            sourceIndex: originalIdx
          });
          playClickSound();
        });
      }

      grid.appendChild(btn);
    });
  }

  function appendEquationToken(token) {
    appState.game.userEquationTokens.push(token);
    renderVisualEquationScreen();
    renderGameNumberButtons();
    updateLiveEvalPreview();
  }

  function removeLastEquationToken() {
    if (appState.game.userEquationTokens.length > 0) {
      appState.game.userEquationTokens.pop();
      renderVisualEquationScreen();
      renderGameNumberButtons();
      updateLiveEvalPreview();
    }
  }

  function clearEquationTokens() {
    appState.game.userEquationTokens = [];
    renderVisualEquationScreen();
    renderGameNumberButtons();
    updateLiveEvalPreview();
    const manualInput = document.getElementById('manual-equation-input');
    if (manualInput) manualInput.value = '';
  }

  function syncFromManualInput(typedText) {
    // Parse typed text into tokens and assign source indices from available numbers
    if (!appState.game.currentPuzzle) return;

    const availablePool = [...appState.game.currentPuzzle.availableNumbers];
    const availableUsed = new Array(availablePool.length).fill(false);

    let cleaned = typedText
      .replace(/×/g, '*')
      .replace(/x/gi, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/\s+/g, '');

    const newTokens = [];
    let i = 0;

    while (i < cleaned.length) {
      const ch = cleaned[i];
      if (/\d/.test(ch)) {
        let numStr = '';
        while (i < cleaned.length && /\d/.test(cleaned[i])) {
          numStr += cleaned[i];
          i++;
        }
        const numVal = parseInt(numStr, 10);
        // Find matching source index in available
        let foundIdx = -1;
        for (let a = 0; a < availablePool.length; a++) {
          if (!availableUsed[a] && availablePool[a] === numVal) {
            foundIdx = a;
            availableUsed[a] = true;
            break;
          }
        }

        newTokens.push({
          type: 'num',
          val: numStr,
          id: 'tok_' + Math.random().toString(36).substr(2, 6),
          sourceIndex: foundIdx !== -1 ? foundIdx : -1
        });
      } else if (['+', '-', '*', '/'].includes(ch)) {
        newTokens.push({
          type: 'op',
          val: ch,
          id: 'tok_' + Math.random().toString(36).substr(2, 6)
        });
        i++;
      } else if (['(', ')'].includes(ch)) {
        newTokens.push({
          type: 'paren',
          val: ch,
          id: 'tok_' + Math.random().toString(36).substr(2, 6)
        });
        i++;
      } else {
        i++;
      }
    }

    appState.game.userEquationTokens = newTokens;
    renderVisualEquationScreen();
    renderGameNumberButtons();
    updateLiveEvalPreview();
  }

  function renderVisualEquationScreen() {
    const screen = document.getElementById('visual-equation-tokens');
    if (!screen) return;

    screen.innerHTML = '';
    const tokens = appState.game.userEquationTokens;

    if (tokens.length === 0) {
      screen.innerHTML = '<span class="builder-empty-placeholder">Click numbers & operations or type below...</span>';
      return;
    }

    tokens.forEach((tok, idx) => {
      const pill = document.createElement('span');
      pill.className = `equation-token ${tok.type}`;
      
      let displaySymbol = tok.val;
      if (tok.val === '*') displaySymbol = '×';
      if (tok.val === '/') displaySymbol = '÷';
      if (tok.val === '-') displaySymbol = '−';

      pill.textContent = displaySymbol;
      pill.title = 'Click to remove token';

      pill.addEventListener('click', () => {
        tokens.splice(idx, 1);
        renderVisualEquationScreen();
        renderGameNumberButtons();
        updateLiveEvalPreview();
        playClickSound();
      });

      screen.appendChild(pill);
    });

    // Also update manual input text box if user didn't currently have it focused
    const manualInput = document.getElementById('manual-equation-input');
    if (manualInput && document.activeElement !== manualInput) {
      manualInput.value = formatMathDisplay(tokens.map(t => t.val).join(' '));
    }
  }

  function updateLiveEvalPreview() {
    const previewEl = document.getElementById('live-eval-preview');
    if (!previewEl) return;

    if (appState.game.userEquationTokens.length === 0) {
      previewEl.textContent = '–';
      previewEl.className = 'live-eval-val invalid';
      return;
    }

    const expr = appState.game.userEquationTokens.map(t => t.val).join(' ');
    const evalResult = evaluateExpressionSafe(expr);

    if (evalResult.isValid) {
      const val = evalResult.result;
      const target = appState.game.currentPuzzle?.target;
      if (target !== undefined && Math.abs(val - target) < 0.00001) {
        previewEl.textContent = `= ${val} (Exact Match! ✓)`;
        previewEl.className = 'live-eval-val exact';
      } else {
        const diff = Math.abs(val - (target || 0));
        previewEl.textContent = `= ${val} (Diff: ${diff})`;
        previewEl.className = 'live-eval-val off';
      }
    } else {
      previewEl.textContent = 'Incomplete';
      previewEl.className = 'live-eval-val invalid';
    }
  }

  function checkUserGameAnswer() {
    if (!appState.game.currentPuzzle) return;

    const puzzle = appState.game.currentPuzzle;
    const tokens = appState.game.userEquationTokens;
    const banner = document.getElementById('game-feedback-banner');

    if (tokens.length === 0) {
      showToast('Please construct an equation first!', 'warning');
      playErrorSound();
      return;
    }

    // 1. Validate that only available numbers are used and not used more times than allowed
    const availableCounts = {};
    for (const num of puzzle.availableNumbers) {
      availableCounts[num] = (availableCounts[num] || 0) + 1;
    }

    const usedCounts = {};
    for (const tok of tokens) {
      if (tok.type === 'num') {
        const numVal = parseInt(tok.val, 10);
        usedCounts[numVal] = (usedCounts[numVal] || 0) + 1;
        if (!availableCounts[numVal] || usedCounts[numVal] > availableCounts[numVal]) {
          showFeedbackBanner('invalid', 'Invalid Number Used', `The number ${numVal} is either not in the puzzle or used more times than provided.`);
          playErrorSound();
          return;
        }
      }
    }

    // 2. Validate mathematical expression correctness
    const rawExpr = tokens.map(t => t.val).join(' ');
    const evalResult = evaluateExpressionSafe(rawExpr);

    if (!evalResult.isValid) {
      showFeedbackBanner('invalid', 'Invalid Equation Syntax', evalResult.error || 'Please check for matching brackets and correct operator placement.');
      playErrorSound();
      return;
    }

    const userResult = evalResult.result;
    const diff = Math.abs(userResult - puzzle.target);

    // 3. Exact Solution
    if (diff < 0.00001) {
      showFeedbackBanner('win', 'Target Reached! Exact Match ✓', `Outstanding work! You calculated exactly ${puzzle.target} using ${rawExpr}.`);
      playSuccessSound();

      if (!appState.game.isSolved) {
        appState.game.isSolved = true;
        appState.stats.solved++;
        appState.stats.currentStreak++;
        if (appState.stats.currentStreak > appState.stats.bestStreak) {
          appState.stats.bestStreak = appState.stats.currentStreak;
        }
        saveStats();
        updateHeaderStatsBadge();

        addHistoryEntry({
          mode: `Problem (${appState.game.difficulty})`,
          target: puzzle.target,
          numbers: [...puzzle.availableNumbers],
          equation: `${formatMathDisplay(rawExpr)} = ${userResult}`,
          exact: true,
          diff: 0
        });
      }
    } else {
      // 4. Close Solution
      showFeedbackBanner('close', `Result: ${userResult} (Diff: ${diff})`, `Close! You reached ${userResult}, which is off by ${diff}. Keep tweaking your equation to reach ${puzzle.target}!`);
      playTone(420, 'triangle', 0.2, 0.07);
    }
  }

  function showFeedbackBanner(type, title, body) {
    const banner = document.getElementById('game-feedback-banner');
    if (!banner) return;
    banner.className = `game-result-feedback ${type} active`;
    banner.innerHTML = `
      <div class="feedback-title">${escapeHTML(title)}</div>
      <div class="feedback-body">${escapeHTML(body)}</div>
    `;
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function revealNextHint() {
    if (!appState.game.currentPuzzle) return;
    const puzzle = appState.game.currentPuzzle;
    const hints = puzzle.hints || [];

    if (appState.game.revealedHints >= hints.length) {
      showToast('All available hints have already been revealed!', 'info');
      return;
    }

    const nextHintText = hints[appState.game.revealedHints];
    appState.game.revealedHints++;

    const hintsCard = document.getElementById('game-hints-card');
    const hintsList = document.getElementById('hints-display-list');

    if (hintsCard) hintsCard.style.display = 'flex';
    if (hintsList) {
      const hintEl = document.createElement('div');
      hintEl.className = 'hint-item';
      hintEl.innerHTML = `
        <span class="hint-stage-label">Hint ${appState.game.revealedHints} of ${hints.length}</span>
        <span>${escapeHTML(nextHintText)}</span>
      `;
      hintsList.appendChild(hintEl);
      hintEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    playClickSound();
  }

  function revealGameSolution() {
    if (!appState.game.currentPuzzle) return;
    const puzzle = appState.game.currentPuzzle;
    const box = document.getElementById('game-revealed-solution');
    const textEl = document.getElementById('revealed-solution-equation');
    const stepsEl = document.getElementById('revealed-solution-steps');

    if (!box || !textEl) return;

    box.classList.add('active');
    textEl.textContent = `${formatMathDisplay(puzzle.solutionExpr)} = ${puzzle.target}`;

    if (stepsEl && puzzle.steps) {
      stepsEl.innerHTML = `
        <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Guaranteed Solution Steps:</div>
        ${puzzle.steps.map((st, i) => `<div>${i + 1}. ${formatMathDisplay(st.stepDesc)}</div>`).join('')}
      `;
    }

    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    playClickSound();
    showToast('Solution revealed!');
  }

  /* ==========================================================================
     MODALS: STATS, HISTORY, HOW TO PLAY
     ========================================================================== */

  function setupModals() {
    const modalStats = document.getElementById('modal-stats');
    const modalHistory = document.getElementById('modal-history');
    const modalRules = document.getElementById('modal-rules');

    const btnOpenStats = document.getElementById('nav-btn-stats');
    const btnOpenHistory = document.getElementById('nav-btn-history');
    const btnOpenRules = document.getElementById('nav-btn-rules');

    if (btnOpenStats) {
      btnOpenStats.addEventListener('click', () => {
        populateStatsModal();
        openModal(modalStats);
      });
    }

    if (btnOpenHistory) {
      btnOpenHistory.addEventListener('click', () => {
        populateHistoryModal();
        openModal(modalHistory);
      });
    }

    if (btnOpenRules) {
      btnOpenRules.addEventListener('click', () => {
        openModal(modalRules);
      });
    }

    // Modal Close Buttons
    document.querySelectorAll('.modal-close-btn, .modal-close-action').forEach(btn => {
      btn.addEventListener('click', () => {
        closeAllModals();
      });
    });

    // Close on overlay backdrop click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          closeAllModals();
        }
      });
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllModals();
      }
    });

    // Clear history button
    const clearHistBtn = document.getElementById('btn-clear-history');
    if (clearHistBtn) {
      clearHistBtn.addEventListener('click', () => {
        appState.history = [];
        localStorage.removeItem(STORAGE_KEYS.HISTORY);
        populateHistoryModal();
        showToast('History cleared');
      });
    }
  }

  function openModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.add('active');
    playClickSound();
  }

  function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    playClickSound();
  }

  function populateStatsModal() {
    const s = appState.stats;
    const rate = s.attempted > 0 ? Math.round((s.solved / s.attempted) * 100) : 0;

    const elAttempted = document.getElementById('stat-attempted');
    const elSolved = document.getElementById('stat-solved');
    const elStreak = document.getElementById('stat-streak');
    const elBestStreak = document.getElementById('stat-best-streak');
    const elRate = document.getElementById('stat-win-rate');

    if (elAttempted) elAttempted.textContent = s.attempted;
    if (elSolved) elSolved.textContent = s.solved;
    if (elStreak) elStreak.textContent = s.currentStreak;
    if (elBestStreak) elBestStreak.textContent = s.bestStreak;
    if (elRate) elRate.textContent = `${rate}%`;
  }

  function populateHistoryModal() {
    const list = document.getElementById('history-items-list');
    if (!list) return;

    if (appState.history.length === 0) {
      list.innerHTML = '<div style="color: var(--text-muted); font-style: italic; text-align: center; padding: 24px;">No solved puzzles recorded yet.</div>';
      return;
    }

    list.innerHTML = appState.history.map(item => `
      <div class="history-item">
        <div class="history-item-top">
          <span class="history-target">Target: ${item.target} (${item.mode})</span>
          <span>${escapeHTML(item.timestamp)}</span>
        </div>
        <div class="history-eq">${escapeHTML(item.equation)}</div>
        <div style="font-size: 12px; color: var(--text-muted);">
          Numbers: [ ${item.numbers.join(', ')} ] • ${item.exact ? '<span style="color:#34d399; font-weight:700;">Exact ✓</span>' : `<span style="color:#fbbf24;">Diff: ${item.diff}</span>`}
        </div>
      </div>
    `).join('');
  }

  function updateHeaderStatsBadge() {
    const badge = document.getElementById('header-streak-count');
    if (badge) {
      badge.textContent = appState.stats.currentStreak > 0 ? `🔥 ${appState.stats.currentStreak}` : '';
    }
  }

  /* Initialize on DOM content loaded */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();
