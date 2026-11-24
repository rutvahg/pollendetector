// Camera access with getUserMedia, full-resolution capture where the browser allows it.

let stream = null;
let track = null;

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export function isRunning() {
  return !!stream;
}

export async function startCamera(video) {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
  });
  track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  // Ask for continuous autofocus where the browser exposes it (mostly Chrome on Android).
  const caps = capabilities();
  if (caps.continuousFocus) {
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not supported */ }
  }
  return caps;
}

export function capabilities() {
  if (!track || typeof track.getCapabilities !== 'function') return { torch: false, continuousFocus: false };
  try {
    const c = track.getCapabilities();
    return {
      torch: !!c.torch,
      continuousFocus: Array.isArray(c.focusMode) && c.focusMode.includes('continuous'),
    };
  } catch {
    return { torch: false, continuousFocus: false };
  }
}

export async function setTorch(on) {
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  } catch {
    return false;
  }
}

export function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
}

/**
 * The framing box drawn over the preview, as a fraction of the camera frame.
 * The preview uses object-fit: cover, so part of the frame can be cut off at the edges.
 */
export function guideRegion(video, fraction) {
  const w = video.clientWidth, h = video.clientHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!w || !h || !vw || !vh) return { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.max(w / vw, h / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (w - dispW) / 2, offY = (h - dispH) / 2;
  const side = Math.min(w, h) * fraction;
  const gx = (w - side) / 2, gy = (h - side) / 2;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const x = clamp((gx - offX) / dispW), y = clamp((gy - offY) / dispH);
  return { x, y, w: clamp(side / dispW), h: clamp(side / dispH) };
}

export async function capturePhoto(video, fraction) {
  const crop = guideRegion(video, fraction);
  let blob = null;
  let fullRes = false;

  // Chrome on Android: ImageCapture gives a full sensor-resolution still.
  if (track && 'ImageCapture' in window) {
    try {
      const photo = await new window.ImageCapture(track).takePhoto();
      if (photo && photo.size > 0) { blob = photo; fullRes = true; }
    } catch { /* fall back to a video frame */ }
  }

  if (!blob) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    blob = await new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not save the picture.'))), 'image/jpeg', 0.92));
  }

  const lowRes = !fullRes && Math.max(video.videoWidth, video.videoHeight) < 1600;
  return { blob, crop, lowRes };
}
