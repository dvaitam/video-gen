import express from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { promises as fsPromises } from 'fs';
import fetch, { Headers } from 'node-fetch';
import multer from 'multer';
import FormData from 'form-data';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const SSL_CERT_PATH =
  typeof process.env.SSL_CERT_PATH === 'string' && process.env.SSL_CERT_PATH.trim()
    ? process.env.SSL_CERT_PATH.trim()
    : '/etc/letsencrypt/live/manchik.co.uk/fullchain.pem';
const SSL_KEY_PATH =
  typeof process.env.SSL_KEY_PATH === 'string' && process.env.SSL_KEY_PATH.trim()
    ? process.env.SSL_KEY_PATH.trim()
    : '/etc/letsencrypt/live/manchik.co.uk/privkey.pem';
const POLL_INTERVAL_MS =
  Number(process.env.VIDEO_POLL_INTERVAL_MS) ||
  Number(process.env.SORA_POLL_INTERVAL_MS) ||
  5000;
const POLL_TIMEOUT_MS =
  Number(process.env.VIDEO_POLL_TIMEOUT_MS) ||
  Number(process.env.SORA_POLL_TIMEOUT_MS) ||
  5 * 60 * 1000;
const VIDEO_HISTORY_LIMIT =
  Number(process.env.VIDEO_HISTORY_LIMIT) ||
  Number(process.env.SORA_VIDEO_HISTORY_LIMIT) ||
  20;
const DEFAULT_MODEL =
  typeof process.env.OPENAI_VIDEO_MODEL === 'string' && process.env.OPENAI_VIDEO_MODEL.trim()
    ? process.env.OPENAI_VIDEO_MODEL.trim()
    : 'sora-2';
const OPENAI_BASE_URL = (() => {
  const candidates = [process.env.OPENAI_VIDEOS_BASE_URL, process.env.OPENAI_BASE_URL].filter(
    (value) => typeof value === 'string' && value.trim()
  );
  const base = (candidates[0] || 'https://api.openai.com/v1').trim();
  return base.replace(/\/+$/, '');
})();
const LOG_PREFIX = '[video-app]';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const videosDir = path.join(__dirname, 'videos');
const uploadsDir = path.join(__dirname, 'uploads');

ensureDirectory(videosDir);
ensureDirectory(uploadsDir);

const upload = multer({ dest: uploadsDir });
const streamPipeline = promisify(pipeline);
const generatedVideos = [];

const app = express();
app.use('/videos', express.static(videosDir));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate', upload.single('input_reference'), async (req, res) => {
  const prompt = typeof req?.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const requestedModel = typeof req?.body?.model === 'string' ? req.body.model.trim() : '';
  const seconds = typeof req?.body?.seconds === 'string' ? req.body.seconds.trim() : '';
  const size = typeof req?.body?.size === 'string' ? req.body.size.trim() : '';
  const apiKey = resolveApiKey(req.body?.apiKey);
  const selectedModel = requestedModel || DEFAULT_MODEL;

  if (!prompt) {
    cleanUploadedFile(req.file);
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  if (!apiKey) {
    cleanUploadedFile(req.file);
    return res.status(400).json({ error: 'OpenAI API key is required. Provide one in the request or set OPENAI_API_KEY.' });
  }

  try {
    const { videoId } = await generateVideo({
      prompt,
      model: selectedModel,
      seconds,
      size,
      apiKey,
      file: req.file,
    });
    const fileInfo = await downloadVideoLocally({ apiKey, videoId });
    const entry = await recordGeneratedVideo({
      videoId,
      prompt,
      model: selectedModel,
      filePath: fileInfo.filePath,
      url: fileInfo.relativeUrl,
      contentType: fileInfo.contentType,
      size: fileInfo.size,
    });

    return res.json(entryResponse(entry));
  } catch (error) {
    console.error(`${LOG_PREFIX} generation error`, error);
    return res.status(502).json({ error: error?.message || 'Failed to generate the video.' });
  } finally {
    cleanUploadedFile(req.file);
  }
});

app.use(express.json({ limit: '1mb' }));
app.post('/api/videos/remote/list', async (req, res) => {
  const apiKey = resolveApiKey(req.body?.apiKey);
  if (!apiKey) {
    return res.status(400).json({ error: 'OpenAI API key is required to list remote videos.' });
  }

  try {
    const remoteVideos = await listRemoteVideos(apiKey);
    const annotated = remoteVideos.map((video) => {
      const localEntry = generatedVideos.find((entry) => entry.videoId === video.id);
      return {
        ...video,
        downloaded: Boolean(localEntry),
        localUrl: localEntry?.url ?? null,
      };
    });

    res.json({ videos: annotated });
  } catch (error) {
    console.error(`${LOG_PREFIX} remote list error`, error);
    res.status(502).json({ error: error?.message || 'Unable to list remote videos.' });
  }
});

app.post('/api/videos/remote/download', async (req, res) => {
  const videoId = typeof req?.body?.videoId === 'string' ? req.body.videoId.trim() : '';
  const apiKey = resolveApiKey(req.body?.apiKey);

  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required.' });
  }

  if (!apiKey) {
    return res.status(400).json({ error: 'OpenAI API key is required to download remote videos.' });
  }

  try {
    const remoteDetails = await getRemoteVideoDetails({ apiKey, videoId });
    const prompt = remoteDetails?.prompt || remoteDetails?.metadata?.prompt || remoteDetails?.description || `Remote video ${videoId}`;
    const model =
      remoteDetails?.model ||
      remoteDetails?.metadata?.model ||
      DEFAULT_MODEL;
    const fileInfo = await downloadVideoLocally({ apiKey, videoId });
    const entry = await recordGeneratedVideo({
      videoId,
      prompt,
      model,
      filePath: fileInfo.filePath,
      url: fileInfo.relativeUrl,
      contentType: fileInfo.contentType,
      size: fileInfo.size,
    });

    res.json({
      video: entryResponse(entry),
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} remote download error`, error);
    res.status(502).json({ error: error?.message || 'Unable to download remote video.' });
  }
});

app.get('/api/videos', async (req, res) => {
  try {
    const videos = await listAllLocalVideos();
    res.json({ videos: videos.map(entryResponse) });
  } catch (error) {
    console.error(`${LOG_PREFIX} local list error`, error);
    res.status(500).json({ error: 'Unable to list local videos.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Video generation app listening on http://localhost:${PORT}`);
});

if (canStartHttps()) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(SSL_KEY_PATH),
      cert: fs.readFileSync(SSL_CERT_PATH),
    };
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      console.log(`Video generation app listening on https://localhost:${HTTPS_PORT}`);
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to start HTTPS server`, error);
  }
} else {
  console.warn(`${LOG_PREFIX} HTTPS not started. Ensure SSL_CERT_PATH and SSL_KEY_PATH point to readable files.`);
}

async function generateVideo({ prompt, model, seconds, size, apiKey, file }) {
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('model', model || DEFAULT_MODEL);

  if (seconds) {
    formData.append('seconds', seconds);
  }

  if (size) {
    formData.append('size', size);
  }

  if (file?.path) {
    formData.append('input_reference', fs.createReadStream(file.path), {
      filename: file.originalname || 'reference',
      contentType: file.mimetype || 'application/octet-stream',
    });
  }

  const response = await fetch(`${OPENAI_BASE_URL}/videos`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: formData,
  });

  if (!response.ok) {
    const errorPayload = await safeJson(response);
    const message = errorPayload?.error?.message || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  const creation = await response.json();
  const videoId = creation?.id;
  if (!videoId) {
    throw new Error('Missing video ID in create response.');
  }

  await waitForVideoCompletion({ apiKey, videoId });
  return { videoId };
}

async function waitForVideoCompletion({ apiKey, videoId }) {
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await delay(POLL_INTERVAL_MS);

    const response = await fetch(`${OPENAI_BASE_URL}/videos/${videoId}`, {
      method: 'GET',
      headers: buildHeaders(apiKey, { accept: 'application/json' }),
    });

    if (!response.ok) {
      const errorPayload = await safeJson(response);
      const message = errorPayload?.error?.message || `Polling failed with status ${response.status}`;
      throw new Error(message);
    }

    const payload = await response.json();
    const status = payload?.status;

    if (status === 'queued' || status === 'processing' || status === 'in_progress') {
      continue;
    }

    if (status === 'completed' || status === 'succeeded') {
      return true;
    }

    const errorMessage = payload?.error?.message || `Generation finished with status: ${status ?? 'unknown'}`;
    throw new Error(errorMessage);
  }

  throw new Error('Timed out while waiting for the video to render.');
}

async function downloadVideoLocally({ apiKey, videoId }) {
  const response = await fetch(`${OPENAI_BASE_URL}/videos/${videoId}/content`, {
    method: 'GET',
    headers: buildHeaders(apiKey, { accept: '*/*' }),
  });

  if (!response.ok && response.status !== 206) {
    const errorPayload = await safeJson(response);
    const message = errorPayload?.error?.message || `Failed to download video (status ${response.status}).`;
    throw new Error(message);
  }

  const contentType = response.headers.get('content-type') || 'video/mp4';
  const extension = inferExtensionFromContentType(contentType);
  const fileName = `${videoId}-${Date.now()}.${extension}`;
  const filePath = path.join(videosDir, fileName);

  if (!response.body) {
    throw new Error('Received empty video stream from OpenAI.');
  }

  await streamPipeline(response.body, fs.createWriteStream(filePath));
  const stats = await fsPromises.stat(filePath);

  return {
    filePath,
    relativeUrl: `/videos/${fileName}`,
    contentType,
    size: stats.size,
  };
}

async function listRemoteVideos(apiKey) {
  const response = await fetch(`${OPENAI_BASE_URL}/videos`, {
    method: 'GET',
    headers: buildHeaders(apiKey, { accept: 'application/json' }),
  });

  if (!response.ok) {
    const errorPayload = await safeJson(response);
    const message = errorPayload?.error?.message || `Failed to list videos (status ${response.status}).`;
    throw new Error(message);
  }

  const payload = await response.json();
  const videos = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.videos) ? payload.videos : [];

  return videos.map((item) => ({
    id: item?.id,
    status: item?.status,
    model: item?.model,
    duration: item?.duration,
    aspect_ratio: item?.aspect_ratio,
    createdAt: normalizeTimestamp(item?.created_at || item?.createdAt),
    prompt: item?.prompt || item?.metadata?.prompt || item?.description || '',
  }));
}

async function getRemoteVideoDetails({ apiKey, videoId }) {
  const response = await fetch(`${OPENAI_BASE_URL}/videos/${videoId}`, {
    method: 'GET',
    headers: buildHeaders(apiKey, { accept: 'application/json' }),
  });

  if (!response.ok) {
    const errorPayload = await safeJson(response);
    const message = errorPayload?.error?.message || `Failed to fetch video details (status ${response.status}).`;
    throw new Error(message);
  }

  return response.json();
}

async function recordGeneratedVideo({ videoId, prompt, model, filePath, url, contentType, size }) {
  const entry = {
    videoId,
    prompt,
    model: model || DEFAULT_MODEL,
    createdAt: new Date().toISOString(),
    url,
    filePath,
    contentType,
    size,
  };

  const existingIndex = generatedVideos.findIndex((video) => video.videoId === videoId);
  if (existingIndex >= 0) {
    const [existing] = generatedVideos.splice(existingIndex, 1);
    if (existing?.filePath && existing.filePath !== filePath) {
      deleteFileQuietly(existing.filePath);
    }
  }

  generatedVideos.unshift(entry);

  while (generatedVideos.length > VIDEO_HISTORY_LIMIT) {
    const removed = generatedVideos.pop();
    if (removed?.filePath) {
      deleteFileQuietly(removed.filePath);
    }
  }

  return entry;
}

function entryResponse(entry) {
  return {
    videoId: entry.videoId,
    prompt: entry.prompt,
    model: entry.model || DEFAULT_MODEL,
    createdAt: entry.createdAt,
    url: entry.url,
    contentType: entry.contentType,
    size: entry.size,
  };
}

function inferExtensionFromContentType(contentType) {
  const lowered = (contentType || '').toLowerCase();
  if (lowered.includes('mp4')) return 'mp4';
  if (lowered.includes('webm')) return 'webm';
  if (lowered.includes('quicktime')) return 'mov';
  return 'bin';
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return asDate.toISOString();
  }
  return null;
}

function buildHeaders(apiKey, { accept, contentType } = {}) {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (accept) headers.set('Accept', accept);
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

function resolveApiKey(providedKey) {
  const trimmed = typeof providedKey === 'string' ? providedKey.trim() : '';
  return trimmed || process.env.OPENAI_API_KEY || '';
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function deleteFileQuietly(filePath) {
  fsPromises.unlink(filePath).catch(() => {});
}

function cleanUploadedFile(file) {
  if (file?.path) {
    deleteFileQuietly(file.path);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}


async function listAllLocalVideos() {
  const dirEntries = await fsPromises.readdir(videosDir, { withFileTypes: true });
  const metadataByFileName = new Map();

  for (const entry of generatedVideos) {
    const fileName =
      (entry?.filePath && path.basename(entry.filePath)) ||
      (entry?.url && path.basename(entry.url)) ||
      null;

    if (fileName && !metadataByFileName.has(fileName)) {
      metadataByFileName.set(fileName, entry);
    }
  }

  const videos = [];

  for (const dirent of dirEntries) {
    if (!dirent.isFile()) continue;

    const fileName = dirent.name;
    const filePath = path.join(videosDir, fileName);
    const stats = await fsPromises.stat(filePath);
    const metadata = metadataByFileName.get(fileName);
    const createdAt =
      metadata?.createdAt ||
      (stats.mtime instanceof Date ? stats.mtime.toISOString() : new Date(stats.mtime).toISOString());

    videos.push({
      videoId: metadata?.videoId || fileName,
      prompt: metadata?.prompt || defaultPromptForFile(fileName),
      model: metadata?.model || DEFAULT_MODEL,
      createdAt,
      url: `/videos/${fileName}`,
      filePath,
      contentType: metadata?.contentType || inferContentTypeFromFileName(fileName),
      size: metadata?.size || stats.size,
    });
  }

  videos.sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    return bTime - aTime;
  });

  return videos;
}

function inferContentTypeFromFileName(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov' || ext === '.qt') return 'video/quicktime';
  return 'application/octet-stream';
}

function defaultPromptForFile(fileName) {
  return `Local video (${fileName})`;
}

function canStartHttps() {
  if (!SSL_CERT_PATH || !SSL_KEY_PATH) {
    return false;
  }

  try {
    return fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
  } catch (error) {
    return false;
  }
}
