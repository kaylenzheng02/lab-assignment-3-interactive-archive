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

  const [size, setSize] = useState(BRUSH_DEFAULT);
  const [mode, setMode] = useState('idle');
  const [aspect, setAspect] = useState('16 / 10');
  const [error, setError] = useState('');

  function fog(amount = 1) {
    const surface = canvas.current;
    if (!surface) return;

    const ctx = surface.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${FOG}, ${amount * 0.87})`;
    ctx.fillRect(0, 0, surface.width, surface.height);
  }

  function clearAt(x, y) {
    const surface = canvas.current;
    const ctx = surface.getContext('2d');
    const radius = (brush.current / 2) * (surface.width / surface.clientWidth);
    const start = previous.current || { x, y };
    const steps = Math.max(1, Math.ceil(Math.hypot(x - start.x, y - start.y) / (radius / 4)));

    ctx.globalCompositeOperation = 'destination-out';

    for (let i = 1; i <= steps; i++) {
      const px = start.x + ((x - start.x) * i) / steps;
      const py = start.y + ((y - start.y) * i) / steps;
      const gradient = ctx.createRadialGradient(px, py, radius * 0.65, px, py, radius);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
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

            mouthOpen = jawScore(faceResult) > (mouthOpen ? JAW_CLOSE : JAW_OPEN);
            if (mouthOpen) fog(0.035);

            const points = handResult.landmarks[0];
            if (points) {
              pinched = pinchRatio(points) < (pinched ? PINCH_RELEASE : PINCH_START);
              if (pinched) {
                const point = pinchPosition(points, canvas.current);
                clearAt(point.x, point.y);
              } else {
                previous.current = null;
              }
            } else {
              pinched = false;
              previous.current = null;
            }
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
