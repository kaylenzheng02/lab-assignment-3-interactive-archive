import { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import './App.css';

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
const VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm';
const FACE_MODEL = `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;
const HAND_MODEL = `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`;

const FOG = '191, 207, 201';
const FRAME_GAP_MS = 65;
const BRUSH_MIN = 30;
const BRUSH_MAX = 200;
const BRUSH_DEFAULT = 90;

const JAW_OPEN = 0.25;
const JAW_CLOSE = 0.16;
const PINCH_START = 0.3;
const PINCH_RELEASE = 0.42;

const FOG_OPACITY = 0.87;
const FIELD_SCALE = 4; // one fog cell per 4x4 canvas pixels
const BREATH_STRENGTH = 0.06;
const BREATH_SPREAD = 1.8;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
  const [aspect, setAspect] = useState('16 / 10');
  const [error, setError] = useState('');

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

    for (let i = 0; i < w * h; i++) {
      // Grain gives the mottled look of real condensation; the random term dithers away banding.
      const alpha = density[i] * FOG_OPACITY * (0.86 + 0.28 * grain[i]) * 255 + Math.random() - 0.5;
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = alpha < 0 ? 0 : alpha > 255 ? 255 : alpha;
    }

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
    const radius = (brush.current / 2) * (surface.width / surface.clientWidth);
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

  async function start() {
    release();
    setError('');
    setMode('loading');

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
      setAspect(`${feed.videoWidth} / ${feed.videoHeight}`);
      canvas.current.width = feed.videoWidth;
      canvas.current.height = feed.videoHeight;
      fog();
      setMode('live');

      let lastTime = -1;
      let lastFrame = 0;
      let mouthOpen = false;
      let pinched = false;

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
            mouthOpen = jawScore(faceResult) > (mouthOpen ? JAW_CLOSE : JAW_OPEN);
            const facePoints = faceResult.faceLandmarks[0];
            if (mouthOpen && facePoints) {
              const mouth = mouthArea(facePoints, canvas.current);
              fogAt(mouth.x, mouth.y, mouth.radius);
              changed = true;
            }

            const points = handResult.landmarks[0];
            if (points) {
              pinched = pinchRatio(points) < (pinched ? PINCH_RELEASE : PINCH_START);
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
  }

  return (
    <main>
      <div className="mirror" style={{ aspectRatio: aspect }}>
        <video ref={video} autoPlay playsInline muted aria-label="Mirrored camera feed" />
        <canvas ref={canvas} width="1280" height="800" aria-label="Fog overlay" />
      </div>
      <p>
        <button onClick={start} disabled={mode !== 'idle'}>
          {mode === 'loading' ? 'Loading camera…' : 'Start camera'}
        </button>{' '}
        <button onClick={stop} disabled={mode === 'idle'}>Stop camera</button>
      </p>
      <label htmlFor="brush">Clearing size: </label>
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
      />{' '}
      <output htmlFor="brush">{size} px</output>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
