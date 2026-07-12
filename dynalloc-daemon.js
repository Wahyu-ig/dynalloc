#!/usr/bin/env node
/**
 * =============================================================================
 *  DynAlloc v1.0 — Adaptive Linux Resource Manager
 * =============================================================================
 *
 *  A lightweight Linux daemon that monitors Pressure Stall Information (PSI),
 *  classifies processes, and dynamically manages CPU affinity, niceness,
 *  I/O priority, cgroups, CPU governor, and OOM protection.
 *
 *  v2.0 Features:
 *    - Multi-level scheduler (Realtime/Interactive/Multimedia/Background/Idle)
 *    - Process classifier (Game, Browser, IDE, Compiler, etc.)
 *    - Multimedia detector (PipeWire, PulseAudio, media players)
 *    - CPU topology awareness (SMT, NUMA, Intel Hybrid P-Core/E-Core, AMD CCD)
 *    - CPU history with moving average
 *    - Hysteresis to prevent rapid state thrashing
 *    - Auto-restore of throttled processes when stress ends
 *    - Adaptive scheduler (CPU, memory, foreground, media, battery, thermal)
 *    - Event-driven focus detection via D-Bus
 *
 *  Configuration (in priority order):
 *    1. $DYNALLOC_CONFIG_PATH
 *    2. ~/.config/dynalloc/config.json
 *    3. /etc/dynalloc/config.json
 *    4. Built-in defaults (non-fatal if no config found)
 *
 *  Usage:
 *    DYNALLOC_DRY_RUN=1 node dynalloc-daemon.js   # safe dry-run mode
 *    node dynalloc-daemon.js                        # live mode
 *
 *  Requires CAP_SYS_NICE for renice/ionice or run as root/system service.
 *
 * =============================================================================
 */

'use strict';

require('./daemon').start();
