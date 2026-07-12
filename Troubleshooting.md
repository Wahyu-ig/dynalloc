# Troubleshooting

## PSI Not Available

**Symptoms:**
- Self-check reports: `PSI: cpu=false mem=false`
- Log message: "PSI tidak tersedia — scheduler tidak bisa membaca pressure"
- No throttling ever occurs

**Causes:**
- Kernel older than 5.2 (PSI was introduced in Linux 5.2).
- PSI disabled via kernel boot parameter (`psi=0`).
- Running in a container or VM that doesn't expose `/proc/pressure/`.

**Fix:**
1. Check kernel version: `uname -r` — must be 5.2+.
2. Verify PSI files exist: `cat /proc/pressure/cpu` and `cat /proc/pressure/memory`.
3. Check kernel parameters: `cat /proc/cmdline | grep psi`.
4. If in a container, ensure `/proc/pressure/` is mounted.

**Daemon behavior:** When PSI is unavailable, the daemon automatically sets all thresholds to 999 (effectively disabling throttling) and continues running without errors.

## Cgroups Not Accessible

**Symptoms:**
- Log: "Cgroups v2 tidak terdeteksi/tidak bisa diakses" or "Cgroups v2 (controller "cpu") tidak terdeteksi"
- Self-check: `Cgroups v2: available=false`
- Log: "Resource control: taskset+renice (fallback)"

**Causes:**
- Cgroups v2 not mounted or system uses cgroups v1.
- No `cpu` controller available in the cgroup.
- Insufficient permissions to write to cgroup files.

**Fix:**
1. Verify cgroups v2: `cat /sys/fs/cgroup/cgroup.controllers` — should list `cpu`.
2. Check if you're in a cgroup with cpu delegation. For `systemctl --user`, systemd must delegate the cpu controller.
3. If cgroups are unavailable, the daemon automatically falls back to `taskset` + `renice` + `ionice`. This works but is less precise than cgroup cpu.weight/cpu.max.

**Cgroup delegation for user services:**
Add to `/etc/systemd/system/user@.service.d/delegate.conf`:
```ini
[Service]
Delegate=cpu
```
Then: `sudo systemctl daemon-reload`

## Governor Switch Fails

**Symptoms:**
- Log: "Gagal eksekusi 'cpupower ...': ..."
- CPU governor does not change when boosting
- Self-check: `cpufreq: not available` or `governor: not available`

**Causes:**
- `cpupower` not installed.
- `scaling_governor` sysfs is root-only and the daemon runs as a non-root user.
- `intel_pstate` or `amd_pstate` in passive mode restricts governor changes.
- Kernel parameter `intel_pstate=passive` or no `cpufreq` support.

**Fix:**
1. Install cpupower: `sudo apt install linux-tools-common linux-tools-$(uname -r)` (Debian/Ubuntu) or `sudo dnf install kernel-tools` (Fedora).
2. For user services, enable `GOVERNOR_USE_SUDO: true` and add a sudoers rule:
   ```
   youruser ALL=(root) NOPASSWD: /usr/bin/cpupower
   ```
3. Verify governor is writable: `cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors`.
4. If using `intel_pstate=active`, only `performance` and `powersave` may be available.

**Daemon behavior:** If cpufreq is unavailable, the daemon sets `ENABLE_GOVERNOR_SWITCH = false` and logs a warning. All other features continue normally.

## D-Bus Focus Detection Issues

**Symptoms on GNOME/Wayland:**
- Log: "Event-driven focus hanya tersedia untuk GNOME/Wayland, memakai polling"
- Or: "Gagal subscribe sinyal D-Bus fokus, fallback ke polling fokus"

**Causes:**
- Not running GNOME on Wayland (e.g., using X11, KDE, Sway).
- D-Bus session bus not available.
- `gdbus` not installed.

**Fix:**
1. Verify desktop: `echo $XDG_CURRENT_DESKTOP` and `echo $XDG_SESSION_TYPE`.
2. Test gdbus: `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval 'Meta.prefs_get_theme_name()'`
3. If D-Bus focus fails, the daemon automatically falls back to polling (`gdbus call` or `xdotool` depending on the session).

**GNOME Extension Requirement (polling mode):**
For GNOME/Wayland polling to work, the **"Window Calls Extended"** GNOME Shell extension must be installed. Without it, focus detection falls back to `xdotool` (which doesn't work on Wayland), resulting in no foreground detection.

## Permission Problems

### CAP_SYS_NICE (renice / ionice)

**Symptoms:**
- Log: "Gagal eksekusi 'renice ...': Permission denied"
- Self-check: `Permissions: canRenice=false canIonice=false`

**Fix:** The daemon needs `CAP_SYS_NICE`. Options:
1. Run as root: `sudo node dynalloc-daemon.js`
2. Run as a system service (systemd grants capabilities):
   ```ini
   [Service]
   AmbientCapabilities=CAP_SYS_NICE
   ```
3. Set the capability on the Node binary:
   ```bash
   sudo setcap cap_sys_nice+ep $(which node)
   ```

### Cgroup Delegation

**Symptoms:**
- Self-check: `Permissions: canCgroupWrite=false`
- Log: "Cgroups v2 (controller 'cpu') tidak terdeteksi"

**Fix:** For `systemctl --user`, ensure systemd delegates the cpu controller. See the cgroups section above. For system services running as root, this should work by default.

## Feral GameMode Conflicts

**Symptoms:**
- Log: "GameMode Feral aktif untuk PID ... — DynAlloc tidak mengubah niceness/governor"
- Game performance inconsistent

**Explanation:** When `ENABLE_GAMEMODE_COEXIST` is `true` (default), DynAlloc detects if Feral GameMode is active for a foreground PID. If so, it skips niceness and governor changes to avoid conflicting with GameMode's own optimizations. Core pinning, cgroup assignment, and OOM protection are still applied.

**If you see conflicts:**
1. Set `ENABLE_GAMEMODE_COEXIST: false` — DynAlloc will manage everything, potentially conflicting with GameMode.
2. Or disable GameMode for the specific game if DynAlloc's management is preferred.

## Debug Mode

To diagnose issues, enable maximum logging:

```bash
DYNALLOC_DRY_RUN=1 DYNALLOC_LOG_LEVEL=trace node dynalloc-daemon.js
```

This produces:
- `[TRACE]` messages showing every system command that would be executed.
- `[DRY_RUN]` annotations confirming no actual changes are made.
- Full config loading details.
- Regex compilation and matching details.

For persistent logging to a file, add to config:
```json
{
  "LOG_LEVEL": "debug",
  "LOG_FILE_PATH": "/tmp/dynalloc-debug.log",
  "LOG_FILE_MAX_SIZE_MB": 50,
  "LOG_FILE_MAX_FILES": 5
}
```

Or set `ENABLE_SELF_CHECK: true` (on by default) to always see the capability report on startup.

## Log Interpretation

### Log Format

```
[2024-01-15T10:30:00.123Z] [INFO ] [pid:12345] [NORMAL] Message here
```

- **Timestamp**: ISO 8601 UTC
- **Level**: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (right-padded to 5 chars)
- **PID**: daemon process ID
- **Scheduler state**: current stress level in brackets (shown when set by daemon)

### Key Log Messages

| Log Message | Meaning |
|---|---|
| `Mode: DRY_RUN (aman)` | Dry-run is active — no system changes will be made. |
| `Stress level: NORMAL -> WARN` | Scheduler transitioned due to PSI or adaptive score. |
| `Auto-restore: mengembalikan N proses ke normal` | Throttled processes restored as stress resolved. |
| `Foreground berganti: A -> B` | New window focused; previous foreground restored, new one boosted. |
| `THROTTLE background "chrome" PID 1234` | Process being pinned to background cores / moved to background cgroup. |
| `RESTORE PID 1234 -> normal` | Process restored to all cores, nice 0, default ioprio. |
| `Boost aktif untuk PID 1234` | Foreground process received priority boost. |
| `GameMode Feral aktif untuk PID ...` | GameMode detected — niceness/governor skipped. |
| `Cgroups v2 siap: ...` | Cgroups v2 successfully set up. |
| `Cgroups v2 ... fallback ke taskset+renice` | Cgroups unavailable, using fallback. |
| `Config berhasil di-reload` | Hot-reload completed successfully. |
| `Gagal eksekusi ...` | A system command failed (usually a permission issue). |

## Config File Not Found

**Symptoms:** Daemon starts but uses all defaults.

**Fix:** Copy the example config:
```bash
mkdir -p ~/.config/dynalloc
cp dynalloc.config.example.json ~/.config/dynalloc/config.json
```

Or point to a specific file:
```bash
DYNALLOC_CONFIG_PATH=/path/to/my-config.json node dynalloc-daemon.js
```

## Daemon Doesn't Start

**Symptoms:** Process exits immediately.

**Check:**
1. Node.js version: `node --version` — requires 16+.
2. All files present: `ls daemon.js scheduler.js sensor.js actuator.js classifier.js config.js governor.js logger.js multimedia.js cpu-topology.js metrics.js plugin-manager.js self-check.js rollback.js dynalloc-daemon.js`.
3. No syntax errors: `node -c dynalloc-daemon.js`.
4. Check for unhandled errors in logs at the `FATAL` level.