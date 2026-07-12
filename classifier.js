'use strict';

/**
 * DynAlloc — Process Classifier Module
 *
 * Classifies processes into categories for the multi-level scheduler.
 *
 * v2.1: Cache eviction fix, no dead code, proper encapsulation.
 * v2.1.1: Fixed Python pattern (\s made it never match real comm names);
 *         moved `require('fs')` to top of file (was at line 310, after
 *         functions that used it — worked at runtime but fragile).
 */

const fs = require('fs');

// ── Process name patterns ────────────────────────────────────────────

const PATTERNS = {
  GAME: [
    /^(SteamApp|steamwebhelper|steam_shutdow)/i,
    /^(UnityPlayer|unity-editor)/i,
    /^(godot|godot_server)/i,
  ],

  BROWSER: [
    /^(firefox|firefox-esr|firefox-bin)$/,
    /^(chrome|chromium|chromium-browser|brave|brave-browser|vivaldi|opera|edge|msedge)$/,
    /^(chrome-crashpad-handler|chromium-crashpad-handler)$/,
    /^(com\.brave\.Browser|org\.chromium\.chromium|org\.mozilla\.firefox)/,
  ],

  IDE: [
    /^(code|codium|code-insiders|code-oss|cursor|windsurf)$/,
    /^(idea|clion|goland|rustrover|datagrip|pycharm|webstorm|phpstorm)$/,
    /^(sublime_text|subl)$/,
    /^(vim|nvim|gvim|neovim)$/,
    /^(emacs|emacs-\d+|emacs-gtk)$/,
    /^(kate|kdevelop|geany|mousepad|xed|pluma|gedit|gnome-text-editor)$/,
    /^(jetbrains-|jetbrains_client)/i,
  ],

  COMPILER: [
    /^(cc1|cc1plus|ld\.gold|ld\.bfd|ld|collect2)$/,
    /^(rustc|cargo|rust-analyzer)$/,
    /^(clang|clang\+\+|clangd)$/,
    /^(gcc|g\+\+|cc|c\+\+)$/,
    /^(make|cmake|ninja|bear|ccache)$/,
    /^(java|javac|gradle|maven|mvn|ant)$/,
    /^(node|deno|bun|tsx|esbuild|vite|webpack|rollup|tsc|tsserver|babel)$/,
    /^(go|gopls|cargo-build)$/,
    // BUG FIX (v2.1.1): Previously this was `/^(pip|pip3|python3?\s|python)$/`,
    // which required whitespace after `python3?`. Process comm names
    // (e.g. "python3") never contain whitespace, so the pattern never
    // matched and Python build scripts (pip install, setup.py) were
    // classified as UNKNOWN -> IDLE class -> niceness 19.
    /^(pip|pip3|python3?|python)$/,
    /^(gem|bundle|rake|rbs)$/,
  ],

  AUDIO: [
    /^(spotify|spotifyd|ncspot)$/i,
    /^(audacity|audacity-bin)$/i,
    /^(amarok|clementine|strawberry|rhythmbox|pragha)$/i,
    /^(mpd|ncmpcpp|cmus|mocp|mpc)$/i,
    /^(pavucontrol|helvum|qpwgraph)$/i,
  ],

  VIDEO: [
    /^(mpv|mpv\.net)$/i,
    /^(vlc|vlc-wrapper)$/i,
    /^(celluloid|parole|totem|gnome-videos)$/i,
    /^(smplayer|dragon|haruna)$/i,
  ],

  STREAMING: [
    /^(obs|obs-studio|obs64)$/i,
    /^(discord|Discord|discord-canary|discord-ptb)$/i,
    /^(teamspeak3|ts3client|TeamSpeak3)$/i,
    /^(mumble|Mumble)$/i,
    /^(zoom|Zoom)$/i,
    /^(skype|Skype)$/i,
  ],

  WALLPAPER: [
    /^mpvpaper$/i,
    /^xwinwrap$/i,
    /^swww$/i,
    /^hyprpaper$/i,
    /^swaybg$/i,
    /^nitrogen$/i,
    /^feh$/i,
    /^wpaperd$/i,
    /^glpaper$/i,
    /^wallpaper-engine-kde$/i,
    /gnome-video-wallpaper/i,
  ],

  CONTAINER: [
    /^(dockerd|docker-containerd|containerd|ctr)$/i,
    /^(podman|podman-remote)$/i,
    /^(lxc|lxd|lxcfs)$/i,
    /^(runc|crun|kata-runtime)$/i,
    /^(buildah|buildkitd|nerdctl)$/i,
  ],

  VM: [
    /^(qemu-system|qemu-kvm|qemu-i386|qemu-x86_64)/i,
    /^(virt-manager|virtqemud|libvirtd)$/i,
    /^(vboxheadless|VirtualBoxVM|VBoxHeadless)$/i,
    /^(vmware|vmware-vmx)$/i,
  ],

  STEAM: [
    /^steam$/i,
    /^steamwebhelper$/i,
    /^steamcmd$/i,
    /^steam\-shutdow$/i,
  ],

  LUTRIS: [
    /^lutris$/i,
    /^lutris-wrapper$/i,
  ],

  WINE: [
    /^(wine|wine64|wine-server|wineserver|wineboot|winecfg)$/i,
    /^(wine-preloader|wine64-preloader)$/i,
  ],

  PROTON: [
    /^proton$/i,
    /^proton\-waitforexit$/i,
    /^proton\-score$/i,
  ],

  FLATPAK: [
    /^flatpak$/i,
    /^bwrap$/i,
  ],

  SNAP: [
    /^snapd$/i,
    /^snap$/i,
  ],

  SYSTEM: [
    /^(systemd|systemd-|systemd\+)/i,
    /^(dbus-daemon|dbus-broker|dbus-daemon-launch)$/i,
    /^(Xorg|Xwayland|Xvnc)$/i,
    /^(gnome-shell|mutter|gnome-session|gnome-control-center)$/i,
    /^(kwin_x11|kwin_wayland|kwin_no_kwin|plasmashell|plasma-desktop|ksmserver)$/i,
    /^(pipewire|pipewire-pulse|wireplumber|pulseaudio|pipewire-0|pipewire-1)$/i,
    /^(NetworkManager|wpa_supplicant|systemd-networkd|systemd-resolved|connmand)$/i,
    /^(sddm|gdm|gdm3|gdm-wayland-session|lightdm)$/i,
    /^(polkitd|accounts-daemon|colord|rngd|irqbalance|udisksd|upowerd)$/i,
    /^(gamemoded|gamescope|gamescopem)$/i,
    /^(crond|atd|sshd|cupsd|cups-browsed|avahi-daemon|bluetoothd)$/i,
    /^(journald|systemd-journald|systemd-logind|systemd-udevd|systemd-tmpfiles)$/i,
  ],

  DAEMON: [
    /^(rsyslogd|syslogd|syslog-ng)$/i,
    /^(cron|anacron|incron)$/i,
    /^(dockerd|containerd|podman|snapd)$/i,
    /^(irqbalance|tuned|power-profiles-daemon)$/i,
  ],

  TERMINAL: [
    /^kgx$/i,                                    // GNOME Console
    /^gnome-terminal-server$/i,
    /^(gnome-terminal|konsole|xterm|urxvt|rxvt)$/i,
    /^(alacritty|kitty|wezterm|wezterm-gui)$/i,
    /^(foot|footclient)$/i,
    /^(terminator|tilix|terminology)$/i,
    /^(xfce4-terminal|lxterminal|mate-terminal|deepin-terminal)$/i,
    /^(st|st-256color)$/i,
    /^(warp|warp-terminal)$/i,
  ],
};

// ── Electron app detection ────────────────────────────────────────────

const ELECTRON_PARENT_PATTERNS = [
  /^(code|codium|cursor|windsurf|discord|Discord|slack|Teams|Notion|figma|obsidian|insomnia)$/i,
];

// ── Classification cache ─────────────────────────────────────────────

const _classifyCache = new Map();
const CLASSIFY_CACHE_MAX = 4096;
const CLASSIFY_CACHE_TTL_MS = 30000;

// ── Scheduler class mapping ──────────────────────────────────────────

const CATEGORY_TO_SCHED_CLASS = {
  SYSTEM:     'REALTIME',
  DAEMON:     'REALTIME',
  GAME:       'INTERACTIVE',
  IDE:        'INTERACTIVE',
  BROWSER:    'INTERACTIVE',
  TERMINAL:   'INTERACTIVE',
  ELECTRON:   'INTERACTIVE',
  AUDIO:      'MULTIMEDIA',
  VIDEO:      'MULTIMEDIA',
  STREAMING:  'MULTIMEDIA',
  WALLPAPER:  'MULTIMEDIA',
  COMPILER:   'BACKGROUND',
  STEAM:      'BACKGROUND',
  LUTRIS:     'BACKGROUND',
  WINE:       'BACKGROUND',
  PROTON:     'BACKGROUND',
  CONTAINER:  'BACKGROUND',
  VM:         'BACKGROUND',
  FLATPAK:    'BACKGROUND',
  SNAP:       'BACKGROUND',
  UNKNOWN:    'IDLE',
};

// ── Public API ───────────────────────────────────────────────────────

function classifyByComm(comm) {
  if (typeof comm !== 'string') return 'UNKNOWN';

  const cached = _classifyCache.get(comm);
  if (cached && (Date.now() - cached.ts) < CLASSIFY_CACHE_TTL_MS) {
    return cached.category;
  }

  const priorityOrder = [
    'SYSTEM', 'DAEMON', 'GAME', 'BROWSER', 'IDE', 'TERMINAL', 'COMPILER',
    'VIDEO', 'AUDIO', 'STREAMING', 'WALLPAPER',
    'CONTAINER', 'VM',
    'STEAM', 'LUTRIS', 'WINE', 'PROTON',
    'FLATPAK', 'SNAP',
  ];

  for (const category of priorityOrder) {
    const patterns = PATTERNS[category];
    if (!patterns) continue;
    for (const re of patterns) {
      if (re.test(comm)) {
        _putCache(comm, category);
        return category;
      }
    }
  }

  _putCache(comm, 'UNKNOWN');
  return 'UNKNOWN';
}

function classifyElectronChild(childComm, parentComm) {
  if (ELECTRON_PARENT_PATTERNS.some((re) => re.test(parentComm))) {
    return 'ELECTRON';
  }
  return classifyByComm(childComm);
}

function categoryToSchedulerClass(category) {
  return CATEGORY_TO_SCHED_CLASS[category] || 'IDLE';
}

function schedulerClassPriority(schedClass, config) {
  const key = `SCHEDULER_CLASS_${schedClass}_PRIORITY`;
  return config[key] || 10;
}

function schedulerClassNice(schedClass, config) {
  const key = `SCHEDULER_CLASS_${schedClass}_NICE`;
  return config[key] || 0;
}

function schedulerClassIoPrio(schedClass, config) {
  const key = `SCHEDULER_CLASS_${schedClass}_IOPRIO`;
  return config[key] || [2, 4];
}

function isRealtime(category) {
  return categoryToSchedulerClass(category) === 'REALTIME';
}

function isMultimedia(category) {
  return categoryToSchedulerClass(category) === 'MULTIMEDIA';
}

function isProtected(category) {
  const cls = categoryToSchedulerClass(category);
  return cls === 'REALTIME' || cls === 'MULTIMEDIA';
}

function isFlatpakProcess(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    const cgroupRaw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    return cgroupRaw.includes('flatpak');
  } catch (_) {
    return false;
  }
}

function isSnapProcess(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    const cgroupRaw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    return cgroupRaw.includes('snap');
  } catch (_) {
    return false;
  }
}

function _putCache(comm, category) {
  if (_classifyCache.size >= CLASSIFY_CACHE_MAX) {
    // Evict all expired entries first
    const now = Date.now();
    for (const [key, val] of _classifyCache) {
      if (now - val.ts > CLASSIFY_CACHE_TTL_MS) {
        _classifyCache.delete(key);
      }
    }
    // If still full, evict oldest
    if (_classifyCache.size >= CLASSIFY_CACHE_MAX) {
      const firstKey = _classifyCache.keys().next().value;
      if (firstKey !== undefined) _classifyCache.delete(firstKey);
    }
  }
  _classifyCache.set(comm, { category, ts: Date.now() });
}

function clearCache() {
  _classifyCache.clear();
}

module.exports = {
  PATTERNS,
  CATEGORY_TO_SCHED_CLASS,
  classifyByComm,
  classifyElectronChild,
  categoryToSchedulerClass,
  schedulerClassPriority,
  schedulerClassNice,
  schedulerClassIoPrio,
  isRealtime,
  isMultimedia,
  isProtected,
  isFlatpakProcess,
  isSnapProcess,
  clearCache,
};