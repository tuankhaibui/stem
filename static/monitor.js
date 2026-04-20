/**
 * monitor.js — waveforge browser client
 *
 * Connects to two WebSockets:
 *   /ws/data    — receives waveform JSON from server
 *   /ws/control — sends channel config changes to server → fake_daq
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const CH_COLORS = [
    '#58a6ff', '#3fb950', '#f78166', '#d2a8ff',
    '#ffa657', '#79c0ff', '#56d364', '#ff7b72',
];

const SIGNAL_TYPES = ['sine', 'square', 'triangle', 'sawtooth', 'dc', 'pulse'];

// Plot mode: lines | dots | lines+dots
const PLOT_MODES  = ['lines', 'markers', 'lines+markers'];
let   plotModeIdx = 0;

// Plotly config — shared by newPlot and every react() call so edits.shapePosition persists
const PLOTLY_CONFIG = {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ['select2d', 'lasso2d'],
    edits: { shapePosition: true },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}


function getPlotColors() {
    const light = document.body.dataset.theme === 'light';
    return {
        bg:      light ? '#ffffff' : '#0d1117',
        bgAlt:   light ? '#e6efff' : '#0e2248',   // FFT panel — vivid blue-navy
        panel:   light ? '#f6f8fa' : '#161b22',
        border:  light ? '#d0d7de' : '#30363d',
        text:    light ? '#1f2328' : '#e6edf3',
        muted:   light ? '#57606a' : '#8b949e',
        grid:    light ? '#e8ecf0' : '#21262d',
        zero:    light ? '#d0d7de' : '#2d333b',
    };
}

// ── State ──────────────────────────────────────────────────────────────────

let wsData    = null;
let wsControl = null;
let paused    = false;
let plotInited = false;
let intentionalDisconnect = false;
let stackMode    = false;
let _relayoutListening = false;
let _mouseDown = false;   // true while any mouse button held — suppress Plotly.react during drags

// Per-channel smoothed data range for stack-mode Y-axis sizing
// { [ch.id]: { min: number, max: number } }
const _chDataRange = {};

// Track enabled channel set — reset Y autorange when it changes
let _lastEnabledIds  = '';
let _forceYAutorange = false;

// ── Trigger state ──────────────────────────────────────────────────────────

const triggerState = {
    enabled: false,
    source:  0,          // channel id
    edge:    'rising',   // 'rising' | 'falling'
    level:   0.0,        // V
    hyst:    0.05,       // V  — hysteresis dead-band half-width
    mode:    'auto',     // 'auto' | 'normal'
    trigPos: 0.2,        // fraction of visible window shown BEFORE trigger (0=left, 1=right)
};
let _lastTriggerFrame = null;
let _lastTrigX        = null;   // x position (ms) of trigger in current display

// Ring buffer: keep TRIG_BUF_FRAMES consecutive frames so trigger always has
// enough pre- and post-trigger data regardless of where in the trace it fires.
const TRIG_BUF_FRAMES = 3;
let _trigBuf      = null;   // Float64Array[nCh], each length = TRIG_BUF_FRAMES * nPts
let _trigBufNPts  = 0;
let _trigBufCount = 0;      // frames pushed so far (capped at TRIG_BUF_FRAMES)

// channel state: id, name, enabled, signal, freq_hz, amplitude
let channelState = [];

// current trace duration in ms (updated on each data frame)
let traceDurationMs = null;

// ── FFT state ──────────────────────────────────────────────────────────────
let fftVisible = false;
let _fftInited = false;

// 3-state PSD unit: 0=V²/Hz  1=V/√Hz  2=dBV/√Hz
const FFT_UNITS  = ['V²/Hz', 'V/√Hz', 'dBV/√Hz'];
let   fftUnitIdx = 2;   // default: dBV/√Hz (linear Y)
let   fftLogX    = true;
let   fftLogY    = false;  // dBV/√Hz → already log scale → linear Y axis

// ── N-frame EMA averaging (FFT and stats are independent) ──────────────────
let fftAvgN       = 1;
let _psdEma       = null;   // Float64Array[] per channel — running EMA of PSD
let _psdEmaCount  = 0;

let statsAvgN     = 1;
let _statsEma     = {};     // {chId: {statKey: emaValue}}
let _statsEvar    = {};     // {chId: {statKey: emaVariance}} — for ± display
let _statsEmaCount = 0;

// ── Display mode (persist / avg) ───────────────────────────────────────────
let displayMode   = 'off';   // 'off' | 'persist' | 'avg'
let displayN      = 10;
let _modeBuf      = [];      // [{t: number[], chData: {chId: number[]}}] — last N frames
let _modeChannels = new Set();

// Set true by applyTrigger() when trigger actually fires this frame
let _trigFiredThisFrame = false;

// ── Save state ─────────────────────────────────────────────────────────────
let saveChannels   = new Set();
let _saveToken     = null;
let _savePollTimer = null;

function _resetPsdEma() {
    _psdEma      = null;
    _psdEmaCount = 0;
    document.getElementById('fft-n-avg').textContent = '0';
}

// rate tracking
let evCount = 0;
let evTs    = Date.now();


// ── DOM refs ───────────────────────────────────────────────────────────────

const connIndicator = document.getElementById('conn-indicator');
const connText      = document.getElementById('conn-text');
const evRateEl      = document.getElementById('ev-rate');
const latencyEl     = document.getElementById('latency');
const srEl          = document.getElementById('sample-rate');
const traceEl       = document.getElementById('trace-len');
const channelList   = document.getElementById('channel-list');
const btnConnect    = document.getElementById('btn-connect');
const btnPause      = document.getElementById('btn-pause');
const zoomWarnEl    = document.getElementById('zoom-warn');

// Suppress Plotly.react() while mouse button is held to prevent drag interruption
document.addEventListener('mousedown', () => { _mouseDown = true; });
document.addEventListener('mouseup',   () => { _mouseDown = false; });


// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
    intentionalDisconnect = false;
    plotInited = false;
    channelState = [];

    const base = `ws://${location.host}`;

    // Data socket
    wsData = new WebSocket(`${base}/ws/data`);
    wsData.binaryType = 'arraybuffer';

    wsData.onopen = () => {
        setConnected(true);
        console.log('[waveforge] /ws/data connected');
    };

    wsData.onclose = () => {
        setConnected(false);
        if (intentionalDisconnect) {
            console.log('[waveforge] /ws/data disconnected intentionally');
        } else {
            console.log('[waveforge] /ws/data disconnected — reconnecting in 2s');
            setTimeout(connect, 2000);
        }
    };

    wsData.onerror = (e) => console.error('[waveforge] ws error', e);

    wsData.onmessage = (ev) => {
        if (paused) return;
        try {
            const payload = JSON.parse(ev.data);
            handleData(payload);
        } catch (e) {
            console.error('[waveforge] parse error', e);
        }
    };

    // Control socket
    wsControl = new WebSocket(`${base}/ws/control`);
    wsControl.onopen  = () => console.log('[waveforge] /ws/control connected');
    wsControl.onclose = () => {
        setTimeout(() => {
            wsControl = new WebSocket(`${base}/ws/control`);
        }, 2000);
    };
}

function setConnected(ok) {
    connIndicator.className = ok ? 'connected' : '';
    connText.textContent = ok ? 'Connected' : 'Disconnected';
    btnConnect.textContent = ok ? 'Disconnect' : 'Connect';
    btnConnect.classList.toggle('active', ok);
}

function sendControl(cmd) {
    if (wsControl && wsControl.readyState === WebSocket.OPEN) {
        wsControl.send(JSON.stringify(cmd));
    }
}


// ── Data handling ──────────────────────────────────────────────────────────

function handleData(payload) {
    const { channels, data, sample_rate, n_samples, timestamp } = payload;

    syncChannelState(channels);

    // Detect enabled-channel set change → reset Y autorange so plot rescales
    const enabledNow = channelState.filter(ch => ch.enabled).map(ch => ch.id).join(',');
    if (enabledNow !== _lastEnabledIds) {
        _lastEnabledIds  = enabledNow;
        _forceYAutorange = true;
        if (stackMode) Object.keys(_chDataRange).forEach(k => delete _chDataRange[k]);
        // Reset EMA and mode buffer — new channel set means stale data is invalid
        _psdEma = null; _psdEmaCount = 0;
        _modeBuf = [];
        buildModeChannelPicker();
        buildSaveChannelPicker();
    }

    // Update status bar
    evCount++;
    const now = Date.now();
    if (now - evTs >= 1000) {
        evRateEl.innerHTML  = `<b>${evCount}</b> ev/s`;
        const lag = Math.round((Date.now() / 1000 - timestamp) * 1000);
        latencyEl.innerHTML = `latency <b>${lag}ms</b>`;
        evCount = 0;
        evTs    = now;
    }
    srEl.innerHTML  = `<b>${(sample_rate / 1e6).toFixed(3)}</b> MS/s`;
    traceEl.innerHTML = `<b>${Math.round(n_samples / sample_rate * 1000)}</b> ms trace`;

    // Build Plotly traces — enabled channels only, indexed by ch.id
    const nPts    = data[0]?.length ?? 0;
    const totalMs = n_samples / sample_rate * 1000;          // real trace duration
    traceDurationMs = totalMs;
    const t       = Array.from({length: nPts}, (_, i) => i / nPts * totalMs); // ms

    // Push current frame into ring buffer (needed for trigger pre/post-trigger window)
    updateTrigBuffer(data, nPts);

    // Apply trigger alignment
    const { data: trgData, t: trgT } = applyTrigger(data, t);

    // Update smoothed data range per channel (used by stack-mode Y-axis)
    if (stackMode) {
        const ALPHA = 0.15;   // smoothing: 0=frozen, 1=instant
        channelState.forEach(ch => {
            const arr = trgData[ch.id];
            if (!arr || arr.length === 0) return;
            let lo = arr[0], hi = arr[0];
            for (let i = 1; i < arr.length; i++) {
                if (arr[i] < lo) lo = arr[i];
                if (arr[i] > hi) hi = arr[i];
            }
            const prev = _chDataRange[ch.id];
            _chDataRange[ch.id] = prev
                ? { min: prev.min + ALPHA * (lo - prev.min),
                    max: prev.max + ALPHA * (hi - prev.max) }
                : { min: lo, max: hi };
        });
    }

    const enabledChs = channelState.filter(ch => ch.enabled);

    // ── Shared ring buffer (persist / avg) ────────────────────────────────
    const shouldBuffer = displayMode !== 'off' &&
        (!triggerState.enabled || _trigFiredThisFrame);
    if (shouldBuffer) {
        const snap = { t: trgT.slice(), chData: {} };
        enabledChs.forEach(ch => {
            if (_modeChannels.has(ch.id))
                snap.chData[ch.id] = (trgData[ch.id] ?? []).slice();
        });
        _modeBuf.push(snap);
        if (_modeBuf.length > displayN) _modeBuf.shift();
    }

    // Progress display
    const progEl = document.getElementById('mode-progress');
    if (progEl) progEl.textContent = `${_modeBuf.length}/${displayN}`;

    // ── Build Plotly traces ────────────────────────────────────────────────
    const traces = [];
    const modeChs = enabledChs.filter(ch => _modeChannels.has(ch.id));

    // Ghost traces (persist mode)
    if (displayMode === 'persist' && _modeBuf.length > 1) {
        const ghosts = _modeBuf.slice(0, -1);
        const nG = ghosts.length;
        ghosts.forEach((frame, fi) => {
            const alpha = 0.05 + 0.45 * ((fi + 1) / nG);
            modeChs.forEach(ch => {
                const color  = CH_COLORS[ch.id % CH_COLORS.length];
                const chIdx  = enabledChs.findIndex(c => c.id === ch.id);
                traces.push({
                    x: frame.t, y: frame.chData[ch.id] ?? [],
                    name: ch.name, showlegend: false,
                    type: 'scattergl', mode: 'lines',
                    line:   { color: hexToRgba(color, alpha), width: 1 },
                    marker: { size: 2, color: hexToRgba(color, alpha) },
                    yaxis:  stackMode ? (chIdx === 0 ? 'y' : `y${chIdx + 1}`) : 'y',
                });
            });
        });
    }

    // Rolling average computation
    const avgData = {};
    if (displayMode === 'avg' && _modeBuf.length > 0) {
        modeChs.forEach(ch => {
            const frames = _modeBuf.map(f => f.chData[ch.id]).filter(Boolean);
            if (frames.length === 0) return;
            const len = frames[0].length;
            const sum = new Float64Array(len);
            frames.forEach(f => { for (let i = 0; i < len; i++) sum[i] += f[i]; });
            avgData[ch.id] = Array.from(sum, v => v / frames.length);
        });
    }

    // Live / averaged traces (full opacity, on top)
    enabledChs.forEach((ch, i) => {
        const color  = CH_COLORS[ch.id % CH_COLORS.length];
        const inMode = _modeChannels.has(ch.id);
        const yRaw   = (inMode && displayMode === 'avg' && avgData[ch.id])
            ? avgData[ch.id]
            : (trgData[ch.id] ?? []);
        traces.push({
            x:      trgT,
            y:      yRaw,
            name:   ch.name,
            type:   'scattergl',
            mode:   PLOT_MODES[plotModeIdx],
            line:   { color, width: (inMode && displayMode === 'avg') ? 2 : 1 },
            marker: { size: 3, color },
            yaxis:  stackMode ? (i === 0 ? 'y' : `y${i + 1}`) : 'y',
        });
    });

    if (!plotInited) {
        initPlot(traces);
        plotInited = true;
    } else if (!_mouseDown) {
        Plotly.react('plot', traces, getLayout(), PLOTLY_CONFIG);
    }

    if (measureVisible)
        updateStatsTable(channelState.filter(ch => ch.enabled), data);

    updateFftPlot(payload);

    // warn if visible X window is wider than the trace
    const xRange = document.getElementById('plot')?._fullLayout?.xaxis?.range;
    if (xRange && traceDurationMs !== null) {
        const visible = xRange[1] - xRange[0];
        zoomWarnEl.hidden = visible <= traceDurationMs * 1.01; // 1% tolerance
    }
}

function initPlot(traces) {
    Plotly.newPlot('plot', traces, getLayout(), PLOTLY_CONFIG);
    if (!_relayoutListening) {
        _relayoutListening = true;
        const debouncedZoom = debounce(onZoomRelayout, 250);
        document.getElementById('plot').on('plotly_relayout', (ed) => {
            if (!ed) { debouncedZoom(); return; }

            // Shape[0] drag: horizontal trigger level line
            if (triggerState.enabled && ed['shapes[0].y0'] !== undefined) {
                const newY = parseFloat(ed['shapes[0].y0']);
                triggerState.level = newY;
                document.getElementById('trig-level').value     = newY.toFixed(2);
                document.getElementById('trig-level-num').value = newY.toFixed(2);
                _lastTriggerFrame = null;
                return;
            }

            // Shape[1] drag: vertical trigger position line
            if (triggerState.enabled && ed['shapes[1].x0'] !== undefined) {
                const newX = parseFloat(ed['shapes[1].x0']);
                const refMs = traceDurationMs ?? 1;
                triggerState.trigPos = Math.max(0, Math.min(0.95, newX / refMs));
                _lastTrigX       = null;
                _lastTriggerFrame = null;
                return;
            }

            // Zoom/pan → adaptive resolution
            debouncedZoom();
        });
    }
}

function onZoomRelayout() {
    const xRange = document.getElementById('plot')?._fullLayout?.xaxis?.range;
    if (!xRange || traceDurationMs == null || traceDurationMs <= 0) return;
    const viewMs = Math.max(1, xRange[1] - xRange[0]);
    sendControl({ type: 'set_pts', view_ms: viewMs, trace_ms: traceDurationMs });
}

function getLayout() {
    const plotEl = document.getElementById('plot');
    const currentLayout = plotEl?.layout ?? {};
    const xCurrent = currentLayout.xaxis ?? {};

    const pc = getPlotColors();

    const xaxis = {
        title: 'Time (ms)',
        gridcolor: pc.grid,
        color: pc.muted,
        zeroline: false,
    };

    // Always set an explicit x range so Plotly never adds per-mode padding
    // (markers mode adds ~5% padding by default, making the axis narrower than lines mode).
    // User zoom overrides this; default is the full trace duration [0, totalMs].
    if (xCurrent.autorange === false && xCurrent.range) {
        xaxis.range     = xCurrent.range;
        xaxis.autorange = false;
    } else if (traceDurationMs != null) {
        xaxis.range     = [0, traceDurationMs];
        xaxis.autorange = false;
    }

    const shapes = [];
    const layout = {
        paper_bgcolor: pc.bg,
        plot_bgcolor:  pc.bg,
        font:  { color: pc.text, size: 11 },
        dragmode: 'pan',
        xaxis,
        shapes,
        legend: {
            bgcolor: document.body.dataset.theme === 'light'
                ? 'rgba(255,255,255,0.65)' : 'rgba(13,17,23,0.65)',
            bordercolor: pc.border,
            borderwidth: 1,
        },
        margin: { l: 60, r: 16, t: 8, b: 44 },
    };

    if (stackMode) {
        // X axis pinned to the bottom of the paper (below all subplots)
        xaxis.anchor   = 'free';
        xaxis.position = 0;

        // Each enabled channel gets its own Y axis / subplot row
        const enabled = channelState.filter(ch => ch.enabled);
        const N = enabled.length;
        layout.showlegend = false;

        if (N > 0) {
            const gap    = N > 1 ? 0.02 : 0;
            const sliceH = (1 - gap * (N - 1)) / N;

            enabled.forEach((ch, i) => {
                const axKey   = i === 0 ? 'yaxis' : `yaxis${i + 1}`;
                const yTop    = 1 - i * (sliceH + gap);
                const yBottom = Math.max(0, yTop - sliceH);
                const color = CH_COLORS[ch.id % CH_COLORS.length];

                // Derive Y range from actual smoothed data (handles DC offset + noise correctly).
                // Falls back to amplitude-based estimate before first data frame arrives.
                let rangeMin, rangeMax;
                const dr = _chDataRange[ch.id];
                if (dr) {
                    const center   = (dr.min + dr.max) / 2;
                    const halfSpan = Math.max((dr.max - dr.min) / 2, 0.01);
                    const pad      = halfSpan * 0.25 + 0.01;
                    rangeMin = center - halfSpan - pad;
                    rangeMax = center + halfSpan + pad;
                } else {
                    const baseAmp  = ch.amplitude ?? 1;
                    const noiseAmp = (ch.noise && ch.noise_amp > 0) ? (ch.noise_amp ?? 0) : 0;
                    const amp      = Math.max(baseAmp + noiseAmp, 0.001) * 1.2;
                    rangeMin = -amp; rangeMax = amp;
                }

                layout[axKey] = {
                    domain:     [yBottom, yTop],
                    range:      [rangeMin, rangeMax],
                    gridcolor:  pc.grid,
                    color,
                    zeroline:   true,
                    zerolinecolor: pc.zero,
                    showticklabels: true,
                    tickformat: '.2f',
                    ticksuffix: 'V',
                    nticks:     5,
                    title:      { text: ch.name, font: { color, size: 10 }, standoff: 6 },
                    showgrid:   true,
                };
            });
        }

        // Trigger level line — on the source channel's axis
        if (triggerState.enabled) {
            const trgColor = CH_COLORS[triggerState.source % CH_COLORS.length];
            const enabled2 = channelState.filter(ch => ch.enabled);
            const srcIdx   = enabled2.findIndex(ch => ch.id === triggerState.source);
            const yref     = srcIdx <= 0 ? 'y' : `y${srcIdx + 1}`;
            shapes.push({
                type: 'line', x0: 0, x1: 1, xref: 'paper',
                y0: triggerState.level, y1: triggerState.level, yref,
                editable: true,
                line: { color: trgColor, dash: 'dash', width: 2 },
            });
            const trigX = _lastTrigX ?? (triggerState.trigPos * (traceDurationMs ?? 0));
            shapes.push({
                type: 'line', x0: trigX, x1: trigX, xref: 'x',
                y0: 0, y1: 1, yref: 'paper',
                editable: true,
                line: { color: trgColor, dash: 'dot', width: 2 },
            });
        }

    } else {
        // Single shared Y axis
        const yCurrent = currentLayout.yaxis ?? {};
        layout.yaxis = {
            title:     'Amplitude',
            gridcolor: pc.grid,
            color:     pc.muted,
            zeroline:  false,
        };
        // Preserve user Y zoom — but NOT when the enabled-channel set just changed
        if (!_forceYAutorange && yCurrent.autorange === false && yCurrent.range) {
            layout.yaxis.range     = yCurrent.range;
            layout.yaxis.autorange = false;
        }

        // Trigger shapes on shared axis
        if (triggerState.enabled) {
            const trgColor = CH_COLORS[triggerState.source % CH_COLORS.length];
            shapes.push({
                type: 'line', x0: 0, x1: 1, xref: 'paper',
                y0: triggerState.level, y1: triggerState.level, yref: 'y',
                editable: true,
                line: { color: trgColor, dash: 'dash', width: 2 },
            });
            const trigX = _lastTrigX ?? (triggerState.trigPos * (traceDurationMs ?? 0));
            shapes.push({
                type: 'line', x0: trigX, x1: trigX, xref: 'x',
                y0: 0, y1: 1, yref: 'paper',
                editable: true,
                line: { color: trgColor, dash: 'dot', width: 2 },
            });
        }
    }

    _forceYAutorange = false;   // consumed — reset for next frame
    return layout;
}


// ── FFT / Welch PSD ────────────────────────────────────────────────────────

function updateFftPlot(payload) {
    if (!fftVisible || !payload.psd_freqs) return;

    const freqs   = payload.psd_freqs;      // Hz
    const psdData = payload.psd_power;      // V²/Hz, shape [n_ch][n_freqs], single frame
    const nCh     = psdData.length;
    const nFreqs  = freqs.length;

    // ── EMA accumulation ──────────────────────────────────────────────────
    _psdEmaCount = Math.min(_psdEmaCount + 1, fftAvgN);
    const alpha  = 1 / _psdEmaCount;
    const beta   = 1 - alpha;

    if (_psdEma === null || _psdEma.length !== nCh || _psdEma[0].length !== nFreqs) {
        // First frame or dimension change — copy as-is
        _psdEma = psdData.map(ch => Float64Array.from(ch));
    } else {
        for (let ci = 0; ci < nCh; ci++) {
            const ema = _psdEma[ci];
            const src = psdData[ci];
            for (let fi = 0; fi < nFreqs; fi++)
                ema[fi] = beta * ema[fi] + alpha * src[fi];
        }
    }

    document.getElementById('fft-n-avg').textContent = `${_psdEmaCount}/${fftAvgN}`;

    const pc = getPlotColors();
    const enabledChs = channelState.filter(ch => ch.enabled);
    const traces = enabledChs.map(ch => {
        const psd   = _psdEma[ch.id];   // EMA-averaged V²/Hz array
        const color = CH_COLORS[ch.id % CH_COLORS.length];
        // V²/Hz → V/√Hz = √psd  → dBV/√Hz = 10·log10(psd)
        const yVals = fftUnitIdx === 0 ? psd
            : fftUnitIdx === 1 ? psd.map(v => Math.sqrt(Math.max(v, 0)))
            :                    psd.map(v => 10 * Math.log10(Math.max(v, 1e-30)));
        return {
            x: freqs, y: yVals,
            name: ch.name,
            type: 'scattergl', mode: 'lines',
            line: { color, width: 1 },
        };
    });

    const xType = fftLogX ? 'log' : 'linear';
    const yType = fftLogY ? 'log' : 'linear';
    // Default X range: first non-DC bin → 1 MHz
    // Using freqs[1] (= Δf = fs/N) as lower bound avoids the blank gap
    // that appears when the trace is short (e.g. 10 ms → Δf = 100 Hz).
    const fDataMin = freqs[1] ?? freqs[0];   // first non-DC frequency bin
    const defXMin  = fftLogX ? Math.log10(Math.max(fDataMin, 1e-3)) : fDataMin;
    const defXMax  = fftLogX ? 6 : 1_000_000;   // fixed upper bound: 1 MHz

    // Preserve user zoom across react() calls; reset on _fftInited (unit/log change)
    const fftEl  = document.getElementById('fft-plot');
    const xCur   = fftEl?._fullLayout?.xaxis;
    const yCur   = fftEl?._fullLayout?.yaxis;
    const xRange = (_fftInited && xCur?.autorange === false && xCur.type === xType)
        ? xCur.range : [defXMin, defXMax];

    // Y range: preserve user zoom; on first plot or unit/log change, compute
    // a sensible range from the EMA data (avoids Plotly autorange hitting 1e-30 noise floor)
    let yRange;
    if (_fftInited && yCur?.autorange === false && yCur.type === yType) {
        yRange = yCur.range;   // user has zoomed — keep it
    } else if (fftLogY && _psdEma) {
        // Find min/max of log10(psd) across enabled channels (skip DC bin 0).
        // _psdEma is in V²/Hz; convert to log space of the *plotted* unit:
        //   V²/Hz → as-is  →  plotLog = log10(psd)
        //   V/√Hz → √(psd) →  plotLog = 0.5 × log10(psd)
        const scale = (fftUnitIdx === 1) ? 0.5 : 1.0;
        let maxLog = -Infinity, minLog = Infinity;
        for (const ch of enabledChs) {
            const ema = _psdEma[ch.id];
            if (!ema) continue;
            for (let fi = 1; fi < nFreqs; fi++) {
                if (ema[fi] > 1e-100) {
                    const v = Math.log10(ema[fi]);
                    if (v > maxLog) maxLog = v;
                    if (v < minLog) minLog = v;
                }
            }
        }
        if (isFinite(maxLog) && isFinite(minLog)) {
            const pMax = scale * maxLog;
            const pMin = scale * minLog;
            // Top: half-decade above peak; Bottom: 50% below the spectrum minimum
            // 50% in linear = ×0.5 → log10(0.5) ≈ −0.30 decades below pMin
            yRange = [pMin - 0.30, pMax + 0.5];
        } else {
            yRange = [-6, 0];
        }
    }

    const layout = {
        paper_bgcolor: pc.bgAlt,   /* FFT panel uses distinct --bg-alt */
        plot_bgcolor:  pc.bgAlt,
        font:  { color: pc.text, size: 10 },
        margin: { l: 68, r: 16, t: 4, b: 44 },
        xaxis: {
            title: 'Frequency (Hz)',
            type:  xType,
            range: xRange,
            autorange: false,
            gridcolor: pc.grid,
            color: pc.muted,
        },
        yaxis: {
            title: FFT_UNITS[fftUnitIdx],
            type:  yType,
            ...(yRange ? { range: yRange, autorange: false } : { autorange: true }),
            gridcolor: pc.grid,
            color: pc.muted,
        },
        showlegend: true,
        legend: {
            bgcolor:     document.body.dataset.theme === 'light'
                             ? 'rgba(232,240,255,0.65)' : 'rgba(10,22,40,0.65)',
            borderwidth: 0,
            font:        { size: 10, color: pc.text },
            x: 1, xanchor: 'right',
            y: 1, yanchor: 'top',
        },
        dragmode: 'zoom',
    };

    if (!_fftInited) {
        Plotly.newPlot('fft-plot', traces, layout, PLOTLY_CONFIG);
        _fftInited = true;
    } else {
        Plotly.react('fft-plot', traces, layout, PLOTLY_CONFIG);
    }
}


// ── Trigger ────────────────────────────────────────────────────────────────

// Maintain a 3-frame ring buffer so trigger always has enough pre/post data.
function updateTrigBuffer(data, nPts) {
    const nCh = data.length;
    if (nPts === 0 || nCh === 0) return;

    // Reset if dimensions changed (e.g. zoom resolution change)
    if (!_trigBuf || _trigBufNPts !== nPts || _trigBuf.length !== nCh) {
        _trigBuf      = Array.from({ length: nCh }, () => new Float64Array(TRIG_BUF_FRAMES * nPts));
        _trigBufNPts  = nPts;
        _trigBufCount = 0;
    }

    // Shift all channels left by nPts and append new frame at the end
    const offset = (TRIG_BUF_FRAMES - 1) * nPts;
    for (let c = 0; c < nCh; c++) {
        _trigBuf[c].copyWithin(0, nPts);
        for (let i = 0; i < nPts; i++) _trigBuf[c][offset + i] = data[c][i];
    }
    _trigBufCount = Math.min(_trigBufCount + 1, TRIG_BUF_FRAMES);
}

function applyTrigger(data, t) {
    _trigFiredThisFrame = false;
    if (!triggerState.enabled) {
        _lastTrigX = null;
        return { data, t };
    }

    // Wait for ring buffer to fill so both sides of the trigger window have data
    if (!_trigBuf || _trigBufCount < TRIG_BUF_FRAMES) {
        _lastTrigX = null;
        return { data, t };
    }

    const n  = _trigBufNPts;
    const dt = t.length > 1 ? t[1] - t[0] : 0;

    // Search for trigger across F2+F3 (the two newest frames).
    // Starting at n+1 (start of F2) ensures prePts ≤ 0.95n → startIdx ≥ 0.05n,
    // so pre-trigger data is always drawn from valid F1/F2 samples.
    // With phase-continuous fake_daq (t_offset never resets), there is no
    // discontinuity at frame boundaries, so a wider search window is safe.
    // This prevents the trigger from missing every other frame when the source
    // frequency causes its edge to fall outside F3 (e.g. 50 Hz + 10 ms frames).
    const searchStart = n + 1;
    const searchEnd   = TRIG_BUF_FRAMES * n;

    const src   = _trigBuf[triggerState.source];
    const level = triggerState.level;
    const hyst  = triggerState.hyst;
    const edge  = triggerState.edge;
    let   bufIdx = -1;

    // Hysteresis: signal must first arm (cross past level±hyst) before it can trigger.
    // This suppresses re-triggering on noise ripple around the threshold.
    if (edge === 'rising') {
        let armed = src[searchStart - 1] < (level - hyst);
        for (let i = searchStart; i < searchEnd; i++) {
            if (src[i - 1] < (level - hyst)) armed = true;
            if (armed && src[i - 1] < level && src[i] >= level) { bufIdx = i; break; }
        }
    } else if (edge === 'falling') {
        let armed = src[searchStart - 1] > (level + hyst);
        for (let i = searchStart; i < searchEnd; i++) {
            if (src[i - 1] > (level + hyst)) armed = true;
            if (armed && src[i - 1] > level && src[i] <= level) { bufIdx = i; break; }
        }
    }

    if (bufIdx >= 0) {
        _trigFiredThisFrame = true;
        // trigPos defines how many samples appear BEFORE the trigger crossing.
        // Position line is fixed at trigPos * totalMs — never changes with level.
        const prePts     = Math.round(triggerState.trigPos * n);
        const startIdx   = bufIdx - prePts;   // always ≥ 0 since bufIdx ≥ n ≥ prePts
        const fixedTrigX = triggerState.trigPos * (traceDurationMs ?? 0);
        _lastTrigX = fixedTrigX;

        // Extract exactly n samples; time axis 0→totalMs; trigger always at fixedTrigX
        const newT = Array.from({ length: n }, (_, i) => i * dt);

        _lastTriggerFrame = {
            data: _trigBuf.map(ch => Array.from(ch.subarray(startIdx, startIdx + n))),
            t:    newT,
        };
        return _lastTriggerFrame;
    }

    // Missed trigger
    _trigFiredThisFrame = false;
    _lastTrigX = null;
    if (triggerState.mode === 'auto') return { data, t };
    return _lastTriggerFrame ?? { data, t };
}

// ── Measurements ───────────────────────────────────────────────────────────

const STAT_KEYS = [
    'min','max','vpp','mean','rms','std',
    'freq','period','duty','riseTime','fallTime',
];

const STAT_GROUPS = {
    'Amplitude':   ['min','max','vpp','mean','rms','std'],
    'Time Domain': ['freq','period','duty','riseTime','fallTime'],
};
const STAT_LABEL = {
    min:'Min', max:'Max', vpp:'Vpp', mean:'Mean',
    rms:'RMS', std:'Std',
    freq:'Freq', period:'Period', duty:'Duty', riseTime:'Rise', fallTime:'Fall',
};

// All measurements visible by default
const statVisible = new Set(STAT_KEYS);

function buildStatsConfigBar() {
    const bar = document.getElementById('stats-config-sidebar');
    bar.innerHTML = '';
    Object.entries(STAT_GROUPS).forEach(([groupName, keys]) => {
        const group = document.createElement('div');
        group.className = 'stat-cfg-group';

        // Group header: label + All / None buttons
        const hdr = document.createElement('div');
        hdr.className = 'stat-cfg-group-header';
        const label = document.createElement('span');
        label.className = 'stat-cfg-group-label';
        label.textContent = groupName;
        hdr.appendChild(label);

        ['All', 'None'].forEach(action => {
            const btn = document.createElement('button');
            btn.className = 'stat-cfg-group-btn';
            btn.textContent = action;
            btn.addEventListener('click', () => {
                keys.forEach(k => {
                    if (action === 'All') statVisible.add(k); else statVisible.delete(k);
                    const cb = document.getElementById(`scb-${k}`);
                    if (cb) cb.checked = action === 'All';
                });
                updateStatsVisibility();
            });
            hdr.appendChild(btn);
        });
        group.appendChild(hdr);

        const pillsContainer = document.createElement('div');
        pillsContainer.className = 'stat-cfg-pills';
        keys.forEach(k => {
            const id = `scb-${k}`;
            const pill = document.createElement('label');
            pill.className = 'stat-cfg-pill';
            pill.htmlFor = id;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.id = id;
            cb.checked = statVisible.has(k);
            cb.addEventListener('change', () => {
                if (cb.checked) statVisible.add(k); else statVisible.delete(k);
                updateStatsVisibility();
            });
            pill.appendChild(cb);
            pill.appendChild(document.createTextNode(STAT_LABEL[k]));
            pillsContainer.appendChild(pill);
        });
        group.appendChild(pillsContainer);
        bar.appendChild(group);
    });
}

function updateStatsVisibility() {
    // Header row cells
    document.querySelectorAll('#stats-table thead tr:nth-child(2) th[data-stat]').forEach(th => {
        th.style.display = statVisible.has(th.dataset.stat) ? '' : 'none';
    });
    // Data cells
    document.querySelectorAll('#stats-body td[data-stat]').forEach(td => {
        td.style.display = statVisible.has(td.dataset.stat) ? '' : 'none';
    });
    // Update group header colspans
    const ampCount  = STAT_GROUPS['Amplitude'].filter(k => statVisible.has(k)).length;
    const timeCount = STAT_GROUPS['Time Domain'].filter(k => statVisible.has(k)).length;
    const [ampTh, timeTh] = document.querySelectorAll('#stats-table .th-group');
    if (ampTh)  { ampTh.colSpan  = Math.max(1, ampCount);  ampTh.style.display  = ampCount  ? '' : 'none'; }
    if (timeTh) { timeTh.colSpan = Math.max(1, timeCount); timeTh.style.display = timeCount ? '' : 'none'; }
}

function fmtStat(key, val) {
    if (val === null || val === undefined) return '—';
    switch (key) {
        case 'freq':                 return val >= 100 ? val.toFixed(0)
                                          : val >= 10  ? val.toFixed(1)
                                          :              val.toFixed(2);
        case 'period':               return val.toFixed(3);
        case 'duty':                 return val.toFixed(1);
        case 'riseTime':
        case 'fallTime':             return val >= 1000 ? val.toFixed(0) : val.toFixed(1);
        default:                     return val.toFixed(4);
    }
}

function computeStats(arr) {
    const n = arr.length;
    if (n === 0) return null;

    // ── Amplitude stats ──────────────────────────────────────────────────
    let min = arr[0], max = arr[0], sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum   += v;
        sumSq += v * v;
    }
    const mean   = sum / n;
    const rms    = Math.sqrt(sumSq / n);
    const std    = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    const vpp    = max - min;

    // ── Time-domain stats ────────────────────────────────────────────────
    const dtMs = (traceDurationMs ?? 0) / n;   // ms per sample

    // Frequency: count positive-going zero crossings (relative to mean)
    let crossings = 0;
    for (let i = 1; i < n; i++) {
        if ((arr[i - 1] - mean) < 0 && (arr[i] - mean) >= 0) crossings++;
    }
    const freq   = (crossings > 0 && traceDurationMs > 0)
                    ? crossings / (traceDurationMs / 1000)
                    : null;
    const period = freq ? 1000 / freq : null;   // ms

    // Duty cycle: fraction of samples above midpoint (min+max)/2
    const midpoint = (min + max) / 2;
    let above = 0;
    for (let i = 0; i < n; i++) if (arr[i] >= midpoint) above++;
    const duty = (above / n) * 100;

    // Rise time (10% → 90%) and Fall time (90% → 10%), in µs
    let riseTime = null, fallTime = null;
    if (vpp > 1e-9 && dtMs > 0) {
        const lo = min + 0.1 * vpp;
        const hi = min + 0.9 * vpp;

        let iLo = -1;
        for (let i = 0; i < n; i++) {
            if (iLo < 0) {
                if (arr[i] <= lo) iLo = i;
            } else {
                if (arr[i] >= hi) { riseTime = (i - iLo) * dtMs * 1000; break; }
                if (arr[i] <  lo) iLo = i;   // reset: dipped back below 10%
            }
        }

        let iHi = -1;
        for (let i = 0; i < n; i++) {
            if (iHi < 0) {
                if (arr[i] >= hi) iHi = i;
            } else {
                if (arr[i] <= lo) { fallTime = (i - iHi) * dtMs * 1000; break; }
                if (arr[i] >  hi) iHi = i;   // reset: rose back above 90%
            }
        }
    }

    return { min, max, vpp, mean, rms, std,
             freq, period, duty, riseTime, fallTime };
}

let _statsChannelIds = [];   // tracks which rows exist in the table

function updateStatsTable(enabledChannels, data) {
    const tbody = document.getElementById('stats-body');
    const ids   = enabledChannels.map(ch => ch.id);

    // rebuild rows only when the enabled-channel set changes
    if (ids.join(',') !== _statsChannelIds.join(',')) {
        _statsChannelIds = ids;
        _statsEma = {};
        _statsEvar = {};
        _statsEmaCount = 0;
        tbody.innerHTML  = '';
        enabledChannels.forEach(ch => {
            const color = CH_COLORS[ch.id % CH_COLORS.length];
            const tr    = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="stat-dot" style="background:${color}"></span>${ch.name}</td>
                ${STAT_KEYS.map(k => `<td id="st-${ch.id}-${k}" data-stat="${k}">—</td>`).join('')}
            `;
            tbody.appendChild(tr);
        });
        updateStatsVisibility();
    }

    // EMA accumulation + display
    _statsEmaCount = Math.min(_statsEmaCount + 1, statsAvgN);
    const alpha = 1 / _statsEmaCount;
    const statsNAvgEl = document.getElementById('stats-n-avg');
    if (statsNAvgEl) statsNAvgEl.textContent = `${_statsEmaCount}/${statsAvgN}`;
    const beta  = 1 - alpha;

    enabledChannels.forEach(ch => {
        const arr = data[ch.id];
        if (!arr || arr.length === 0) return;
        const s = computeStats(arr);
        if (!_statsEma[ch.id])  _statsEma[ch.id]  = {};
        if (!_statsEvar[ch.id]) _statsEvar[ch.id] = {};
        const ema  = _statsEma[ch.id];
        const evar = _statsEvar[ch.id];

        STAT_KEYS.forEach(k => {
            const v = s[k];
            if (v != null && isFinite(v)) {
                const prev = ema[k];
                // EMA variance: computed before mean update (Welford-style EMA)
                evar[k] = (prev == null) ? 0
                    : beta * (evar[k] ?? 0) + alpha * (v - prev) ** 2;
                ema[k]  = (prev == null) ? v : beta * prev + alpha * v;
            }
            const el = document.getElementById(`st-${ch.id}-${k}`);
            if (!el) return;
            const mu  = ema[k]  ?? null;
            const sig = (evar[k] != null && _statsEmaCount > 1)
                ? Math.sqrt(evar[k]) : null;
            if (mu === null) { el.textContent = '—'; return; }
            const sigStr = (sig !== null && isFinite(sig) && sig > 0)
                ? `<span class="stat-err">(±${fmtStat(k, sig)})</span>` : '';
            el.innerHTML = fmtStat(k, mu) + sigStr;
        });
    });
}


// ── Channel sidebar ────────────────────────────────────────────────────────

function syncChannelState(channels) {
    // first time: build sidebar cards
    if (channelState.length === 0) {
        channelState = channels.map(ch => ({ ...ch }));
        buildSidebar();
        return;
    }
    // update names if changed; do NOT overwrite enabled (client toggle is authoritative)
    channels.forEach(ch => {
        const s = channelState.find(s => s.id === ch.id);
        if (s) {
            s.name = ch.name;
        }
    });
}

function buildSidebar() {
    // Populate trigger source dropdown with current channel names
    const trigSrc = document.getElementById('trig-source');
    trigSrc.innerHTML = channelState.map(ch =>
        `<option value="${ch.id}" ${ch.id === triggerState.source ? 'selected' : ''}>${ch.name}</option>`
    ).join('');

    channelList.innerHTML = '';
    channelState.forEach(ch => {
        const card = document.createElement('div');
        card.className = `ch-card ${ch.enabled ? '' : 'disabled'}`;
        card.id = `ch-card-${ch.id}`;

        const color = CH_COLORS[ch.id % CH_COLORS.length];

        const freqDisabled = ch.signal === 'dc' ? 'disabled' : '';
        const noiseAmpDisabled = ch.noise ? '' : 'disabled';
        card.innerHTML = `
            <div class="ch-header">
                <div class="ch-dot" style="background:${color}"></div>
                <span class="ch-name">${ch.name}</span>
                <button class="ch-toggle ${ch.enabled ? 'on' : ''}"
                        id="toggle-${ch.id}" title="Enable/disable"></button>
            </div>
            <div class="ch-controls">
                <div>
                    <label>Signal</label>
                    <select id="sig-${ch.id}">
                        ${SIGNAL_TYPES.map(s =>
                            `<option value="${s}" ${s===ch.signal?'selected':''}>${s}</option>`
                        ).join('')}
                    </select>
                </div>
                <div>
                    <label>Freq (Hz)</label>
                    <input type="number" id="freq-${ch.id}"
                           value="${ch.freq_hz}" min="0" max="500000" step="1" ${freqDisabled}>
                </div>
                <div class="amp-row">
                    <label>Amplitude</label>
                    <div class="range-num">
                        <input type="range"  id="amp-${ch.id}"
                               value="${ch.amplitude}" min="0" max="2" step="0.01">
                        <input type="number" id="amp-num-${ch.id}"
                               value="${ch.amplitude}" min="0" max="2" step="0.01">
                    </div>
                </div>
                <div class="noise-amp-row">
                    <button class="noise-btn ${ch.noise ? 'active' : ''}"
                            id="noise-btn-${ch.id}">+ Noise</button>
                    <div class="range-num">
                        <input type="range"  id="noise-amp-${ch.id}"
                               value="${(ch.noise_amp ?? 0.1).toFixed(2)}" min="0" max="2" step="0.01"
                               ${noiseAmpDisabled}>
                        <input type="number" id="noise-amp-num-${ch.id}"
                               value="${(ch.noise_amp ?? 0.1).toFixed(2)}" min="0" max="2" step="0.01"
                               ${noiseAmpDisabled}>
                    </div>
                </div>
                <div class="pulse-params" id="pulse-params-${ch.id}"
                     style="display:${ch.signal === 'pulse' ? 'block' : 'none'}">
                    <div class="tau-row">
                        <label>τ rise (ms)</label>
                        <div class="range-num">
                            <input type="range"  id="tau-rise-${ch.id}"
                                   value="${(ch.tau_rise_ms ?? 0.5).toFixed(2)}" min="0.05" max="5" step="0.05">
                            <input type="number" id="tau-rise-num-${ch.id}"
                                   value="${(ch.tau_rise_ms ?? 0.5).toFixed(2)}" min="0.05" max="5" step="0.05">
                        </div>
                    </div>
                    <div class="tau-row">
                        <label>τ fall (ms)</label>
                        <div class="range-num">
                            <input type="range"  id="tau-fall-${ch.id}"
                                   value="${(ch.tau_fall_ms ?? 3.0).toFixed(2)}" min="0.1" max="20" step="0.1">
                            <input type="number" id="tau-fall-num-${ch.id}"
                                   value="${(ch.tau_fall_ms ?? 3.0).toFixed(2)}" min="0.1" max="20" step="0.1">
                        </div>
                    </div>
                </div>
            </div>
        `;

        channelList.appendChild(card);

        // toggle
        document.getElementById(`toggle-${ch.id}`).addEventListener('click', () => {
            ch.enabled = !ch.enabled;
            const btn  = document.getElementById(`toggle-${ch.id}`);
            const crd  = document.getElementById(`ch-card-${ch.id}`);
            btn.classList.toggle('on', ch.enabled);
            crd.classList.toggle('disabled', !ch.enabled);
            sendControl({ channel: ch.id, enabled: ch.enabled });
        });

        // signal type
        document.getElementById(`sig-${ch.id}`).addEventListener('change', (e) => {
            ch.signal = e.target.value;
            document.getElementById(`freq-${ch.id}`).disabled = ch.signal === 'dc';
            document.getElementById(`pulse-params-${ch.id}`).style.display =
                ch.signal === 'pulse' ? 'block' : 'none';
            sendControl({ channel: ch.id, signal: ch.signal });
        });

        // frequency
        document.getElementById(`freq-${ch.id}`).addEventListener('change', (e) => {
            ch.freq_hz = parseFloat(e.target.value) || 0;
            sendControl({ channel: ch.id, freq_hz: ch.freq_hz });
        });

        // amplitude — slider and number input sync
        document.getElementById(`amp-${ch.id}`).addEventListener('input', (e) => {
            ch.amplitude = parseFloat(e.target.value);
            document.getElementById(`amp-num-${ch.id}`).value = ch.amplitude.toFixed(2);
            sendControl({ channel: ch.id, amplitude: ch.amplitude });
        });
        document.getElementById(`amp-num-${ch.id}`).addEventListener('change', (e) => {
            ch.amplitude = Math.max(0, Math.min(2, parseFloat(e.target.value) || 0));
            e.target.value = ch.amplitude.toFixed(2);
            document.getElementById(`amp-${ch.id}`).value = ch.amplitude;
            sendControl({ channel: ch.id, amplitude: ch.amplitude });
        });

        // noise toggle
        document.getElementById(`noise-btn-${ch.id}`).addEventListener('click', () => {
            ch.noise = !ch.noise;
            document.getElementById(`noise-btn-${ch.id}`).classList.toggle('active', ch.noise);
            document.getElementById(`noise-amp-${ch.id}`).disabled     = !ch.noise;
            document.getElementById(`noise-amp-num-${ch.id}`).disabled = !ch.noise;
            sendControl({ channel: ch.id, noise: ch.noise });
        });

        // τ rise — slider and number input sync
        document.getElementById(`tau-rise-${ch.id}`).addEventListener('input', (e) => {
            ch.tau_rise_ms = parseFloat(e.target.value);
            document.getElementById(`tau-rise-num-${ch.id}`).value = ch.tau_rise_ms.toFixed(2);
            sendControl({ channel: ch.id, tau_rise_ms: ch.tau_rise_ms });
        });
        document.getElementById(`tau-rise-num-${ch.id}`).addEventListener('change', (e) => {
            ch.tau_rise_ms = Math.max(0.05, Math.min(5, parseFloat(e.target.value) || 0.5));
            e.target.value = ch.tau_rise_ms.toFixed(2);
            document.getElementById(`tau-rise-${ch.id}`).value = ch.tau_rise_ms;
            sendControl({ channel: ch.id, tau_rise_ms: ch.tau_rise_ms });
        });

        // τ fall — slider and number input sync
        document.getElementById(`tau-fall-${ch.id}`).addEventListener('input', (e) => {
            ch.tau_fall_ms = parseFloat(e.target.value);
            document.getElementById(`tau-fall-num-${ch.id}`).value = ch.tau_fall_ms.toFixed(2);
            sendControl({ channel: ch.id, tau_fall_ms: ch.tau_fall_ms });
        });
        document.getElementById(`tau-fall-num-${ch.id}`).addEventListener('change', (e) => {
            ch.tau_fall_ms = Math.max(0.1, Math.min(20, parseFloat(e.target.value) || 3.0));
            e.target.value = ch.tau_fall_ms.toFixed(2);
            document.getElementById(`tau-fall-${ch.id}`).value = ch.tau_fall_ms;
            sendControl({ channel: ch.id, tau_fall_ms: ch.tau_fall_ms });
        });

        // noise amplitude — slider and number input sync
        document.getElementById(`noise-amp-${ch.id}`).addEventListener('input', (e) => {
            ch.noise_amp = parseFloat(e.target.value);
            document.getElementById(`noise-amp-num-${ch.id}`).value = ch.noise_amp.toFixed(2);
            sendControl({ channel: ch.id, noise_amp: ch.noise_amp });
        });
        document.getElementById(`noise-amp-num-${ch.id}`).addEventListener('change', (e) => {
            ch.noise_amp = Math.max(0, Math.min(2, parseFloat(e.target.value) || 0));
            e.target.value = ch.noise_amp.toFixed(2);
            document.getElementById(`noise-amp-${ch.id}`).value = ch.noise_amp;
            sendControl({ channel: ch.id, noise_amp: ch.noise_amp });
        });
    });
    buildModeChannelPicker();
    buildSaveChannelPicker();
}


// ── Mode channel picker ────────────────────────────────────────────────────

function buildModeChannelPicker() {
    const picker = document.getElementById('mode-ch-picker');
    if (!picker) return;
    picker.innerHTML = '';
    _modeChannels.clear();
    channelState.filter(ch => ch.enabled).forEach(ch => {
        _modeChannels.add(ch.id);
        const color = CH_COLORS[ch.id % CH_COLORS.length];
        const label = document.createElement('label');
        label.className = 'mode-ch-item';
        label.innerHTML =
            `<input type="checkbox" checked data-chid="${ch.id}">` +
            `<span class="mode-ch-dot" style="background:${color}"></span>` +
            `<span class="mode-ch-name">${ch.name}</span>`;
        label.querySelector('input').addEventListener('change', e => {
            if (e.target.checked) _modeChannels.add(ch.id);
            else _modeChannels.delete(ch.id);
            _modeBuf = [];
        });
        picker.appendChild(label);
    });
}


// ── Save channel picker ────────────────────────────────────────────────────

function buildSaveChannelPicker() {
    const picker = document.getElementById('save-ch-picker');
    if (!picker) return;
    picker.innerHTML = '';
    saveChannels.clear();
    channelState.filter(ch => ch.enabled).forEach(ch => {
        saveChannels.add(ch.id);
        const color = CH_COLORS[ch.id % CH_COLORS.length];
        const label = document.createElement('label');
        label.className = 'mode-ch-item';
        label.innerHTML =
            `<input type="checkbox" checked data-chid="${ch.id}">` +
            `<span class="mode-ch-dot" style="background:${color}"></span>` +
            `<span class="mode-ch-name">${ch.name}</span>`;
        label.querySelector('input').addEventListener('change', e => {
            if (e.target.checked) saveChannels.add(ch.id);
            else saveChannels.delete(ch.id);
        });
        picker.appendChild(label);
    });
}


// ── Save functions ─────────────────────────────────────────────────────────

async function startSave() {
    const n        = Math.max(1, parseInt(document.getElementById('save-n-events').value) || 1);
    const fmt      = document.getElementById('save-format').value;
    const waveform = document.getElementById('save-waveform').checked;
    const fft      = document.getElementById('save-fft').checked;
    const prefix   = document.getElementById('save-prefix').value.trim();
    const useTs  = document.getElementById('save-suffix-ts')?.checked  ?? true;
    const useNum = document.getElementById('save-suffix-num')?.checked ?? false;
    const suffixMode = (useTs && useNum) ? 'both' : useNum ? 'number' : 'timestamp';

    if (!waveform && !fft) { alert('Select at least Waveform or FFT.'); return; }
    if (saveChannels.size === 0) { alert('Select at least one channel.'); return; }

    try {
        const res  = await fetch('/api/save/start', {
            method:  'POST',
            headers: {'Content-Type': 'application/json'},
            body:    JSON.stringify({
                n_events: n, format: fmt,
                include_waveform: waveform, include_fft: fft,
                channels: [...saveChannels], prefix, suffix_mode: suffixMode,
            }),
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Save failed to start.'); return; }
        _saveToken = data.token;
        setSaveCollecting(true, n);
        _savePollTimer = setInterval(() => pollSaveStatus(), 800);
    } catch (e) {
        alert('Save request failed: ' + e.message);
    }
}

async function pollSaveStatus() {
    try {
        const res  = await fetch(`/api/save/status/${_saveToken}`);
        const data = await res.json();
        if (data.status === 'collecting') {
            const pct = data.total > 0 ? data.collected / data.total * 100 : 0;
            document.getElementById('save-progress-fill').style.width = pct + '%';
            document.getElementById('save-progress-text').textContent =
                `${data.collected} / ${data.total}`;
        } else if (data.status === 'ready') {
            clearInterval(_savePollTimer);
            _savePollTimer = null;
            triggerDownload(_saveToken);
            setSaveCollecting(false);
        } else if (data.status === 'error') {
            clearInterval(_savePollTimer);
            _savePollTimer = null;
            setSaveCollecting(false);
            alert('Save failed on server — check server logs.');
        }
    } catch (_) { /* network hiccup — keep polling */ }
}

function triggerDownload(token) {
    const a = document.createElement('a');
    a.href = `/api/save/download/${token}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function setSaveCollecting(active, total) {
    const btn      = document.getElementById('btn-save');
    const progRow  = document.getElementById('save-progress-row');
    const fill     = document.getElementById('save-progress-fill');
    const text     = document.getElementById('save-progress-text');
    btn.disabled          = active;
    progRow.hidden        = !active;
    if (active) {
        fill.style.width  = '0%';
        text.textContent  = `0 / ${total}`;
    }
}


// ── Save event listeners ───────────────────────────────────────────────────

document.getElementById('btn-save').addEventListener('click', startSave);

document.getElementById('btn-save-cancel').addEventListener('click', async () => {
    clearInterval(_savePollTimer);
    _savePollTimer = null;
    setSaveCollecting(false);
    try { await fetch('/api/save/cancel', { method: 'POST' }); } catch (_) {}
});


// ── Global controls ────────────────────────────────────────────────────────

btnConnect.addEventListener('click', () => {
    if (wsData && wsData.readyState === WebSocket.OPEN) {
        intentionalDisconnect = true;
        wsData.close();
        if (wsControl) wsControl.close();
    } else {
        connect();
    }
});

btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? '▶ Resume' : '⏸ Pause';
    btnPause.classList.toggle('active', paused);
});

document.getElementById('btn-all-on').addEventListener('click', () => {
    channelState.forEach(ch => {
        ch.enabled = true;
        document.getElementById(`toggle-${ch.id}`)?.classList.add('on');
        document.getElementById(`ch-card-${ch.id}`)?.classList.remove('disabled');
        sendControl({ channel: ch.id, enabled: true });
    });
});

document.getElementById('btn-all-off').addEventListener('click', () => {
    channelState.forEach(ch => {
        ch.enabled = false;
        document.getElementById(`toggle-${ch.id}`)?.classList.remove('on');
        document.getElementById(`ch-card-${ch.id}`)?.classList.add('disabled');
        sendControl({ channel: ch.id, enabled: false });
    });
});


// ── Zoom controls ──────────────────────────────────────────────────────────

const ZOOM_IN  = 0.65;   // range shrinks to 65%
const ZOOM_OUT = 1 / ZOOM_IN;

function zoomAxis(axisKey, factor) {
    const plotEl = document.getElementById('plot');
    const ax = plotEl?._fullLayout?.[axisKey];
    if (!ax) return;
    const [lo, hi] = ax.range;
    const mid  = (lo + hi) / 2;
    const half = (hi - lo) / 2 * factor;
    Plotly.relayout('plot', {
        [`${axisKey}.range`]:     [mid - half, mid + half],
        [`${axisKey}.autorange`]: false,
    });
}

document.getElementById('btn-x-in') .addEventListener('click', () => zoomAxis('xaxis', ZOOM_IN));
document.getElementById('btn-x-out').addEventListener('click', () => zoomAxis('xaxis', ZOOM_OUT));
document.getElementById('btn-y-in') .addEventListener('click', () => zoomAxis('yaxis', ZOOM_IN));
document.getElementById('btn-y-out').addEventListener('click', () => zoomAxis('yaxis', ZOOM_OUT));

document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    Plotly.relayout('plot', { 'xaxis.autorange': true, 'yaxis.autorange': true });
    if (traceDurationMs) sendControl({ type: 'set_pts', view_ms: traceDurationMs, trace_ms: traceDurationMs });
    // reset adaptive resolution
    onZoomRelayout();
});

// Style selector
document.getElementById('sel-style').addEventListener('change', e => {
    plotModeIdx = parseInt(e.target.value);
});

const statsPanel = document.getElementById('stats-panel');
let measureVisible    = false;
let _statsConfigBuilt = false;

// ── Avg N controls (FFT and stats are independent) ─────────────────────────
(function () {
    function makeAvgHandler(inputId, getN, setN, reset) {
        const el = document.getElementById(inputId);
        if (!el) return;
        function apply() {
            const n = Math.max(1, Math.min(10000, parseInt(el.value) || 1));
            el.value = n;
            if (n !== getN()) { setN(n); reset(); }
        }
        el.addEventListener('input',  apply);
        el.addEventListener('change', apply);
    }
    makeAvgHandler('fft-avg-n',
        () => fftAvgN, n => { fftAvgN = n; }, _resetPsdEma);
    makeAvgHandler('stats-avg-n',
        () => statsAvgN, n => { statsAvgN = n; },
        () => { _statsEma = {}; _statsEmaCount = 0; });

    document.getElementById('btn-fft-avg-reset').addEventListener('click', _resetPsdEma);
    document.getElementById('btn-stats-avg-reset').addEventListener('click', () => {
        _statsEma = {}; _statsEvar = {}; _statsEmaCount = 0;
        document.getElementById('stats-n-avg').textContent = `0/${statsAvgN}`;
    });
})();

// Measure button — controls table visibility independently from sidebar
document.getElementById('btn-measure').addEventListener('click', () => {
    measureVisible = !measureVisible;
    statsPanel.classList.toggle('visible', measureVisible);
    document.getElementById('resize-stats').classList.toggle('visible', measureVisible);
    document.getElementById('btn-measure').classList.toggle('active', measureVisible);
    if (measureVisible && !_statsConfigBuilt) {
        buildStatsConfigBar();
        updateStatsVisibility();
        _statsConfigBuilt = true;
    }
});

// ── Sidebar accordion ─────────────────────────────────────────────────────

document.querySelectorAll('.acc-header').forEach(header => {
    header.addEventListener('click', () => {
        const body  = header.nextElementSibling;   // .acc-body
        const arrow = header.querySelector('.acc-arrow');
        const open  = !body.classList.contains('open');
        body.classList.toggle('open', open);
        arrow.classList.toggle('open', open);
        // Lazy-build stats column toggles when Measure section first opens
        if (open && header.closest('#acc-meas') && !_statsConfigBuilt) {
            buildStatsConfigBar();
            updateStatsVisibility();
            _statsConfigBuilt = true;
        }
    });
});


const btnStack = document.getElementById('btn-stack');
btnStack.addEventListener('click', () => {
    stackMode = !stackMode;
    btnStack.classList.toggle('active', stackMode);
    btnStack.textContent = stackMode ? 'Unstack' : 'Stack';
    // Clear cached ranges so the first few frames re-learn from fresh data
    Object.keys(_chDataRange).forEach(k => delete _chDataRange[k]);
    Plotly.purge('plot');
    plotInited = false;
    _relayoutListening = false;
});


// ── Display mode controls (Off / Persist / Avg) ────────────────────────────

['off', 'persist', 'avg'].forEach(mode => {
    document.getElementById(`btn-mode-${mode}`).addEventListener('click', () => {
        displayMode = mode;
        ['off', 'persist', 'avg'].forEach(m =>
            document.getElementById(`btn-mode-${m}`).classList.toggle('active', m === mode)
        );
        _modeBuf = [];
        const showExtra = mode !== 'off';
        document.getElementById('mode-n-row').hidden  = !showExtra;
        document.getElementById('mode-ch-row').hidden = !showExtra;
    });
});

document.getElementById('mode-n').addEventListener('change', e => {
    displayN = Math.max(2, Math.min(1000, parseInt(e.target.value) || 10));
    e.target.value = displayN;
    _modeBuf = [];
});


// ── Trigger controls ───────────────────────────────────────────────────────

(function buildTriggerControls() {
    const btnEnable = document.getElementById('trig-enable');
    btnEnable.addEventListener('click', () => {
        triggerState.enabled = !triggerState.enabled;
        _lastTriggerFrame    = null;
        btnEnable.textContent = triggerState.enabled ? 'On' : 'Off';
        btnEnable.classList.toggle('active', triggerState.enabled);
    });

    document.getElementById('trig-source').addEventListener('change', (e) => {
        triggerState.source = parseInt(e.target.value);
        _lastTriggerFrame   = null;
    });

    ['rise', 'fall'].forEach(key => {
        document.getElementById(`trig-${key}`).addEventListener('click', () => {
            triggerState.edge = key === 'rise' ? 'rising' : 'falling';
            _lastTriggerFrame = null;
            ['rise', 'fall'].forEach(k =>
                document.getElementById(`trig-${k}`).classList.toggle('active', k === key)
            );
        });
    });

    const levelRange = document.getElementById('trig-level');
    const levelNum   = document.getElementById('trig-level-num');
    levelRange.addEventListener('input', (e) => {
        triggerState.level = parseFloat(e.target.value);
        levelNum.value     = triggerState.level.toFixed(2);
        _lastTriggerFrame  = null;
    });
    levelNum.addEventListener('change', (e) => {
        triggerState.level = Math.max(-2, Math.min(2, parseFloat(e.target.value) || 0));
        e.target.value     = triggerState.level.toFixed(2);
        levelRange.value   = triggerState.level;
        _lastTriggerFrame  = null;
    });

    const hystRange = document.getElementById('trig-hyst');
    const hystNum   = document.getElementById('trig-hyst-num');
    hystRange.addEventListener('input', (e) => {
        triggerState.hyst = parseFloat(e.target.value);
        hystNum.value     = triggerState.hyst.toFixed(3);
        _lastTriggerFrame = null;
    });
    hystNum.addEventListener('change', (e) => {
        triggerState.hyst = Math.max(0, Math.min(0.5, parseFloat(e.target.value) || 0));
        e.target.value    = triggerState.hyst.toFixed(3);
        hystRange.value   = triggerState.hyst;
        _lastTriggerFrame = null;
    });

    ['auto', 'normal'].forEach(mode => {
        document.getElementById(`trig-${mode}`).addEventListener('click', () => {
            triggerState.mode = mode;
            _lastTriggerFrame = null;
            ['auto', 'normal'].forEach(m =>
                document.getElementById(`trig-${m}`).classList.toggle('active', m === mode)
            );
        });
    });
})();


// ── FFT panel controls ─────────────────────────────────────────────────────

document.getElementById('btn-fft').addEventListener('click', () => {
    fftVisible = !fftVisible;
    document.getElementById('fft-panel').classList.toggle('visible', fftVisible);
    document.getElementById('resize-fft').classList.toggle('visible', fftVisible);
    document.getElementById('btn-fft').classList.toggle('active', fftVisible);
    sendControl({ type: 'fft_enable', value: fftVisible });
    if (fftVisible) {
        // Reset EMA when panel opens so stale data doesn't bleed in
        _psdEma = null;
        _psdEmaCount = 0;
        document.getElementById('fft-n-avg').textContent = `0/${fftAvgN}`;
    } else {
        _fftInited = false;
    }
    plotInited = false;
});

// PSD unit selector — auto-set log Y to match unit default
const btnLogY = document.getElementById('btn-fft-log-y');
document.getElementById('sel-fft-unit').addEventListener('change', e => {
    fftUnitIdx = parseInt(e.target.value);
    fftLogY    = fftUnitIdx < 2;   // V²/Hz, V/√Hz → log Y; dBV/√Hz is already log → linear axis
    btnLogY.classList.toggle('active', fftLogY);
    btnLogY.disabled = (fftUnitIdx === 2);   // log Y meaningless for dBV/√Hz
    _fftInited = false;
});

// FFT X/Y zoom
const FFT_ZOOM_IN  = 0.65;
const FFT_ZOOM_OUT = 1 / FFT_ZOOM_IN;

function zoomFftAxis(axisKey, factor) {
    const ax = document.getElementById('fft-plot')?._fullLayout?.[axisKey];
    if (!ax) return;
    const [lo, hi] = ax.range;
    const mid  = (lo + hi) / 2;
    const half = (hi - lo) / 2 * factor;
    Plotly.relayout('fft-plot', {
        [`${axisKey}.range`]:     [mid - half, mid + half],
        [`${axisKey}.autorange`]: false,
    });
}

document.getElementById('btn-fft-x-in')       .addEventListener('click', () => zoomFftAxis('xaxis', FFT_ZOOM_IN));
document.getElementById('btn-fft-x-out')      .addEventListener('click', () => zoomFftAxis('xaxis', FFT_ZOOM_OUT));
document.getElementById('btn-fft-y-in')       .addEventListener('click', () => zoomFftAxis('yaxis', FFT_ZOOM_IN));
document.getElementById('btn-fft-y-out')      .addEventListener('click', () => zoomFftAxis('yaxis', FFT_ZOOM_OUT));
document.getElementById('btn-fft-zoom-reset') .addEventListener('click', () => { _fftInited = false; });

// Log/linear toggles for FFT axes
document.getElementById('btn-fft-log-x').addEventListener('click', () => {
    fftLogX = !fftLogX;
    document.getElementById('btn-fft-log-x').classList.toggle('active', fftLogX);
    _fftInited = false;
});

btnLogY.addEventListener('click', () => {
    if (fftUnitIdx === 2) return;   // dBV/√Hz — log Y has no meaning, ignore
    fftLogY = !fftLogY;
    btnLogY.classList.toggle('active', fftLogY);
    _fftInited = false;
});


// ── Theme toggle ───────────────────────────────────────────────────────────

(function initTheme() {
    const saved = localStorage.getItem('dw-theme');
    if (saved === 'light') {
        document.body.dataset.theme = 'light';
        document.getElementById('btn-theme').textContent = '☾';
    }
})();

document.getElementById('btn-theme').addEventListener('click', () => {
    const light = document.body.dataset.theme !== 'light';
    document.body.dataset.theme = light ? 'light' : '';
    document.getElementById('btn-theme').textContent = light ? '☾' : '☀';
    localStorage.setItem('dw-theme', light ? 'light' : 'dark');
    // Force Plotly to rebuild with new colors on next data frame
    plotInited = false;
    _relayoutListening = false;
});


// ── Auto-resize Plotly when #plot div changes size ─────────────────────────
// Handles measure panel, FFT panel, stack toggle, window resize — all in one.
(function () {
    const plotEl = document.getElementById('plot');
    let _resizeTick = null;
    const ro = new ResizeObserver(() => {
        if (_resizeTick) return;
        _resizeTick = requestAnimationFrame(() => {
            _resizeTick = null;
            if (plotEl.querySelector('.plot-container')) {
                Plotly.Plots.resize(plotEl);
            }
        });
    });
    ro.observe(plotEl);
})();


// ── Drag-to-resize handles ─────────────────────────────────────────────────
// Three handles:
//   resize-sidebar : horizontal, between <aside> and #plot-area
//   resize-fft     : vertical,   between #plot and #fft-panel (handle ABOVE fft-panel)
//   resize-stats   : vertical,   between #fft-panel and #stats-panel (handle ABOVE stats-panel)
//
// Vertical convention: dragging DOWN moves handle into the panel below → panel shrinks.
//   newH = startH - dy   (inverted delta)

(function initResizeHandles() {
    const sidebarEl   = document.querySelector('aside');
    const fftPanelEl  = document.getElementById('fft-panel');
    const statsPanelEl = document.getElementById('stats-panel');

    // ── Sidebar — horizontal ─────────────────────────────────────────────────
    let hDragging = false, hStartX = 0, hStartW = 0;
    const sideHandle = document.getElementById('resize-sidebar');

    sideHandle.addEventListener('mousedown', e => {
        e.preventDefault();
        hDragging = true;
        hStartX   = e.clientX;
        hStartW   = sidebarEl.getBoundingClientRect().width;
        sideHandle.classList.add('dragging');
        document.body.style.cursor     = 'ew-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
        if (!hDragging) return;
        const w = Math.max(140, Math.min(420, hStartW + e.clientX - hStartX));
        sidebarEl.style.width = w + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!hDragging) return;
        hDragging = false;
        sideHandle.classList.remove('dragging');
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
    });

    // ── Vertical panels — shared state ──────────────────────────────────────
    const fftHandle   = document.getElementById('resize-fft');
    const statsHandle = document.getElementById('resize-stats');

    let vDragging = null;   // 'fft' | 'stats' | null
    let vStartY   = 0;
    let vStartH   = 0;

    function vMouseDown(which, e) {
        e.preventDefault();
        vDragging = which;
        vStartY   = e.clientY;
        vStartH   = (which === 'fft' ? fftPanelEl : statsPanelEl).getBoundingClientRect().height;
        const handle = which === 'fft' ? fftHandle : statsHandle;
        handle.classList.add('dragging');
        document.body.style.cursor     = 'ns-resize';
        document.body.style.userSelect = 'none';
    }

    fftHandle.addEventListener('mousedown',   e => vMouseDown('fft',   e));
    statsHandle.addEventListener('mousedown', e => vMouseDown('stats', e));

    document.addEventListener('mousemove', e => {
        if (!vDragging) return;
        // Drag DOWN (+dy) → handle moves into panel → panel shrinks
        const newH    = vStartH - (e.clientY - vStartY);
        const clamped = Math.max(80, Math.min(window.innerHeight * 0.75, newH));
        if (vDragging === 'fft') {
            fftPanelEl.style.height = clamped + 'px';
        } else {
            statsPanelEl.style.maxHeight = 'none';   // remove CSS cap
            statsPanelEl.style.height    = clamped + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (!vDragging) return;
        const handle = vDragging === 'fft' ? fftHandle : statsHandle;
        handle.classList.remove('dragging');
        vDragging = null;
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        // Let Plotly re-measure after layout change
        requestAnimationFrame(() => {
            const waveEl = document.getElementById('plot');
            if (waveEl.querySelector('.plot-container'))
                window.Plotly.Plots.resize(waveEl);
            const fftEl  = document.getElementById('fft-plot');
            if (fftEl.querySelector('.plot-container'))
                window.Plotly.Plots.resize(fftEl);
        });
    });
})();


// ── Boot ───────────────────────────────────────────────────────────────────

connect();
