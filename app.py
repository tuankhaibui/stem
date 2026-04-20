"""
app.py — waveforge web monitor FastAPI server.

Bridges ZMQ data stream from fake_daq.py to browser via WebSocket.
Also forwards browser control commands back to fake_daq.py.

Endpoints:
    GET  /             → serve index.html
    WS   /ws/data      → push waveform data to browser
    WS   /ws/control   → receive control commands from browser
    GET  /api/status   → current state (event rate, latency, etc.)
"""

import asyncio
import datetime
import io
import json
import math
import struct
import threading
import time
import uuid
import zipfile
from pathlib import Path

import h5py
import numpy as np
import zmq
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from scipy.fft import rfft as scipy_rfft, rfftfreq as scipy_rfftfreq
from starlette.responses import JSONResponse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ZMQ_SUB_PORT = 5555    # receive data from fake_daq
ZMQ_PUB_PORT = 5556    # send control to fake_daq
_downsample_pts = 4000    # max points per channel sent to browser (updated dynamically)
_TARGET_IN_VIEW  = 2000   # desired visible points when zoomed
_MIN_PTS         = 2000
_MAX_PTS         = 50_000 # raised: long traces (e.g. 1.25e6 pts) need more pts when zoomed in
_PSD_MAX_BINS    = 4000   # max frequency bins sent to browser (log-spaced downsample)

STATIC_DIR = Path(__file__).parent / 'static'

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

app = FastAPI()

# asyncio queue — ZMQ thread puts, WebSocket handler gets
_data_queue: asyncio.Queue = asyncio.Queue(maxsize=5)

_state = {
    'connected_to_daq': False,
    'last_event_time':  0.0,
    'event_count':      0,
    'event_rate':       0.0,
    'last_meta':        None,
}

# ── FFT / PSD state ──────────────────────────────────────────────────────────
_psd_enabled = False              # only compute when FFT panel is open

# ── Save state ────────────────────────────────────────────────────────────────
_save_lock    = threading.Lock()
_save_job = {
    'active':           False,
    'token':            None,
    'n_target':         0,
    'format':           'hdf5',   # 'hdf5' | 'csv'
    'include_waveform': True,
    'include_fft':      False,
    'channel_ids':      set(),
    'prefix':           '',
    'suffix_mode':      'timestamp',   # 'timestamp' | 'number'
    'frames':           [],
}
_save_results = {}   # token → {buf: BytesIO, filename: str, content_type: str}
_save_counter = 0    # session counter for 'number' suffix mode


# ZMQ context (shared)
_zmq_ctx = zmq.Context()
_zmq_pub: zmq.Socket = None   # sends control to fake_daq


# ---------------------------------------------------------------------------
# Save file generation
# ---------------------------------------------------------------------------

def _finalize_save(frames, job, token):
    """Build HDF5 or CSV file(s) in memory and store in _save_results."""
    global _save_counter

    prefix = job['prefix'] or ''
    ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    if job['suffix_mode'] in ('number', 'both'):
        _save_counter += 1
        num = f'{_save_counter:03d}'
    sfx = {
        'timestamp': ts,
        'number':    num,
        'both':      f'{ts}_{num}',
    }.get(job['suffix_mode'], ts)
    base = f'{prefix}_{sfx}' if prefix else sfx

    meta0    = frames[0]['meta']
    sr       = meta0['sample_rate']
    n_s      = meta0['n_samples']
    t_ms     = np.linspace(0, n_s / sr * 1000, n_s, endpoint=False)
    ch_ids   = job['channel_ids']
    save_chs = [ch for ch in meta0['channels'] if ch['id'] in ch_ids]

    try:
        if job['format'] == 'hdf5':
            buf = io.BytesIO()
            with h5py.File(buf, 'w') as hf:
                hf.attrs['sample_rate'] = sr
                hf.attrs['n_events']    = len(frames)
                hf.attrs['created']     = sfx
                mg = hf.create_group('metadata')
                mg.create_dataset('channel_names',
                                  data=[ch['name'].encode() for ch in save_chs])
                mg.create_dataset('time_ms', data=t_ms)
                if job['include_waveform']:
                    wg = hf.create_group('waveforms')
                    for ch in save_chs:
                        arr = np.stack([fr['data'][ch['id']] for fr in frames])
                        wg.create_dataset(ch['name'], data=arr, compression='gzip')
                if job['include_fft'] and frames[0].get('psd_freqs') is not None:
                    fg = hf.create_group('fft')
                    fg.create_dataset('frequencies_hz', data=frames[0]['psd_freqs'])
                    for ch in save_chs:
                        arr = np.stack([fr['psd_power'][ch['id']] for fr in frames])
                        fg.create_dataset(ch['name'], data=arr, compression='gzip')
            buf.seek(0)
            _save_results[token] = {
                'buf':          buf,
                'filename':     f'{base}.h5',
                'content_type': 'application/x-hdf5',
            }

        else:  # csv — always zip
            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
                for i, fr in enumerate(frames):
                    ev_sfx = f'_{i+1:03d}' if len(frames) > 1 else ''
                    if job['include_waveform']:
                        header = 'time_ms,' + ','.join(ch['name'] for ch in save_chs)
                        lines  = [header]
                        for j in range(n_s):
                            vals = [f'{t_ms[j]:.6f}'] + [
                                f'{fr["data"][ch["id"]][j]:.8g}' for ch in save_chs
                            ]
                            lines.append(','.join(vals))
                        zf.writestr(f'{base}{ev_sfx}_waveform.csv', '\n'.join(lines))
                    if job['include_fft'] and fr.get('psd_freqs') is not None:
                        freqs  = fr['psd_freqs']
                        header = 'freq_hz,' + ','.join(
                            f'{ch["name"]}_V2Hz' for ch in save_chs)
                        lines  = [header]
                        for j, fv in enumerate(freqs):
                            vals = [f'{fv:.6f}'] + [
                                f'{fr["psd_power"][ch["id"]][j]:.8g}' for ch in save_chs
                            ]
                            lines.append(','.join(vals))
                        zf.writestr(f'{base}{ev_sfx}_fft.csv', '\n'.join(lines))
            zip_buf.seek(0)
            _save_results[token] = {
                'buf':          zip_buf,
                'filename':     f'{base}.zip',
                'content_type': 'application/zip',
            }
        print(f'[app] save ready: {_save_results[token]["filename"]}')
    except Exception as e:
        print(f'[app] save error: {e}')
        _save_results[token] = None   # signals error to status endpoint


# ---------------------------------------------------------------------------
# ZMQ subscriber thread (runs in background, feeds asyncio queue)
# ---------------------------------------------------------------------------

def _zmq_subscriber_thread(loop: asyncio.AbstractEventLoop):
    """Background thread: receive ZMQ frames, push to asyncio queue."""
    sub = _zmq_ctx.socket(zmq.SUB)
    sub.connect(f'tcp://localhost:{ZMQ_SUB_PORT}')
    sub.setsockopt_string(zmq.SUBSCRIBE, '')
    sub.setsockopt(zmq.RCVTIMEO, 2000)   # 2s timeout so thread can exit cleanly

    print(f'[app] ZMQ SUB connected to tcp://localhost:{ZMQ_SUB_PORT}')

    # rate tracking
    t_prev   = time.monotonic()
    ev_count = 0

    while True:
        try:
            frames = sub.recv_multipart()
        except zmq.Again:
            continue
        except zmq.ZMQError:
            break

        if len(frames) < 2:
            continue

        try:
            meta  = json.loads(frames[0].decode())
            n_ch  = meta['n_channels']
            n_s   = meta['n_samples']
            data  = np.frombuffer(frames[1], dtype=np.float64).reshape(n_ch, n_s)
        except Exception as e:
            print(f'[app] decode error: {e}')
            continue

        # ── Save frame collection (full resolution, before downsampling) ────────
        with _save_lock:
            if _save_job['active']:
                save_frame = {'meta': meta, 'data': data}
                if _save_job['include_fft']:
                    Xs   = scipy_rfft(data, axis=1)
                    fs   = scipy_rfftfreq(n_s, d=1.0 / meta['sample_rate'])
                    psds = (np.abs(Xs) ** 2) * 2.0 / (meta['sample_rate'] * n_s)
                    psds[:, 0] /= 2.0
                    if n_s % 2 == 0:
                        psds[:, -1] /= 2.0
                    save_frame['psd_freqs'] = fs
                    save_frame['psd_power'] = psds
                _save_job['frames'].append(save_frame)
                if len(_save_job['frames']) >= _save_job['n_target']:
                    _finalize_save(list(_save_job['frames']), dict(_save_job), _save_job['token'])
                    _save_job['active'] = False
                    _save_job['frames'] = []

        # further downsample for browser (adaptive — updated by browser zoom events)
        step = max(1, n_s // _downsample_pts)
        data_ds = data[:, ::step]

        # ── FFT PSD (single frame — averaging done client-side) ─────────────
        # Matches qetpy.calc_psd: |FFT|² / (fs × N), folded to one-sided.
        # Using rfft (positive freqs only) — equivalent to fft + fold_spectrum.
        if _psd_enabled:
            X   = scipy_rfft(data, axis=1)                          # (n_ch, n_s//2+1)
            f   = scipy_rfftfreq(n_s, d=1.0 / meta['sample_rate']) # (n_s//2+1,) Hz
            psd = (np.abs(X) ** 2) * 2.0 / (meta['sample_rate'] * n_s)  # V²/Hz one-sided
            psd[:, 0]  /= 2.0           # DC — no negative-frequency counterpart
            if n_s % 2 == 0:
                psd[:, -1] /= 2.0       # Nyquist — shared between ±freq (even N)
            # Downsample to _PSD_MAX_BINS log-spaced bins — reduces payload ~300× for long traces
            n_freqs = len(f)
            if n_freqs > _PSD_MAX_BINS:
                idx = np.unique(
                    np.round(np.logspace(0, np.log10(n_freqs - 1), _PSD_MAX_BINS)).astype(int)
                )
                f   = f[idx]
                psd = psd[:, idx]

        # build payload for browser
        payload = {
            'timestamp':   meta['timestamp'],
            'event':       meta.get('event', 0),
            'sample_rate': meta['sample_rate'],
            'n_samples':   meta['n_samples'],   # original (pre-downsample) count
            'channels':    meta['channels'],
            'data':        data_ds.tolist(),    # list of lists (downsampled)
        }

        if _psd_enabled:
            payload['psd_freqs'] = f.tolist()
            payload['psd_power'] = psd.tolist()   # (n_ch, n_freqs), V²/Hz — downsampled

        # rate calculation
        ev_count += 1
        now = time.monotonic()
        if now - t_prev >= 1.0:
            _state['event_rate']  = ev_count / (now - t_prev)
            _state['event_count'] += ev_count
            ev_count = 0
            t_prev   = now

        _state['connected_to_daq'] = True
        _state['last_event_time']  = meta['timestamp']
        _state['last_meta']        = meta

        # push to asyncio queue (non-blocking: drop if full — prefer fresh data)
        asyncio.run_coroutine_threadsafe(
            _put_nowait_drop(_data_queue, payload),
            loop
        )

    sub.close()
    _state['connected_to_daq'] = False
    print('[app] ZMQ subscriber thread exited.')


async def _put_nowait_drop(queue: asyncio.Queue, item):
    """Put item in queue; if full, drop oldest and put new."""
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    await queue.put(item)


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@app.on_event('startup')
async def startup():
    global _zmq_pub

    # ZMQ PUB for sending control to fake_daq
    _zmq_pub = _zmq_ctx.socket(zmq.PUB)
    _zmq_pub.connect(f'tcp://localhost:{ZMQ_PUB_PORT}')
    print(f'[app] ZMQ PUB connected to tcp://localhost:{ZMQ_PUB_PORT}')

    # start ZMQ subscriber in background thread
    loop = asyncio.get_event_loop()
    t = threading.Thread(target=_zmq_subscriber_thread, args=(loop,), daemon=True)
    t.start()
    print('[app] waveforge web monitor started — http://localhost:8000')


@app.on_event('shutdown')
async def shutdown():
    if _zmq_pub:
        _zmq_pub.close()
    _zmq_ctx.term()


# ---------------------------------------------------------------------------
# Static files + index
# ---------------------------------------------------------------------------

app.mount('/static', StaticFiles(directory=str(STATIC_DIR)), name='static')

@app.get('/')
async def index():
    return FileResponse(str(STATIC_DIR / 'index.html'))


# ---------------------------------------------------------------------------
# WebSocket: data → browser
# ---------------------------------------------------------------------------

@app.websocket('/ws/data')
async def ws_data(websocket: WebSocket):
    await websocket.accept()
    print('[app] browser connected to /ws/data')
    try:
        while True:
            payload = await _data_queue.get()
            await websocket.send_json(payload)
    except WebSocketDisconnect:
        print('[app] browser disconnected from /ws/data')
    except Exception as e:
        print(f'[app] /ws/data error: {e}')


# ---------------------------------------------------------------------------
# WebSocket: browser control → fake_daq
# ---------------------------------------------------------------------------

@app.websocket('/ws/control')
async def ws_control(websocket: WebSocket):
    await websocket.accept()
    print('[app] browser connected to /ws/control')
    try:
        while True:
            raw = await websocket.receive_text()
            cmd = json.loads(raw)

            # FFT enable/disable — handled locally, do not forward to fake_daq
            if cmd.get('type') == 'fft_enable':
                global _psd_enabled
                _psd_enabled = bool(cmd.get('value', False))
                continue

            # adaptive resolution request — handle locally, do not forward
            if cmd.get('type') == 'set_pts':
                global _downsample_pts
                view_ms  = float(cmd.get('view_ms',  1))
                trace_ms = float(cmd.get('trace_ms', 1))
                if view_ms > 0 and trace_ms > 0:
                    fraction = min(1.0, view_ms / trace_ms)
                    needed   = int(math.ceil(_TARGET_IN_VIEW / fraction))
                    _downsample_pts = max(_MIN_PTS, min(_MAX_PTS, needed))
                continue

            # forward channel control to fake_daq via ZMQ PUB
            if _zmq_pub:
                _zmq_pub.send_string(json.dumps(cmd))
                print(f'[app] control sent: {cmd}')
    except WebSocketDisconnect:
        print('[app] browser disconnected from /ws/control')
    except Exception as e:
        print(f'[app] /ws/control error: {e}')


# ---------------------------------------------------------------------------
# REST: save data
# ---------------------------------------------------------------------------

@app.post('/api/save/start')
async def save_start(request: Request):
    body = await request.json()
    token = uuid.uuid4().hex[:8]
    with _save_lock:
        if _save_job['active']:
            return JSONResponse(
                {'error': 'save already in progress', 'token': _save_job['token']},
                status_code=409)
        _save_job.update({
            'active':           True,
            'token':            token,
            'n_target':         max(1, int(body.get('n_events', 1))),
            'format':           body.get('format', 'hdf5'),
            'include_waveform': bool(body.get('include_waveform', True)),
            'include_fft':      bool(body.get('include_fft', False)),
            'channel_ids':      set(body.get('channels', [])),
            'prefix':           str(body.get('prefix', '')).strip()[:40],
            'suffix_mode':      body.get('suffix_mode', 'timestamp') if body.get('suffix_mode') in ('timestamp','number','both') else 'timestamp',
            'frames':           [],
        })
    return {'token': token, 'status': 'collecting'}


@app.get('/api/save/status/{token}')
async def save_status(token: str):
    with _save_lock:
        if _save_job.get('token') == token and _save_job['active']:
            return {
                'status':    'collecting',
                'collected': len(_save_job['frames']),
                'total':     _save_job['n_target'],
            }
    if token in _save_results:
        result = _save_results[token]
        if result is None:
            return JSONResponse({'status': 'error'}, status_code=500)
        return {'status': 'ready'}
    return JSONResponse({'status': 'not_found'}, status_code=404)


@app.get('/api/save/download/{token}')
async def save_download(token: str):
    result = _save_results.pop(token, None)
    if not result:
        return JSONResponse({'error': 'not found'}, status_code=404)
    return StreamingResponse(
        result['buf'],
        media_type=result['content_type'],
        headers={'Content-Disposition': f'attachment; filename="{result["filename"]}"'},
    )


@app.post('/api/save/cancel')
async def save_cancel():
    with _save_lock:
        _save_job.update({'active': False, 'frames': [], 'token': None})
    return {'status': 'cancelled'}


# ---------------------------------------------------------------------------
# REST: status
# ---------------------------------------------------------------------------

@app.get('/api/status')
async def api_status():
    now = time.time()
    last = _state['last_event_time']
    return {
        'connected':      _state['connected_to_daq'],
        'event_count':    _state['event_count'],
        'event_rate':     round(_state['event_rate'], 1),
        'last_event_ago': round(now - last, 2) if last else None,
        'last_meta':      _state['last_meta'],
    }
