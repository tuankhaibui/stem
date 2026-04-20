# STEM: Real-time Waveform Monitor for Multi-Channel DAQ

**STEM** = **S**ignals **T**ransport, **E**xport, **M**onitor

A FastAPI-based web server that provides real-time visualization, analysis, and data export for multi-channel waveform data streaming from a ZMQ-enabled DAQ system. Originally designed to monitor physics detector experiments (LOTUSS), STEM bridges the gap between raw data acquisition hardware and interactive browser-based analysis.

![STEM Monitor Demo](assets/monitor_demo_with_fake-daq.gif)

---

## What STEM Does

STEM is a **data bridge + web UI** that:

1. **Subscribes to ZMQ data stream** from upstream DAQ (fake_data or real hardware)
   - Listens on configurable ZMQ SUB socket (default: `tcp://localhost:5555`)
   - Receives multipart messages: `[metadata JSON, waveform binary]`
   - Handles up to 8+ channels at 1+ MHz sampling rate

2. **Processes waveforms in real-time**
   - Downsamples adaptively (2000-50000 points per channel, configurable)
   - Computes FFT using scipy (1D per frame)
   - Calculates PSD with Welch method (scipy.signal.welch)
   - Computes signal statistics (min/max/RMS/frequency/duty/rise-fall time)
   - Maintains per-channel EMA for stable FFT averaging

3. **Streams to browser via WebSocket**
   - `/ws/data` endpoint: Server → Browser (JSON payload, ~100 fps)
   - `/ws/control` endpoint: Browser → Server (channel config, trigger settings)
   - Forwards control commands back to DAQ via ZMQ PUB

4. **Provides interactive analysis UI**
   - Real-time Plotly waveform plot with zoom/pan
   - FFT/PSD spectrum panel (3 units: V²/Hz, V/√Hz, dBV/√Hz)
   - Per-channel statistics table (13 measurements)
   - Trigger level indicator on plot
   - Data export (HDF5 with metadata, or CSV)

---

## Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Upstream DAQ System (fake_data or real hardware)            │
│ - 8 channels @ 1 MHz (8 MB/sec raw)                         │
│ - Publishes ZMQ on tcp://0.0.0.0:5555                       │
│   Frame: [metadata JSON, waveform numpy array (float64)]    │
└───────────────────────────┬─────────────────────────────────┘
                            │ ZMQ SUB (tcp://localhost:5555)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ STEM Server (FastAPI + Uvicorn + asyncio)                   │
│                                                             │
│ ┌─ Background ZMQ Thread ─────────────────────────────┐   │
│ │ - Recv frames from DAQ                              │   │
│ │ - Parse metadata + waveform (shape: [n_ch, n_samp]) │   │
│ │ - Downsample: step = n_samp // _downsample_pts     │   │
│ │ - Compute FFT (numpy.fft.rfft per channel)         │   │
│ │ - Compute PSD: |FFT|² / (fs × N), one-sided       │   │
│ │ - Compute stats via qetpy-style algorithm          │   │
│ │ - Push to _data_queue (FIFO, size=5)              │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌─ WebSocket /ws/data ────────────────────────────────┐   │
│ │ - Pull from _data_queue                             │   │
│ │ - Build JSON: {timestamp, channels, data, freqs}    │   │
│ │ - Send to browser (~100 fps)                        │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌─ WebSocket /ws/control ─────────────────────────────┐   │
│ │ - Recv: {channel, enabled, signal, freq, amp, ...}  │   │
│ │ - Fwd to DAQ via ZMQ PUB (tcp://localhost:5556)    │   │
│ └──────────────────────────────────────────────────────┘   │
└─────────────────────────┬─────────────────────────────────┘
                          │ WebSocket over TCP
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Browser (Chrome/Firefox)                                    │
│ - Receive data payload via ws://<host>:8000/ws/data        │
│ - Plotly.react() updates waveform plot                      │
│ - EMA filter + unit conversion for FFT (dB calculation)     │
│ - Statistics table updates                                  │
│ - Interactive: zoom, trigger, channel toggle, export        │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Technical Components

### 1. ZMQ Subscriber Thread (`_zmq_subscriber_thread`)
- **Location:** `app.py` line ~189
- **Purpose:** Continuous background thread receiving DAQ frames
- **Details:**
  - Binds to `tcp://<daq_host>:{ZMQ_SUB_PORT}` (config-driven)
  - Recv multipart: `[metadata_json, waveform_binary]`
  - Metadata keys: `n_channels`, `n_samples`, `sample_rate`, `timestamp`, `channels` (list)
  - Waveform: np.float64 array, shape `[n_channels, n_samples]`
  - Pushes to asyncio queue (thread-safe via `asyncio.run_coroutine_threadsafe`)
  - Handles ZMQ timeout (2s) for graceful shutdown

### 2. Downsampling & Adaptive Resolution
- **Location:** `app.py` line ~101, 219-225
- **Algorithm:**
  ```python
  step = max(1, n_samples // _downsample_pts)
  data_downsampled = data[:, ::step]
  ```
- **Adaptive:** Browser sends `set_pts` command when user zooms
  - Calculates needed points: `fraction = view_ms / trace_ms`
  - Updates `_downsample_pts` (range: 2000-50000)
  - Next frame uses new resolution

### 3. FFT / PSD Calculation
- **Location:** `app.py` line ~248-276
- **Method:** Single-sided (positive frequencies only)
- **Formula:**
  ```python
  X = np.fft.rfft(trace, axis=0)
  psd = (np.abs(X)**2) * 2.0 / (sample_rate * n_samples)  # V²/Hz
  psd[0] /= 2.0    # DC component (no negative-freq pair)
  if Nyquist: psd[-1] /= 2.0  # Shared between ±freq
  ```
- **Downsampling PSD for browser:**
  - Log-spaced frequency bins (max 4000 points)
  - `scipy.signal.decimate` or simple indexing
  
### 4. Signal Statistics
- **Location:** `monitor.js` line ~356-427 (client-side for real-time)
- **Measurements (13 total):**
  - **Amplitude:** min, max, Vpp, mean, median, RMS, AC RMS, std dev
  - **Frequency:** fundamental (zero-crossing method), period, duty cycle
  - **Timing:** rise time 10%-90%, fall time 90%-10% (in microseconds)
- **Example:**
  ```javascript
  freq = (zero_crossings > 0) ? zero_crossings / (trace_duration_sec) : null
  rise_time_us = (i_hi - i_lo) * dt_ms * 1000  // dt = 1/sample_rate
  ```

### 5. Data Export (HDF5)
- **Location:** `app.py` line ~96-187
- **Structure:**
  ```
  waveform_YYYYMMDD_HHMMSS.h5:
    /waveforms [n_events, n_channels, n_samples]
    /frequencies_hz [n_freq_bins]
    /psd_power [n_events, n_channels, n_freq_bins]
    /metadata (attributes: sample_rate, timestamp, ...)
  ```
- **CSV:** Separate file per channel, columns: [time_ms, amplitude_V]

---

## Configuration & Network Setup

### ZMQ Addressing
STEM reads `config.ini`:
```ini
[zmq]
daq_host = localhost        # DAQ machine (IP or hostname)
sub_port = 5555             # Subscribe to DAQ data
pub_port = 5556             # Publish control commands (not used in current version)

[web]
host = 0.0.0.0              # Bind FastAPI to all interfaces
port = 8000
```

**Deployment Scenarios:**

| Scenario | config.ini | Data Path |
|----------|-----------|-----------|
| Same machine (dev) | `daq_host = localhost` | localhost:5555 |
| DAQ on LAN | `daq_host = 192.168.1.100` | 192.168.1.100:5555 |
| Multiple monitors | All point to same IP | Single DAQ, N browsers |

### Network Latency Analysis (8 channels)
- **ZMQ (LAN):** 1-5 ms
- **Downsampling + FFT:** 0.5-2 ms
- **WebSocket send:** 5-20 ms
- **Browser update:** 16-33 ms (60 FPS)
- **Total:** 25-60 ms typical, 100-150 ms under congestion

**Bottleneck:** WebSocket payload size (64 KB per frame × 100 fps = 6.4 MB/sec)

---

## Running STEM

### Installation
```bash
cd ~/stem
pip install -r requirements.txt
```

### Start Server
```bash
# Development (with auto-reload)
uvicorn app:app --reload --host 0.0.0.0 --port 8000

# Production (single worker)
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1
```

**Output:**
```
INFO:     Uvicorn running on http://0.0.0.0:8000
INFO:     ZMQ subscriber thread started
[app] ZMQ SUB connected to tcp://localhost:5555
[app] browser connected to /ws/data
[app] Receiving frames at ~100 Hz...
```

### Browser Access
```
Local: http://localhost:8000
LAN:   http://<your-ip>:8000
```

---

## UI Controls & Workflows

### Real-Time Waveform Plot
- **Left sidebar:** Channel enable/disable checkboxes
- **Plot area:** 
  - Zoom: Scroll wheel or drag rectangle
  - Pan: Click + drag
  - Reset: Button in toolbar
- **Stack mode:** Offset channels vertically (prevents overlap)
- **Plot mode:** Switch between lines / dots / lines+dots

### FFT/PSD Panel
1. Click **"Show"** under FFT section (bottom of sidebar)
2. FFT panel appears with spectrum plot
3. **Unit selection:** V²/Hz (linear) → V/√Hz (sqrt) → dBV/√Hz (dB)
4. **Log scales:** Toggle X and Y axes independently
5. **Averaging:** Adjust N (frames to average via EMA)
6. **Reset:** Clear averaging buffer

**EMA formula:**
```javascript
alpha = 1 / _psdEmaCount
psd_ema[i] = alpha * psd_new[i] + (1 - alpha) * psd_ema[i]
```

### Trigger Configuration
1. **Source:** Select channel for trigger detection
2. **Edge:** Rising (↑), Falling (↓), Either (~)
3. **Level:** Slider or text input (V)
4. **Mode:** Auto (repeat last trigger) or Normal (wait for next)
5. **Result:** Horizontal dashed line on plot at trigger level

### Channel Configuration (per-channel sidebar)
- **Signal type:** sine, square, triangle, sawtooth, dc, pulse
- **Frequency:** 0-500 kHz
- **Amplitude:** 0-2 V
- **Noise:** Enable + amplitude (0-2 V)
- **Pulse params (if pulse mode):** τ rise, τ fall (ms)

### Data Export
1. **Format:** HDF5 (with FFT) or CSV (waveforms only)
2. **Channels:** Select which to include
3. **Options:** Include FFT? Include metadata?
4. **Start:** Begin collecting frames
5. **Download:** Zip file with results

---

## Code Structure

```
app.py (486 lines):
├── Configuration (ZMQ ports, downsampling, PSD bins)
├── ZMQ subscriber thread (background, recv frames)
├── FastAPI setup
├── WebSocket /ws/data (send waveforms)
├── WebSocket /ws/control (recv channel config)
├── API /api/status (health check)
├── Save/export endpoints (HDF5/CSV generation)
└── Static file serving

static/index.html (432 lines):
├── Layout (left sidebar, central plot, bottom FFT panel)
├── Buttons (connect, pause, zoom, trigger, stats, stack, plot mode)
├── Controls (channel toggles, signal type, frequency, amplitude, noise)
└── SVG icons + styling

static/monitor.js (1841 lines):
├── WebSocket connection + message handling
├── Plotly plot setup + updates
├── FFT/PSD processing (EMA, unit conversion, log scaling)
├── Statistics calculation (min/max/RMS/freq/duty/rise-fall)
├── UI state management
└── Trigger visualization

static/style.css (724 lines):
├── Dark theme (GitHub dark-mode colors)
├── Grid layout (sidebar, plot, FFT)
├── Responsive sizing (drag handles between panels)
├── Button styling (Plotly toolbar integration)
└── Typography + spacing

config.ini:
├── [zmq] ZMQ connection details
└── [web] FastAPI server binding
```

---

## Performance Characteristics

### Data Rates
- **Input (from DAQ):** 2.5 MB/channel/sec × 8 channels = **20 MB/sec raw**
- **Output (to browser):** 64 KB/frame × 100 fps ≈ **6.4 MB/sec** (with downsampling)
- **CPU overhead:** ~10-15% (FFT calculation, downsampling, JSON serialization)

### Latency (8 channels, 1 MHz sampling, Gigabit LAN)
| Component | Time |
|-----------|------|
| DAQ → ZMQ pub | <1 ms |
| ZMQ recv | 1-3 ms |
| Downsample + FFT | 1-2 ms |
| JSON build | 0.5-1 ms |
| WebSocket send | 5-15 ms |
| Browser render | 16-33 ms |
| **Total** | **25-60 ms** |

### Browser Performance
- **Frame rate:** Adaptive (50-150 fps based on network RTT)
- **Memory:** ~200 MB per browser (Plotly cache + FFT EMA buffers)
- **CPU:** <5% (Plotly rendering + JS event loop)

---

## Troubleshooting

### ZMQ Connection Issues
```
[app] ZMQ SUB failed to connect: Connection refused
```
**Solution:** Verify DAQ is running and publishing on `config.ini` address
```bash
# Check ZMQ is listening
netstat -an | grep 5555
```

### WebSocket Timeout
```
Browser console: WebSocket connection failed
```
**Solution:** Verify FastAPI is running and firewall allows port 8000
```bash
curl http://localhost:8000/api/status
```

### FFT Panel not updating
```
Browser: FFT plot shows zeros or no data
```
**Solution:** Check that DAQ has enough samples (FFT needs ≥1000 samples/channel)

### Slow Performance / Lag
- Reduce downsampling target: `_downsample_pts = 1000` (instead of 4000)
- Reduce FFT averaging window N
- Disable unused channels
- Check network (ping to DAQ, check for packet loss)

---

## Future Enhancements

**Phase 2 (In Planning):**
- [ ] Per-user independent state (multi-user isolation)
- [ ] Authentication / login (role-based access)
- [ ] Hardware control endpoints (temperature, function gen, DAQ settings)

**Phase 3 (Potential):**
- [ ] Real-time file recording (streaming to disk)
- [ ] Remote access via reverse proxy (Cloudflare Tunnel)
- [ ] Data replay / playback from saved files
- [ ] Custom measurement plugins
- [ ] Multi-language UI (localization)

---

## References

- **ZMQ Documentation:** https://zeromq.org/
- **FastAPI:** https://fastapi.tiangolo.com/
- **Plotly.js:** https://plotly.com/javascript/
- **SciPy Signal Processing:** https://docs.scipy.org/doc/scipy/reference/signal.html
- **WebSocket (RFC 6455):** https://tools.ietf.org/html/rfc6455

---

## Related Projects

- **fake_data:** Standalone ZMQ publisher (simulates DAQ or real hardware)
- **LOTUSS Collaboration:** Physics detector experiment
