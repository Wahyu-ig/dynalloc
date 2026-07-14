# DynAlloc v2.1.0 — Panduan Instalasi Lengkap

> AI-Powered Adaptive Linux Resource Manager

---

## Daftar Isi

1. [Prasyarat Sistem](#1-prasyarat-sistem)
2. [Persiapan Kernel (PSI)](#2-persiapan-kernel-psi)
3. [Instalasi Manual (Recommended)](#3-instalasi-manual)
4. [Instalasi via Package Manager](#4-instalasi-via-package-manager)
   - [4.1 Arch Linux / AUR](#41-arch-linux--aur)
   - [4.2 Debian / Ubuntu (.deb)](#42-debian--ubuntu-deb)
   - [4.3 Fedora / RHEL (.rpm)](#43-fedora--rhel-rpm)
5. [Konfigurasi Service (systemd)](#5-konfigurasi-service-systemd)
6. [File Konfigurasi](#6-file-konfigurasi)
7. [Mengaktifkan Fitur v2.1.0 Tier 1](#7-mengaktifkan-fitur-v210-tier-1)
   - [7.1 Predictive Pre-Allocation Engine](#71-predictive-pre-allocation-engine)
   - [7.2 Per-App Energy Accounting (RAPL)](#72-per-app-energy-accounting-rapl)
   - [7.3 CPU+GPU Shared Power Budget Arbiter](#73-cpugpu-shared-power-budget-arbiter)
   - [7.4 GPU VRAM Pressure Reclaim](#74-gpu-vram-pressure-reclaim)
8. [Setup Privilege (Non-Root)](#8-setup-privilege-non-root)
9. [Verifikasi Instalasi](#9-verifikasi-instalasi)
10. [CLI Reference](#10-cli-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Uninstall](#12-uninstall)

---

## 1. Prasyarat Sistem

### Minimum

| Kebutuhan | Versi Minimum | Cara Cek |
|-----------|---------------|----------|
| Linux Kernel | >= 5.2 | `uname -r` |
| Node.js | >= 18.0.0 | `node --version` |
| PSI Support | Enabled | `cat /proc/pressure/cpu` |

### Opsional (Rekomendasi)

| Paket | Fungsi | Distro |
|-------|--------|--------|
| `cgroup-tools` / `libcgroup-tools` | cgroups v2 management | Semua |
| `cpufrequtils` / `kernel-tools` | CPU governor switching | Debian/Fedora |
| `xdotool` | Foreground detection (X11) | Semua |
| `gdbus` (dari `glib2`) | Foreground detection (GNOME Wayland) | Semua |
| `libnotify` / `notify-utils` | Desktop notifications | Semua |
| `power-profiles-daemon` | PPD coordination | Semua |
| `pipewire` + `wireplumber` | Multimedia detection | Semua |
| `gamemode` | Feral GameMode coexistence | Semua |
| `nvidia-utils` | GPU control + VRAM monitoring | NVIDIA |
| `hyprland` | Foreground detection (Hyprland) | Arch |
| `sway` | Foreground detection (Sway) | Semua |

### Cek Node.js

```bash
node --version
# Minimal: v18.0.0+

# Kalau belum ada atau versi lama:
# Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Fedora:
sudo dnf install nodejs

# Arch:
sudo pacman -S nodejs
```

### Cek PSI Support

```bash
# Harusnya keluar angka, bukan error
cat /proc/pressure/cpu
cat /proc/pressure/memory

# Kalau error "No such file", tambahin ke GRUB:
# sudo nano /etc/default/grub
#   GRUB_CMDLINE_LINUX="psi=1"
# sudo update-grub
# sudo reboot
```

---

## 2. Persiapan Kernel (PSI)

DynAlloc bergantung pada **Pressure Stall Information (PSI)** untuk menentukan
stress level sistem. PSI harus aktif di kernel.

### Cek apakah PSI aktif

```bash
# Kalau ini keluar angka, PSI sudah aktif — lanjut ke bagian 3
cat /proc/pressure/cpu

# Contoh output yang benar:
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### Aktifkan PSI (kalau belum)

```bash
# 1. Edit GRUB config
sudo nano /etc/default/grub

# 2. Tambahin "psi=1" ke baris GRUB_CMDLINE_LINUX_DEFAULT
#    Sebelum:
#      GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"
#    Sesudah:
#      GRUB_CMDLINE_LINUX_DEFAULT="quiet splash psi=1"

# 3. Update GRUB
# Ubuntu/Debian:
sudo update-grub

# Fedora (UEFI):
sudo grub2-mkconfig -o /boot/grub2/grub.cfg
# Fedora (BIOS):
sudo grub2-mkconfig -o /boot/grub2/grub.cfg

# Arch:
sudo grub-mkconfig -o /boot/grub/grub.cfg

# 4. Reboot
sudo reboot

# 5. Verifikasi
cat /proc/pressure/cpu
```

### Cek cgroups v2

```bash
# Harusnya mount point-nya ada
mount | grep cgroup2

# Atau cek file existence
ls /sys/fs/cgroup/cgroup.controllers
```

---

## 3. Instalasi Manual

Cara ini install langsung dari source ke `/opt/dynalloc` tanpa package manager.
Recommended kalau kamu mau kontrol penuh atau distro-mu gak punya package.

### 3.1 Download Source

```bash
# Dari GitHub release (ganti URL kalau versi beda):
cd /tmp
wget https://github.com/Wahyu-ig/dynalloc/archive/refs/tags/v2.1.0.tar.gz
tar xzf v2.1.0.tar.gz
cd dynalloc-2.1.0

# Atau dari file lokal:
# cd /path/ke/dynalloc-2.1.0
```

### 3.2 Jalankan Install Script

```bash
# Dry-run dulu buat lihat apa yang akan di-install (opsional):
./install.sh --dry-run

# Install sebenarnya:
sudo ./install.sh

# Install ke lokasi kustom:
sudo ./install.sh --prefix /usr/local/lib/dynalloc
```

Script ini akan:
1. Cek Node.js >= 18
2. Buat directory `/opt/dynalloc/` beserta semua subdirectory
3. Copy semua file `.js`, `.json`, `.sh`, `.md`
4. Buat symlink `/usr/local/bin/dynalloc` dan `/usr/local/bin/dynalloc-daemon`
5. Install systemd user service ke `/usr/lib/systemd/user/`
6. Set CAP_SYS_NICE pada `renice` dan `ionice`
7. Buat `/etc/dynalloc/` dengan config example

### 3.3 Install Manual (Tanpa Script)

Kalau mau install manual langkah demi langkah:

```bash
# Set SOURCE ke directory source dynalloc-mu
SOURCE="/tmp/dynalloc-2.1.0"
DEST="/opt/dynalloc"

# Buat semua directory
sudo mkdir -p $DEST/{policy-engine,plugins,systemd,detectors,profiles,adaptive,recognition,monitoring,sdk,intelligence,lib/controllers}

# Copy semua file JS, JSON, SH dari root
sudo cp -a $SOURCE/*.js $SOURCE/*.json $SOURCE/*.sh $DEST/

# Copy semua subdirectory
for dir in policy-engine plugins detectors profiles adaptive recognition monitoring sdk intelligence; do
  sudo cp -a $SOURCE/$dir/*.js $DEST/$dir/ 2>/dev/null
done
sudo cp -a $SOURCE/lib/*.js $DEST/lib/
sudo cp -a $SOURCE/lib/controllers/*.js $DEST/lib/controllers/

# Copy dokumentasi
sudo cp -a $SOURCE/*.md $DEST/ 2>/dev/null

# Buat executable
sudo chmod +x $DEST/dynalloc-cli.js $DEST/dynalloc-daemon.js
[ -f $DEST/dynalloc-start.sh ] && sudo chmod +x $DEST/dynalloc-start.sh

# Buat symlink CLI
sudo ln -sf $DEST/dynalloc-cli.js /usr/local/bin/dynalloc
sudo ln -sf $DEST/dynalloc-daemon.js /usr/local/bin/dynalloc-daemon

# Install systemd user service
sudo mkdir -p /usr/lib/systemd/user
sudo cp $SOURCE/systemd/dynalloc.service /usr/lib/systemd/user/

# Buat config directory
sudo mkdir -p /etc/dynalloc

# Verifikasi
ls -la /usr/local/bin/dynalloc
ls -la $DEST/intelligence/predictive-engine.js
ls -la $DEST/lib/controllers/vram-reclaim-controller.js
```

### 3.4 Verifikasi File Terinstall

```bash
# Cek CLI bisa diakses
dynalloc --version 2>/dev/null || node /opt/dynalloc/dynalloc-cli.js --version

# Cek semua file penting ada
echo "Cek file kritikal v2.1.0..."
for f in \
  /opt/dynalloc/dynalloc-daemon.js \
  /opt/dynalloc/dynalloc-cli.js \
  /opt/dynalloc/intelligence/predictive-engine.js \
  /opt/dynalloc/intelligence/learning-engine.js \
  /opt/dynalloc/lib/energy-accountant.js \
  /opt/dynalloc/lib/controllers/power-budget-arbiter.js \
  /opt/dynalloc/lib/controllers/vram-reclaim-controller.js \
  /opt/dynalloc/lib/controllers/gpu-controller.js; do
  if [ -f "$f" ]; then
    echo "  OK  $f"
  else
    echo "  MISSING  $f"
  fi
done
```

---

## 4. Instalasi via Package Manager

### 4.1 Arch Linux / AUR

```bash
# Dari AUR (kalau sudah di-publish):
yay -S dynalloc
# atau
paru -S dynalloc

# Build dari source lokal:
cd /path/ke/dynalloc-2.1.0/packaging
make arch

# Atau langsung pakai makepkg:
cd /path/ke/dynalloc-2.1.0/packaging/arch
makepkg -si
```

### 4.2 Debian / Ubuntu (.deb)

```bash
# Build dari source:
cd /path/ke/dynalloc-2.1.0/packaging
make deb

# Install package yang dihasilkan:
sudo dpkg -i build/deb/dynalloc_2.1.0-1_all.deb

# Kalau ada dependency yang kurang:
sudo apt install -f
```

### 4.3 Fedora / RHEL (.rpm)

```bash
# Install build tools (kalau belum ada):
sudo dnf install rpm-build

# Build dari source:
cd /path/ke/dynalloc-2.1.0/packaging
make rpm

# Install package:
sudo dnf install build/rpmbuild/RPMS/noarch/dynalloc-2.1.0-1.*.noarch.rpm
```

---

## 5. Konfigurasi Service (systemd)

DynAlloc berjalan sebagai **systemd user service** — bukan system service.
Ini penting supaya daemon punya akses ke D-Bus session bus untuk deteksi
foreground window di GNOME Wayland.

### 5.1 Setup Awal

```bash
# Copy service file ke user systemd directory
mkdir -p ~/.config/systemd/user
cp /opt/dynalloc/systemd/dynalloc.service ~/.config/systemd/user/

# Reload systemd
systemctl --user daemon-reload
```

### 5.2 Enable & Start

```bash
# Enable (auto-start saat login) + start sekarang
systemctl --user enable --now dynalloc.service

# Cek status
systemctl --user status dynalloc.service
```

### 5.3 Lihat Log

```bash
# Log real-time
journalctl --user -u dynalloc.service -f

# 50 baris terakhir
journalctl --user -u dynalloc.service --no-pager -n 50

# Filter per keyword
journalctl --user -u dynalloc.service --no-pager -n 100 | grep -i "predict\|energy\|vram\|error\|warn"
```

### 5.4 Manage Service

```bash
# Stop
systemctl --user stop dynalloc.service

# Start
systemctl --user start dynalloc.service

# Restart (required setelah edit config yang bukan hot-reloadable)
systemctl --user restart dynalloc.service

# Disable (gak auto-start saat login)
systemctl --user disable dynalloc.service

# Cek apakah enabled
systemctl --user is-enabled dynalloc.service
```

### 5.5 Linger (Run tanpa Login)

Kalau mau daemon jalan terus meskipun user gak login (misal server/headless):

```bash
sudo loginctl enable-linger $USER
```

---

## 6. File Konfigurasi

DynAlloc mencari config file di urutan berikut:

1. `$DYNALLOC_CONFIG_PATH` (environment variable)
2. `~/.config/dynalloc/config.json` (user config — **recommended**)
3. `/etc/dynalloc/config.json` (system config)

### 6.1 Buat Config User

```bash
# Buat directory config
mkdir -p ~/.config/dynalloc

# Copy dari example
cp /opt/dynalloc/dynalloc.config.example.json ~/.config/dynalloc/config.json

# Atau buat minimal config
cat > ~/.config/dynalloc/config.json << 'EOF'
{
  "LOG_LEVEL": "info",
  "ENABLE_CGROUPS_V2": true,
  "ENABLE_GOVERNOR_SWITCH": true,
  "ENABLE_EVENT_DRIVEN_FOCUS": true
}
EOF
```

### 6.2 Struktur Config Dasar

```json
{
  "DRY_RUN": false,
  "LOG_LEVEL": "info",
  "FAST_TICK_MS": 1000,
  "SLOW_TICK_MS": 3000,
  "PSI_CPU_WARN": 8.0,
  "PSI_CPU_CRITICAL": 20.0,
  "PSI_MEM_WARN": 4.0,
  "PSI_MEM_CRITICAL": 12.0,
  "ENABLE_CGROUPS_V2": true,
  "ENABLE_GOVERNOR_SWITCH": true,
  "GOVERNOR_BOOST": "performance",
  "ENABLE_EVENT_DRIVEN_FOCUS": true,
  "ENABLE_MULTIMEDIA_PROTECTION": true,
  "ENABLE_THERMAL_PROTECTION": true,
  "THERMAL_PAUSE_THRESHOLD": 85,
  "THERMAL_RESUME_THRESHOLD": 78,
  "HOT_RELOAD": true
}
```

### 6.3 Hot-Reload

Banyak config key bisa diubah **tanpa restart daemon**. Cukup edit file config,
simpan, dan daemon otomatis reload dalam ~300ms.

```bash
# Edit config
nano ~/.config/dynalloc/config.json

# Simpan, lalu cek log kalau reload berhasil:
journalctl --user -u dynalloc.service --no-pager -n 5 | grep -i reload
# Output: "Config berhasil di-reload."
```

> **Penting:** Fitur v2.1.0 Tier 1 (Predictive Engine, Energy Accounting,
> Power Budget Arbiter, VRAM Reclaim) **memerlukan restart daemon** setelah
> di-enable. Hot-reload hanya mengubah nilai config, tapi tidak menginisialisasi
> subsystem baru. Ini adalah bug yang akan diperbaiki di versi selanjutnya.

---

## 7. Mengaktifkan Fitur v2.1.0 Tier 1

Semua fitur baru v2.1.0 **default OFF** (opt-in). Aktifkan satu per satu atau
sekaligus di config file.

### 7.1 Predictive Pre-Allocation Engine ("Crystal Ball")

Memprediksi app berikutnya yang akan kamu buka, dan pre-warm CPU governor +
GPU power SEBELUM app-nya jalan. Menghilangkan "first 5 second stutter".

```bash
# Edit config
nano ~/.config/dynalloc/config.json
```

```json
{
  "ENABLE_PREDICTIVE_ENGINE": true,
  "PREDICTION_CONFIDENCE_THRESHOLD": 0.45,
  "PREDICTION_HOLD_MS": 8000,
  "PREDICTION_COOLDOWN_MS": 15000
}
```

| Key | Default | Deskripsi |
|-----|---------|-----------|
| `ENABLE_PREDICTIVE_ENGINE` | `false` | Master switch |
| `PREDICTION_CONFIDENCE_THRESHOLD` | `0.45` | Minimum confidence (0-1). Lebih tinggi = lebih konservatif |
| `PREDICTION_HOLD_MS` | `8000` | Durasi pre-allocation sebelum auto-revert (ms) |
| `PREDICTION_COOLDOWN_MS` | `15000` | Cooldown antar pre-allocation (ms) |

**Prasyarat:** Butuh minimum 3 observasi transisi foreground dari app yang sama
di jam dan battery bucket yang sama sebelum mulai memberikan prediksi.
Pakai beberapa jam pertama untuk mengumpulkan data.

```bash
# Restart daemon
systemctl --user restart dynalloc.service

# Cek status
dynalloc predict
dynalloc predict --top --app brave
```

### 7.2 Per-App Energy Accounting (RAPL)

Menghitung konsumsi energi per-app menggunakan Intel/AMD RAPL counter.
Output: "Discord: 47 Wh this week, Chrome: 89 Wh."

```json
{
  "ENABLE_ENERGY_ACCOUNTING": true,
  "ENERGY_ACCOUNTING_TICK_MS": 1000
}
```

**Prasyarat Hardware:**
- **Intel:** `/sys/class/powercap/intel-rapl/` harus ada
- **AMD:** `/sys/class/hwmon/hwmon*/power` harus ada (μW reading)

```bash
# Cek apakah RAPL tersedia
ls /sys/class/powercap/intel-rapl/ 2>/dev/null && echo "Intel RAPL: OK" || echo "Intel RAPL: not found"
ls /sys/class/hwmon/hwmon*/power 2>/dev/null && echo "AMD hwmon: OK" || echo "AMD hwmon: not found"

# Restart dan cek
systemctl --user restart dynalloc.service
dynalloc energy
dynalloc energy --apps --limit 10
dynalloc energy --history
```

### 7.3 CPU+GPU Shared Power Budget Arbiter

Mengelola CPU + GPU sebagai **satu budget daya gabungan**. Kalau total
melebihi budget, otomatis menentukan mana yang harus di-throttle berdasarkan
utilization (GPU-bound vs CPU-bound vs balanced).

```json
{
  "ENABLE_POWER_BUDGET_ARBITER": true,
  "POWER_BUDGET_TOTAL_WATTS": 65,
  "POWER_BUDGET_CPU_MIN_WATTS": 8,
  "POWER_BUDGET_GPU_MIN_WATTS": 10,
  "POWER_BUDGET_HEADROOM_FACTOR": 0.95,
  "POWER_BUDGET_RELEASE_FACTOR": 1.10,
  "POWER_BUDGET_TICK_MS": 2000
}
```

**Prasyarat:**
- `ENABLE_GPU_CONTROL: true` (untuk baca/tulis GPU power limit)
- NVIDIA: `nvidia-smi` harus tersedia
- AMD: `power_dpm_force_performance_level` sysfs harus accessible

```bash
# Set POWER_BUDGET_TOTAL_WATTS sesuai TDP laptop/PC-mu
# Contoh: laptop gaming 65W, desktop 250W+

systemctl --user restart dynalloc.service
dynalloc powerbudget
```

### 7.4 GPU VRAM Pressure Reclaim

Memantau penggunaan VRAM. Kalau VRAM > 92% dan foreground butuh VRAM,
secara singkat SIGSTOP proses background yang paling banyak makan VRAM
supaya driver bisa reclaim. Mencegah GPU OOM crash.

```json
{
  "ENABLE_VRAM_RECLAIM": true,
  "VRAM_RECLAIM_TICK_MS": 5000,
  "VRAM_RECLAIM_HIGH_WATERMARK": 0.92,
  "VRAM_RECLAIM_LOW_WATERMARK": 0.80,
  "VRAM_RECLAIM_HOLD_MS": 3000,
  "VRAM_RECLAIM_COOLDOWN_MS": 30000,
  "VRAM_RECLAIM_MAX_PER_TICK": 2
}
```

**Prasyarat:**
- **NVIDIA:** `nvidia-smi` harus tersedia (untuk query VRAM per-PID)
- **AMD:** Fallback via `/proc/[pid]/maps` scan untuk `[drm]`/`amdgpu` maps

```bash
# Cek VRAM support
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null && echo "NVIDIA VRAM: OK" || echo "NVIDIA: not found"

systemctl --user restart dynalloc.service
dynalloc vram
```

### 7.5 Aktifkan Semua Sekaligus

```bash
cat > ~/.config/dynalloc/config.json << 'EOF'
{
  "LOG_LEVEL": "info",
  "ENABLE_CGROUPS_V2": true,
  "ENABLE_GOVERNOR_SWITCH": true,
  "ENABLE_GPU_CONTROL": true,
  "ENABLE_EVENT_DRIVEN_FOCUS": true,
  "ENABLE_MULTIMEDIA_PROTECTION": true,
  "ENABLE_THERMAL_PROTECTION": true,
  "ENABLE_INTELLIGENCE": true,
  "HOT_RELOAD": true,

  "ENABLE_PREDICTIVE_ENGINE": true,
  "PREDICTION_CONFIDENCE_THRESHOLD": 0.45,

  "ENABLE_ENERGY_ACCOUNTING": true,

  "ENABLE_POWER_BUDGET_ARBITER": true,
  "POWER_BUDGET_TOTAL_WATTS": 65,

  "ENABLE_VRAM_RECLAIM": true
}
EOF

# Restart daemon
systemctl --user restart dynalloc.service
```

---

## 8. Setup Privilege (Non-Root)

DynAlloc berjalan sebagai user process (bukan root). Untuk mengubah CPU
governor dan I/O priority tanpa sudo, perlu set capability.

### 8.1 Set CAP_SYS_NICE

```bash
# renice — untuk mengubah nice value
sudo setcap 'cap_sys_nice+ep' /usr/bin/renice

# ionice — untuk mengubah I/O priority
sudo setcap 'cap_sys_nice+ep' /usr/bin/ionice

# Verifikasi
getcap /usr/bin/renice
getcap /usr/bin/ionice
# Output: /usr/bin/renice cap_sys_nice+ep
# Output: /usr/bin/ionice cap_sys_nice+ep
```

### 8.2 Governor Tanpa Sudo

```bash
# Kalau governor switching gak jalan tanpa sudo, opsi 1:
# Tambahkan user ke grup yang punya akses governor
sudo usermod -aG video $USER

# Opsi 2: Set permission di sysfs
echo 'KERNEL=="cpu", SUBSYSTEM=="cpufreq", ACTION=="add", RUN+="/bin/chmod 666 %S%p/scaling_governor"' | sudo tee /etc/udev/rules.d/99-cpufreq.rules
sudo udevadm control --reload-rules
sudo udevadm trigger

# Opsi 3: Pakai sudo (set di config)
# "GOVERNOR_USE_SUDO": true
```

### 8.3 GPU Control Tanpa Sudo (NVIDIA)

```bash
# Opsi 1: Tambahkan keudev rules
echo 'SUBSYSTEM=="nvidia", RUN+="/bin/chmod 666 %S%p/power/control"' | sudo tee /etc/udev/rules.d/99-nvidia.rules
sudo udevadm control --reload-rules

# Opsi 2: Pakai sudo
# "GPU_USE_SUDO": true
```

---

## 9. Verifikasi Instalasi

### 9.1 Dry-Run Test

```bash
# Jalankan daemon dalam mode dry-run (aman, gak ngapa-ngapain sistem)
DYNALLOC_DRY_RUN=1 node /opt/dynalloc/dynalloc-daemon.js

# Kalau gak ada error dalam 10-15 detik, instalasi berhasil
# Tekan Ctrl+C untuk stop
```

### 9.2 Health Check

```bash
# Jalankan daemon dulu
systemctl --user start dynalloc.service

# Cek status dasar
dynalloc status

# Run diagnostics
dynalloc doctor

# Cek apakah semua subsistem aktif
dynalloc status --json | python3 -m json.tool
```

### 9.3 Test CLI Commands

```bash
# Ping daemon
dynalloc ping

# Lihat status lengkap
dynalloc status

# Lihat live dashboard (tekan Ctrl+C untuk keluar)
dynalloc watch

# Test manual boost
dynalloc boost $$
dynalloc restore $$

# Cek throttled processes
dynalloc throttled

# Full metrics
dynalloc stats
```

### 9.4 Test Fitur v2.1.0

```bash
# Predictive Engine
dynalloc predict
dynalloc predict --app brave --top

# Energy Accounting
dynalloc energy
dynalloc energy --apps --limit 5

# Power Budget
dynalloc powerbudget

# VRAM Reclaim
dynalloc vram

# Intelligence subsystem (v2.0)
dynalloc intelligence
dynalloc recommendations
dynalloc explanations
```

---

## 10. CLI Reference

### Command Dasar

| Command | Deskripsi |
|---------|-----------|
| `dynalloc ping` | Cek daemon berjalan |
| `dynalloc status` | Status daemon + foreground + plugins |
| `dynalloc status --json` | Status dalam format JSON |
| `dynalloc watch` | Live dashboard real-time |
| `dynalloc stats` | Full metrics report |
| `dynalloc doctor` | Run health diagnostics |
| `dynalloc throttled` | List proses yang di-throttle |

### Process Control

| Command | Deskripsi |
|---------|-----------|
| `dynalloc boost <pid>` | Manual boost proses |
| `dynalloc throttle <pid>` | Manual throttle proses |
| `dynalloc restore <pid>` | Restore proses ke default |

### Fitur v2.0 — Intelligence

| Command | Deskripsi |
|---------|-----------|
| `dynalloc intelligence` | Status intelligence subsystem |
| `dynalloc recommendations` | Rekomendasi AI |
| `dynalloc explanations` | Penjelasan keputusan terakhir |

### Fitur v2.1.0 — Tier 1 Killer Features

| Command | Deskripsi |
|---------|-----------|
| `dynalloc predict` | Status predictive engine |
| `dynalloc predict --app <name>` | Prediksi next app dari app sekarang |
| `dynalloc predict --top --app <name>` | Top transition candidates |
| `dynalloc energy` | Status energy accounting |
| `dynalloc energy --apps` | Top energy consumers |
| `dynalloc energy --history` | Riwayat watt system |
| `dynalloc vram` | Status VRAM reclaim |
| `dynalloc vram --force-release` | Force-release suspended PIDs |
| `dynalloc powerbudget` | Status power budget arbiter |
| `dynalloc powerbudget --force-release` | Force-release active cap |

### Opsi Global

| Flag | Deskripsi |
|------|-----------|
| `--json` | Output dalam format JSON |
| `--socket <path>` | Path ke IPC socket (override default) |
| `--help` | Tampilkan help |

---

## 11. Troubleshooting

### Daemon gak mau start

```bash
# Cek log
journalctl --user -u dynalloc.service --no-pager -n 30

# Cek Node.js versi
node --version  # harus >= 18.0.0

# Cek ada proses lama yang nge-block socket
ls -la /tmp/dynalloc-*.sock 2>/dev/null
# Kalau ada, hapus:
rm -f /tmp/dynalloc-*.sock

# Cek D-Bus session (GNOME Wayland)
echo $DBUS_SESSION_BUS_ADDRESS
# Kalau kosong, re-login atau jalankan:
export $(dbus-launch)
```

### Predictive Engine tetap "disabled"

```bash
# 1. Pastikan config file ada dan valid
cat ~/.config/dynalloc/config.json | python3 -m json.tool

# 2. Pastikan ENABLE_PREDICTIVE_ENGINE: true
grep -i "PREDICTIVE" ~/.config/dynalloc/config.json

# 3. RESTART daemon (hot-reload gak cukup!)
systemctl --user restart dynalloc.service

# 4. Cek log
journalctl --user -u dynalloc.service --no-pager -n 30 | grep -i predict
# Harusnya ada: "Predictive Engine aktif (threshold=45%, hold=8000ms)."
```

### Energy Accounting gak ada data

```bash
# Cek RAPL available
ls /sys/class/powercap/intel-rapl/ 2>/dev/null
# atau
ls /sys/class/hwmon/hwmon*/power 2>/dev/null

# Kalau gak ada, fitur ini gak bisa dipakai di hardware-mu
# Tapi gak akan bikin error — subsystem jadi inert
```

### GPU Control gak jalan

```bash
# NVIDIA
nvidia-smi --query-gpu=power.min_limit,power.max_limit --format=csv
# Kalau ini error, install nvidia-utils

# Cek permission
nvidia-smi -pl 100 2>&1
# Kalau "permission denied", set GPU_USE_SUDO: true di config
```

### Cgroups v2 error

```bash
# Cek cgroups v2 mount
mount | grep cgroup2

# Cek controller available
cat /sys/fs/cgroup/cgroup.controllers

# Pastikan systemd user session pakai cgroups v2
systemctl --user show | grep CGroup
```

### Governor gak berubah

```bash
# Cek capability renice/ionice
getcap /usr/bin/renice /usr/bin/ionice

# Cek governor writable
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors

# Cek apakah power-profiles-daemon nge-block
systemctl --user status power-profiles-daemon 2>/dev/null
# Kalau aktif, set ENABLE_PPD_COORDINATION: true di config
```

### Foreground detection gak kerja

```bash
# GNOME Wayland — butuh D-Bus + extension "Window Calls Extended"
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/WindowsExt \
  --method org.gnome.Shell.Extensions.WindowsExt.FocusPID

# X11 — butuh xdotool
xdotool getactivewindow getwindowname

# Hyprland — butuh hyprctl
hyprctl activewindow -j | jq '.class'

# Sway — butuh swaymsg
swaymsg -t get_tree | jq '.. | select(.focused?) | .name'
```

---

## 12. Uninstall

### Uninstall Manual

```bash
# Stop daemon
systemctl --user stop dynalloc.service
systemctl --user disable dynalloc.service

# Hapus service file
rm -f ~/.config/systemd/user/dynalloc.service
systemctl --user daemon-reload

# Hapus instalasi
sudo rm -rf /opt/dynalloc
sudo rm -f /usr/local/bin/dynalloc /usr/local/bin/dynalloc-daemon
sudo rm -f /usr/lib/systemd/user/dynalloc.service

# Hapus state files
rm -f /tmp/dynalloc-state.json /tmp/dynalloc-*.sock

# Config preserved — hapus kalau mau bersih-bersih:
# rm -rf ~/.config/dynalloc
# sudo rm -rf /etc/dynalloc

# Hapus capabilities
sudo setcap -r /usr/bin/renice 2>/dev/null
sudo setcap -r /usr/bin/ionice 2>/dev/null
```

### Uninstall via Package Manager

```bash
# Debian/Ubuntu
sudo dpkg --remove dynalloc
# atau purge (termasuk config):
# sudo dpkg --purge dynalloc

# Fedora
sudo dnf remove dynalloc

# Arch
sudo pacman -Rns dynalloc
```

---

## Quick Start (Cheat Sheet)

```bash
# 1. Install
sudo ./install.sh

# 2. Setup service
mkdir -p ~/.config/systemd/user
cp /opt/dynalloc/systemd/dynalloc.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dynalloc.service

# 3. Configure
mkdir -p ~/.config/dynalloc
cat > ~/.config/dynalloc/config.json << 'EOF'
{
  "ENABLE_CGROUPS_V2": true,
  "ENABLE_GOVERNOR_SWITCH": true,
  "ENABLE_EVENT_DRIVEN_FOCUS": true,
  "ENABLE_PREDICTIVE_ENGINE": true,
  "ENABLE_ENERGY_ACCOUNTING": true,
  "ENABLE_POWER_BUDGET_ARBITER": true,
  "POWER_BUDGET_TOTAL_WATTS": 65,
  "ENABLE_VRAM_RECLAIM": true
}
EOF

# 4. Restart & verify
systemctl --user restart dynalloc.service
dynalloc status
dynalloc doctor

# 5. Monitor
dynalloc watch
```