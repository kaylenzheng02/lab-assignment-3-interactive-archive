import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { addSnapshot, deleteSnapshot, listSnapshots } from './utils/archive.js';
import Icon from './components/Icon.jsx';
import ThemePicker from './components/ThemePicker.jsx';
import './App.css';

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
const VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm';
const FACE_MODEL = `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;
const HAND_MODEL = `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`;

const FOG = '232, 238, 240'; // milky, faintly cool white, like condensation on glass
const FRAME_GAP_MS = 65;
// Wipe diameter in on-screen CSS px.
const BRUSH_MIN = 30;
const BRUSH_MAX = 200;
const BRUSH_DEFAULT = 90;

const JAW_OPEN = 0.25;
const JAW_CLOSE = 0.16;
const PINCH_START = 0.3;
const PINCH_RELEASE = 0.42;

const FOG_OPACITY = 0.8;
const FIELD_SCALE = 4; // one fog cell per 4x4 canvas pixels
const BREATH_STRENGTH = 0.06;
const BREATH_SPREAD = 1.8;

const CHART_WINDOW_MS = 30000;
const MAX_SAMPLES = 6000; // ~6 minutes of history
const FLUSH_MS = 250; // how often recorded samples are pushed to the overview stats

const fixed2 = (v) => v.toFixed(2);
const percent = (v) => (v * 100).toFixed(0);

const STATUS = {
  idle: { label: 'Idle', tone: 'neutral' },
  loading: { label: 'Initialising', tone: 'warning' },
  live: { label: 'Recording', tone: 'success' },
};

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const DUCK_W = 140;
const DUCK_H = 140; // image (140 x 117) plus room for the hover tools below it
const DUCK_GAP = 12;
// Areas ducks must never cover: header status/theme, the camera, and its controls.
const DUCK_KEEP_CLEAR = '.topbar-end, .frame, .viewport .toolbar';

// Deterministic pseudo-random number in [0, 1) for a snapshot id, so ducks stay put across reloads.
function seeded(id, n) {
  const x = Math.sin(id * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const overlaps = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Picks a document-space spot for each duck that avoids the keep-clear areas and, where possible, other ducks.
function placeDucks(ids) {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const blocked = [...document.querySelectorAll(DUCK_KEEP_CLEAR)].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left + scrollX - DUCK_GAP,
      top: r.top + scrollY - DUCK_GAP,
      right: r.right + scrollX + DUCK_GAP,
      bottom: r.bottom + scrollY + DUCK_GAP,
    };
  });
  const width = document.documentElement.clientWidth - DUCK_W;
  const height = document.documentElement.scrollHeight - DUCK_H;
  const placed = [];
  const spots = {};

  for (const id of ids) {
    let fallback = null;
    let spot = null;
    for (let attempt = 0; attempt < 60 && !spot; attempt++) {
      const left = seeded(id, attempt * 2 + 1) * width;
      const top = seeded(id, attempt * 2 + 2) * height;
      const box = { left, top, right: left + DUCK_W, bottom: top + DUCK_H };
      if (blocked.some((b) => overlaps(box, b))) continue;
      fallback ??= box;
      if (!placed.some((b) => overlaps(box, b))) spot = box;
    }
    spot ??= fallback;
    if (!spot) continue; // no clear space at all; leave this duck hidden rather than cover controls
    placed.push(spot);
    spots[id] = { left: spot.left, top: spot.top, rotate: `${((seeded(id, 0) - 0.5) * 30).toFixed(1)}deg` };
  }
  return spots;
}

function jawScore(face) {
  return face.faceBlendshapes[0]?.categories.find((shape) => shape.categoryName === 'jawOpen')?.score || 0;
}

function pinchRatio(points) {
  return distance(points[4], points[8]) / Math.max(distance(points[0], points[9]), 0.01);
}

function pinchPosition(points, canvas) {
  return {
    x: (1 - (points[4].x + points[8].x) / 2) * canvas.width,
    y: ((points[4].y + points[8].y) / 2) * canvas.height,
  };
}

// Smooth random texture in [0, 1]: coarse value noise blended with fine speckle.
function makeGrain(w, h) {
  const step = 12;
  const gw = Math.ceil(w / step) + 2;
  const gh = Math.ceil(h / step) + 2;
  const coarse = Float32Array.from({ length: gw * gh }, () => Math.random());
  const grain = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const fy = y / step;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    for (let x = 0; x < w; x++) {
      const fx = x / step;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const a = coarse[iy * gw + ix];
      const b = coarse[iy * gw + ix + 1];
      const c = coarse[(iy + 1) * gw + ix];
      const d = coarse[(iy + 1) * gw + ix + 1];
      const smooth = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      grain[y * w + x] = smooth * 0.75 + Math.random() * 0.25;
    }
  }
  return grain;
}

// Centre of the open mouth and a breath radius scaled to mouth width, in canvas pixels (mirrored like the video).
function mouthArea(points, canvas) {
  const top = points[13];
  const bottom = points[14];
  const width = distance(points[61], points[291]) * canvas.width;
  return {
    x: (1 - (top.x + bottom.x) / 2) * canvas.width,
    y: ((top.y + bottom.y) / 2) * canvas.height,
    radius: Math.max(width * BREATH_SPREAD, 40),
  };
}

function cameraErrorMessage(error) {
  if (error.name === 'NotAllowedError') {
    return 'Camera permission was denied. Allow camera access in your browser, then try again.';
  }
  return `Could not start the mirror. ${error.message}`;
}

export default function App() {
  const video = useRef(null);
  const canvas = useRef(null);
  const engine = useRef({ session: 0, frame: 0, stream: null, face: null, hand: null });
  const brush = useRef(BRUSH_DEFAULT);
  const previous = useRef(null);
  const fieldRef = useRef(null);

  const [size, setSize] = useState(BRUSH_DEFAULT);
  const [mode, setMode] = useState('idle');
  const [error, setError] = useState('');
  const [snapshots, setSnapshots] = useState([]);
  const [duckSpots, setDuckSpots] = useState({});
  const [saving, setSaving] = useState(false);
  const [samples, setSamples] = useState([]);
  const telemetry = useRef([]); // every recorded sample this session, oldest first
  const coverage = useRef(1); // mean fog density, updated on every render()
  const urls = useRef(new Map()); // snapshot id -> object URL for display/download

  function withUrl(record) {
    if (!urls.current.has(record.id)) urls.current.set(record.id, URL.createObjectURL(record.blob));
    return { id: record.id, createdAt: record.createdAt, url: urls.current.get(record.id) };
  }

  useEffect(() => {
    let cancelled = false;
    const owned = urls.current;
    listSnapshots()
      .then((records) => {
        if (!cancelled) setSnapshots(records.map(withUrl));
      })
      .catch((err) => setError(`Could not open the archive. ${err.message}`));

    return () => {
      cancelled = true;
      owned.forEach((url) => URL.revokeObjectURL(url));
      owned.clear();
    };
  }, []);

  // Combines the mirrored camera frame and the fog exactly as they appear on screen.
  async function takeSnapshot() {
    const feed = video.current;
    const fogLayer = canvas.current;
    if (!feed?.videoWidth) return;

    setSaving(true);
    try {
      const shot = document.createElement('canvas');
      shot.width = feed.videoWidth;
      shot.height = feed.videoHeight;
      const ctx = shot.getContext('2d');
      ctx.translate(shot.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(feed, 0, 0, shot.width, shot.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(fogLayer, 0, 0, shot.width, shot.height);

      const blob = await new Promise((resolve, reject) =>
        shot.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), 'image/jpeg', 0.92),
      );
      const record = await addSnapshot(blob);
      setSnapshots((list) => [withUrl(record), ...list]);
    } catch (err) {
      setError(`Could not save the snapshot. ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeSnapshot(id) {
    if (!window.confirm('Delete this snapshot from the archive? This cannot be undone.')) return;
    try {
      await deleteSnapshot(id);
      URL.revokeObjectURL(urls.current.get(id));
      urls.current.delete(id);
      setSnapshots((list) => list.filter((shot) => shot.id !== id));
    } catch (err) {
      setError(`Could not delete the snapshot. ${err.message}`);
    }
  }

  // Fog lives in a low-resolution float density map (0 = clear, 1 = fully fogged).
  // Floats avoid the 8-bit rounding that made repeated faint strokes show up as rings,
  // and the map is drawn scaled up so edges stay soft.
  function fogField() {
    const surface = canvas.current;
    const w = Math.ceil(surface.width / FIELD_SCALE);
    const h = Math.ceil(surface.height / FIELD_SCALE);
    let field = fieldRef.current;

    if (!field || field.w !== w || field.h !== h) {
      const buffer = document.createElement('canvas');
      buffer.width = w;
      buffer.height = h;
      const bufferCtx = buffer.getContext('2d');
      field = {
        w,
        h,
        density: new Float32Array(w * h),
        grain: makeGrain(w, h),
        buffer,
        bufferCtx,
        pixels: bufferCtx.createImageData(w, h),
      };
      fieldRef.current = field;
    }
    return field;
  }

  function render() {
    const surface = canvas.current;
    if (!surface) return;

    const { w, h, density, grain, buffer, bufferCtx, pixels } = fogField();
    const [r, g, b] = FOG.split(',').map(Number);
    const data = pixels.data;
    let total = 0;

    for (let i = 0; i < w * h; i++) {
      total += density[i];
      // Grain gives the mottled look of real condensation; the random term dithers away banding.
      const alpha = density[i] * FOG_OPACITY * (0.86 + 0.28 * grain[i]) * 255 + Math.random() - 0.5;
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = alpha < 0 ? 0 : alpha > 255 ? 255 : alpha;
    }

    coverage.current = total / (w * h);
    bufferCtx.putImageData(pixels, 0, 0);
    const ctx = surface.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buffer, 0, 0, surface.width, surface.height);
  }

  function fog() {
    if (!canvas.current) return;
    fogField().density.fill(1);
    render();
  }

  // Applies fn(cellIndex, distance in canvas px) to every field cell within radius of (x, y).
  function eachCell(x, y, radius, fn) {
    const { w, h } = fogField();
    const x0 = Math.max(0, Math.floor((x - radius) / FIELD_SCALE));
    const x1 = Math.min(w - 1, Math.ceil((x + radius) / FIELD_SCALE));
    const y0 = Math.max(0, Math.floor((y - radius) / FIELD_SCALE));
    const y1 = Math.min(h - 1, Math.ceil((y + radius) / FIELD_SCALE));

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const d = Math.hypot((cx + 0.5) * FIELD_SCALE - x, (cy + 0.5) * FIELD_SCALE - y);
        if (d < radius) fn(cy * w + cx, d);
      }
    }
  }

  function fogAt(x, y, radius) {
    const { density, grain } = fogField();
    const sigma = radius / 2.2;

    eachCell(x, y, radius, (i, d) => {
      const falloff = Math.exp(-(d * d) / (2 * sigma * sigma));
      // Uneven buildup (via grain) so the patch looks like breath, not a stamped disc.
      const add = BREATH_STRENGTH * falloff * (0.6 + 0.8 * grain[i]);
      density[i] = Math.min(1, density[i] + add);
    });
  }

  function clearAt(x, y) {
    const surface = canvas.current;
    const { density } = fogField();
    // The canvas is drawn with object-fit: cover, so the larger axis ratio is the on-screen scale.
    const scale = Math.max(surface.clientWidth / surface.width, surface.clientHeight / surface.height);
    const radius = brush.current / 2 / scale;
    const start = previous.current || { x, y };
    const steps = Math.max(1, Math.ceil(Math.hypot(x - start.x, y - start.y) / (radius / 4)));

    for (let s = 1; s <= steps; s++) {
      const px = start.x + ((x - start.x) * s) / steps;
      const py = start.y + ((y - start.y) * s) / steps;
      eachCell(px, py, radius, (i, d) => {
        // Fully clear inside 65% of the radius, smooth fade to the edge.
        const t = Math.min(1, Math.max(0, (radius - d) / (radius * 0.35)));
        const wipe = t * t * (3 - 2 * t);
        density[i] *= 1 - wipe;
      });
    }

    previous.current = { x, y };
  }

  function release() {
    const current = engine.current;
    current.session += 1;
    cancelAnimationFrame(current.frame);
    current.stream?.getTracks().forEach((track) => track.stop());
    current.face?.close();
    current.hand?.close();
    current.stream = null;
    current.face = null;
    current.hand = null;

    if (video.current) video.current.srcObject = null;
    previous.current = null;
  }

  useEffect(() => {
    fog();
    return () => release();
  }, []);

  const snapshotIds = snapshots.map((shot) => shot.id).join(',');
  useLayoutEffect(() => {
    const ids = snapshotIds ? snapshotIds.split(',').map(Number).sort((a, b) => a - b) : [];
    const update = () => setDuckSpots(placeDucks(ids));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [snapshotIds]);

  function flush() {
    setSamples(telemetry.current.filter((s) => s.t >= telemetry.current.at(-1).t - CHART_WINDOW_MS));
  }

  useEffect(() => {
    if (mode !== 'live') return undefined;
    const timer = setInterval(() => telemetry.current.length && flush(), FLUSH_MS);
    return () => clearInterval(timer);
  }, [mode]);

  async function start() {
    release();
    setError('');
    setMode('loading');
    telemetry.current = [];
    setSamples([]);

    const current = engine.current;
    const session = current.session;
    let stream;
    let face;
    let hand;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access needs HTTPS or localhost.');
      }

      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 1280, height: 720 },
        audio: false,
      });

      if (session !== current.session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      current.stream = stream;
      video.current.srcObject = stream;
      await video.current.play();

      const vision = await FilesetResolver.forVisionTasks(VISION_WASM);
      face = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      hand = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL },
        runningMode: 'VIDEO',
        numHands: 1,
      });

      if (session !== current.session) {
        face.close();
        hand.close();
        return;
      }

      current.face = face;
      current.hand = hand;

      const feed = video.current;
      canvas.current.width = feed.videoWidth;
      canvas.current.height = feed.videoHeight;
      // Resume the previous drawing after a stop; refog only on first start or if the frame size changed.
      const previousField = fieldRef.current;
      if (fogField() === previousField) render();
      else fog();
      setMode('live');

      let lastTime = -1;
      let lastFrame = 0;
      let mouthOpen = false;
      let pinched = false;
      let startedAt = null;

      function tick(now) {
        if (session !== current.session) return;

        try {
          const ready = feed.readyState >= 2 && feed.currentTime !== lastTime && now - lastFrame > FRAME_GAP_MS;

          if (ready) {
            lastTime = feed.currentTime;
            lastFrame = now;

            const faceResult = face.detectForVideo(feed, now);
            const handResult = hand.detectForVideo(feed, now);

            let changed = false;
            const jaw = jawScore(faceResult);
            mouthOpen = jaw > (mouthOpen ? JAW_CLOSE : JAW_OPEN);
            const facePoints = faceResult.faceLandmarks[0];
            if (mouthOpen && facePoints) {
              const mouth = mouthArea(facePoints, canvas.current);
              fogAt(mouth.x, mouth.y, mouth.radius);
              changed = true;
            }

            const points = handResult.landmarks[0];
            const ratio = points ? pinchRatio(points) : null;
            if (points) {
              pinched = ratio < (pinched ? PINCH_RELEASE : PINCH_START);
              if (pinched) {
                const point = pinchPosition(points, canvas.current);
                clearAt(point.x, point.y);
                changed = true;
              } else {
                previous.current = null;
              }
            } else {
              pinched = false;
              previous.current = null;
            }

            if (changed) render();

            startedAt ??= now;
            telemetry.current.push({
              t: now - startedAt,
              jaw: facePoints ? jaw : null,
              pinch: ratio,
              coverage: coverage.current,
              face: Boolean(facePoints),
              hand: Boolean(points),
              mouthOpen,
              pinched,
            });
            if (telemetry.current.length > MAX_SAMPLES) telemetry.current.shift();
          }

          current.frame = requestAnimationFrame(tick);
        } catch (err) {
          release();
          setMode('idle');
          setError(`Tracking stopped. ${err.message}`);
        }
      }

      current.frame = requestAnimationFrame(tick);
    } catch (err) {
      face?.close();
      hand?.close();
      if (session !== current.session) return;
      release();
      setMode('idle');
      setError(cameraErrorMessage(err));
    }
  }

  function stop() {
    release();
    setMode('idle');
    if (telemetry.current.length) flush();
  }

  const status = STATUS[mode];
  const last = samples.at(-1);
  const rate = last ? samples.filter((s) => s.t > last.t - 1000).length : 0;
  const fogLevel = last ? last.coverage : 1; // the mirror starts fully fogged
  const faceOn = mode === 'live' && last?.face;
  const handOn = mode === 'live' && last?.hand;

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>

      <header className="topbar">
        <div className="brand">
          <h1>Digital Mirror</h1>
          <p className="brand-sub">Gesture tracking study</p>
        </div>
        <div className="topbar-end">
          <p className={`status status-${status.tone}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {status.label}
            {mode === 'live' && last && <span className="status-meta">t = {(last.t / 1000).toFixed(1)} s</span>}
          </p>
          <ThemePicker />
        </div>
      </header>

      <main id="main" className="layout">
        {error && (
          <div className="alert" role="alert">
            <Icon name="alert" />
            <p>{error}</p>
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}

        <section className="panel viewport" aria-label="Camera">
          <div className="frame">
            <div className={`mirror ${mode === 'live' ? 'is-live' : ''}`}>
              <video ref={video} autoPlay playsInline muted aria-label="Mirrored camera feed" />
              <canvas ref={canvas} width="1280" height="800" aria-label="Fog overlay" />
              {mode !== 'live' && (
                <div className="mirror-overlay">
                  <Icon name={mode === 'loading' ? 'activity' : 'cameraOff'} size={28} />
                  <p>{mode === 'loading' ? 'Loading camera and tracking models…' : 'Camera offline'}</p>
                </div>
              )}
            </div>
          </div>

          <div className="toolbar">
            <div className="toolbar-group">
              <button
                className="btn btn-secondary btn-icon"
                onClick={start}
                disabled={mode !== 'idle'}
                aria-label={mode === 'loading' ? 'Loading camera' : 'Start camera'}
                title={mode === 'loading' ? 'Loading camera' : 'Start camera'}
              >
                <Icon name="play" />
              </button>
              <button
                className="btn btn-secondary btn-icon"
                onClick={stop}
                disabled={mode === 'idle'}
                aria-label="Stop camera"
                title="Stop camera"
              >
                <Icon name="stop" />
              </button>
              <button
                className="btn btn-primary btn-icon"
                onClick={takeSnapshot}
                disabled={mode !== 'live' || saving}
                aria-label={saving ? 'Saving snapshot' : 'Take snapshot'}
                title={saving ? 'Saving snapshot' : 'Take snapshot'}
              >
                <Icon name="camera" />
              </button>
            </div>

            <div className="toolbar-end">
              <div className="slider">
                <label htmlFor="brush">Brush size</label>
                <input
                  id="brush"
                  type="range"
                  min={BRUSH_MIN}
                  max={BRUSH_MAX}
                  value={size}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSize(value);
                    brush.current = value;
                  }}
                />
                <output htmlFor="brush">{size} px</output>
              </div>
              <button
                className="btn btn-secondary btn-icon"
                onClick={fog}
                disabled={mode !== 'live'}
                aria-label="Reset fog"
                title="Reset fog"
              >
                <Icon name="reset" />
              </button>
            </div>
          </div>
        </section>

        <aside className="side" aria-label="Session overview">
          <dl className="kpis">
            <div className="kpi">
              <dt>Fog coverage</dt>
              <dd>
                {percent(fogLevel)}
                <span className="unit">%</span>
              </dd>
              <div className="meter" aria-hidden="true">
                <span style={{ transform: `scaleX(${fogLevel})` }} />
              </div>
            </div>
            <div className="kpi">
              <dt>Detection rate</dt>
              <dd>
                {mode === 'live' ? rate : '—'}
                <span className="unit">Hz</span>
              </dd>
            </div>
            <div className="kpi">
              <dt>Face</dt>
              <dd className={`flag ${faceOn ? 'flag-on' : ''}`}>
                <Icon name={faceOn ? 'check' : 'minus'} />
                {mode !== 'live' ? 'Offline' : faceOn ? (last.mouthOpen ? 'Mouth open' : 'Tracked') : 'Not found'}
              </dd>
            </div>
            <div className="kpi">
              <dt>Hand</dt>
              <dd className={`flag ${handOn ? 'flag-on' : ''}`}>
                <Icon name={handOn ? 'check' : 'minus'} />
                {mode !== 'live' ? 'Offline' : handOn ? (last.pinched ? 'Pinching' : 'Tracked') : 'Not found'}
              </dd>
            </div>
          </dl>

          <section className="panel protocol" aria-labelledby="protocol-heading">
            <h2 id="protocol-heading">
              <Icon name="info" /> Steps
            </h2>
            <ol>
              <li>
                <strong>Start the camera</strong>
              </li>
              <li>
                <strong>Open your mouth</strong>
              </li>
              <li>
                <strong>Pinch thumb and index finger</strong>
              </li>
              <li>
                <strong>Take a snapshot</strong>
              </li>
            </ol>
          </section>
          <section className="panel archive" aria-labelledby="archive-heading">
            <div className="panel-head">
              <h2 id="archive-heading">
                <Icon name="archive" /> Archive <span className="count">{snapshots.length}</span>
              </h2>
            </div>
            {snapshots.length === 0 && (
              <div className="empty">
                <Icon name="camera" size={28} />
                <p>No snapshots yet. Start the camera and press “Take snapshot”.</p>
              </div>
            )}
          </section>
        </aside>


      </main>

      <ul className="pond" aria-label="Snapshots">
        {snapshots.map((shot) => {
          const spot = duckSpots[shot.id];
          if (!spot) return null;
          const taken = new Date(shot.createdAt);
          const number = `#${String(shot.id).padStart(3, '0')}`;
          return (
            <li key={shot.id} className="duck" style={spot}>
              <img src={shot.url} alt={`Mirror snapshot ${number} from ${taken.toLocaleString()}`} />
              <div className="duck-tools">
                <span className="duck-id">{number}</span>
                <a
                  className="btn btn-secondary btn-icon btn-icon-sm"
                  href={shot.url}
                  download={`mirror-${shot.createdAt}.jpg`}
                  aria-label={`Download snapshot ${number}`}
                  title="Download"
                >
                  <Icon name="download" />
                </a>
                <button
                  className="btn btn-danger btn-icon btn-icon-sm"
                  onClick={() => removeSnapshot(shot.id)}
                  aria-label={`Delete snapshot ${number}`}
                  title="Delete"
                >
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
