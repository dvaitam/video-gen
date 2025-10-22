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
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { randomUUID } from 'crypto';

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
const OPENAI_POLL_INTERVAL_MS =
  Number(process.env.VIDEO_POLL_INTERVAL_MS) ||
  Number(process.env.SORA_POLL_INTERVAL_MS) ||
  5000;
const OPENAI_POLL_TIMEOUT_MS =
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
const GEMINI_POLL_INTERVAL_MS = Number(process.env.GEMINI_POLL_INTERVAL_MS) || 20000;
const GEMINI_POLL_TIMEOUT_MS = Number(process.env.GEMINI_POLL_TIMEOUT_MS) || 10 * 60 * 1000;
const OPENAI_PROVIDER = 'openai';
const GOOGLE_PROVIDER = 'google';
const LOG_PREFIX = '[video-app]';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const videosDir = path.join(__dirname, 'videos');
const uploadsDir = path.join(__dirname, 'uploads');
const referencesDir = path.join(__dirname, 'references');

ensureDirectory(videosDir);
ensureDirectory(uploadsDir);
ensureDirectory(referencesDir);

const upload = multer({ dest: uploadsDir });
const streamPipeline = promisify(pipeline);
const generatedVideos = [];

const app = express();
app.use('/videos', express.static(videosDir));
app.use('/references', express.static(referencesDir));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate', upload.single('input_reference'), async (req, res) => {
  const prompt = typeof req?.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const requestedModel = typeof req?.body?.model === 'string' ? req.body.model.trim() : '';
  const seconds = typeof req?.body?.seconds === 'string' ? req.body.seconds.trim() : '';
  const size = typeof req?.body?.size === 'string' ? req.body.size.trim() : '';
  const requestedProvider = typeof req?.body?.provider === 'string' ? req.body.provider.trim().toLowerCase() : '';
  const referenceUrl = typeof req?.body?.reference_url === 'string' ? req.body.reference_url.trim() : '';

  let provider = normalizeProvider(requestedProvider, requestedModel);
  let selectedModel = requestedModel || defaultModelForProvider(provider);
  provider = normalizeProvider(provider, selectedModel);
  selectedModel = requestedModel || defaultModelForProvider(provider);

  let referenceSource;
  try {
    referenceSource = await resolveReferenceSource({ uploadedFile: req.file, referenceUrl });
  } catch (error) {
    console.error(`${LOG_PREFIX} reference resolution error`, error);
    cleanUploadedFile(req.file);
    return res.status(400).json({ error: error?.message || 'Invalid reference image.' });
  }

  if (referenceUrl && !referenceSource) {
    cleanUploadedFile(req.file);
    return res.status(404).json({ error: 'Requested reference image was not found on the server.' });
  }

  const referenceFile = referenceSource?.file;
  const apiKey = resolveApiKeyForProvider(provider, req.body?.apiKey);

  if (!prompt) {
    cleanUploadedFile(referenceFile);
    if (req.file && req.file !== referenceFile) cleanUploadedFile(req.file);
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  if (!apiKey) {
    cleanUploadedFile(referenceFile);
    if (req.file && req.file !== referenceFile) cleanUploadedFile(req.file);
    const missingKeyMessage =
      provider === GOOGLE_PROVIDER
        ? 'Google Gemini API key is required for Veo models. Provide one in the request or set GEMINI_API_KEY.'
        : 'OpenAI API key is required. Provide one in the request or set OPENAI_API_KEY.';
    return res.status(400).json({ error: missingKeyMessage });
  }

  try {
    const generation = await generateVideo({
      prompt,
      model: selectedModel,
      seconds,
      size,
      apiKey,
      provider,
      file: referenceFile,
    });
    const fileInfo = await downloadVideoLocally({
      provider,
      apiKey,
      videoId: generation.videoId,
      downloadUrl: generation.downloadUrl,
      contentType: generation.contentType,
    });
    const referencePersistence = await persistReferenceFile(referenceFile, referenceSource?.existingUrl);
    const entry = await recordGeneratedVideo({
      videoId: generation.videoId,
      prompt,
      model: selectedModel,
      provider,
      filePath: fileInfo.filePath,
      url: fileInfo.relativeUrl,
      contentType: fileInfo.contentType,
      size: fileInfo.size,
      referenceUrl: referencePersistence?.url || referenceSource?.existingUrl || null,
    });

    return res.json(entryResponse(entry));
  } catch (error) {
    console.error(`${LOG_PREFIX} generation error`, error);
    return res.status(502).json({ error: error?.message || 'Failed to generate the video.' });
  } finally {
    if (referenceFile) {
      cleanUploadedFile(referenceFile);
    }
    if (req.file && req.file !== referenceFile) {
      cleanUploadedFile(req.file);
    }
  }
});

app.use(express.json({ limit: '1mb' }));
app.post('/api/videos/remote/list', async (req, res) => {
  const apiKey = resolveOpenAIApiKey(req.body?.apiKey);
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
  const apiKey = resolveOpenAIApiKey(req.body?.apiKey);

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
    const fileInfo = await downloadVideoLocally({
      provider: OPENAI_PROVIDER,
      apiKey,
      videoId,
    });
    const entry = await recordGeneratedVideo({
      videoId,
      prompt,
      model,
      provider: OPENAI_PROVIDER,
      filePath: fileInfo.filePath,
      url: fileInfo.relativeUrl,
      contentType: fileInfo.contentType,
      size: fileInfo.size,
      referenceUrl: null,
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

app.get('/api/references', async (req, res) => {
  try {
    const references = await listSavedReferences();
    res.json({ references });
  } catch (error) {
    console.error(`${LOG_PREFIX} reference list error`, error);
    res.status(500).json({ error: 'Unable to list saved references.' });
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

async function generateVideo({ prompt, model, seconds, size, apiKey, provider, file }) {
  if (provider === GOOGLE_PROVIDER) {
    return generateVeoVideo({ prompt, model, seconds, size, apiKey, file });
  }

  return generateOpenAIVideo({ prompt, model, seconds, size, apiKey, file });
}

async function generateOpenAIVideo({ prompt, model, seconds, size, apiKey, file }) {
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
    const prepared = await prepareOpenAIReferenceFile({ file, size });
    const referencePath = prepared?.filePath || file.path;
    const referenceName = prepared?.fileName || file.originalname || 'reference';
    const referenceMime =
      prepared?.mimeType || inferImageMimeType(file) || file.mimetype || 'application/octet-stream';

    formData.append('input_reference', fs.createReadStream(referencePath), {
      filename: referenceName,
      contentType: referenceMime,
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

  await waitForOpenAIVideoCompletion({ apiKey, videoId });
  return { provider: OPENAI_PROVIDER, videoId };
}

async function prepareOpenAIReferenceFile({ file, size }) {
  if (!file?.path) {
    return null;
  }

  if (!isImageFile(file)) {
    return null;
  }

  const dimensions = parseSize(size);
  if (!dimensions) {
    return null;
  }

  const { width, height } = dimensions;
  const tempFileName = `sora-ref-${Date.now()}-${randomUUID()}.png`;
  const tempFilePath = path.join(uploadsDir, tempFileName);

  await sharp(file.path)
    .resize(width, height, { fit: 'fill' })
    .png()
    .toFile(tempFilePath);

  file.generatedPaths = Array.isArray(file.generatedPaths) ? file.generatedPaths : [];
  file.generatedPaths.push(tempFilePath);

  return {
    filePath: tempFilePath,
    fileName: 'reference.png',
    mimeType: 'image/png',
  };
}

async function waitForOpenAIVideoCompletion({ apiKey, videoId }) {
  const startTime = Date.now();

  while (Date.now() - startTime < OPENAI_POLL_TIMEOUT_MS) {
    await delay(OPENAI_POLL_INTERVAL_MS);

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

async function generateVeoVideo({ prompt, model, seconds, size, apiKey, file }) {
  const client = new GoogleGenAI({ apiKey });
  const modelName = resolveGoogleModelName(model);

  const requestPayload = {
    model: modelName,
    prompt,
  };

  const imageReference = await buildGeminiImageReference(file);
  if (imageReference) {
    requestPayload.image = imageReference;
  }

  let operation = await client.models.generateVideos(requestPayload);
  const completedOperation = await waitForGeminiOperation({ client, operation });

  const generatedVideos =
    completedOperation?.response?.generatedVideos ||
    completedOperation?.result?.generatedVideos ||
    [];
  const primaryVideo = Array.isArray(generatedVideos) ? generatedVideos[0] : null;
  const downloadUrl =
    primaryVideo?.video?.downloadUri ||
    primaryVideo?.video?.fileUri ||
    primaryVideo?.video?.uri ||
    primaryVideo?.video?.gcsUri ||
    null;

  if (!downloadUrl) {
    throw new Error('Gemini response did not include a downloadable video URI.');
  }

  const contentType = primaryVideo?.video?.mimeType || 'video/mp4';
  const videoId = completedOperation?.name || completedOperation?.operation || primaryVideo?.video?.name || downloadUrl;

  return {
    provider: GOOGLE_PROVIDER,
    videoId,
    downloadUrl,
    contentType,
  };
}

async function waitForGeminiOperation({ client, operation }) {
  const startTime = Date.now();
  let latestOperation = operation;

  while (Date.now() - startTime < GEMINI_POLL_TIMEOUT_MS) {
    if (latestOperation?.done === true) {
      if (latestOperation?.error) {
        const message =
          latestOperation.error.message ||
          latestOperation.error.code ||
          'Gemini operation failed.';
        throw new Error(message);
      }
      return latestOperation;
    }

    const state = latestOperation?.metadata?.state;
    if (state === 'FAILED' || state === 'CANCELLED') {
      const message =
        latestOperation?.error?.message ||
        latestOperation?.metadata?.errorMessage ||
        `Gemini operation finished with status ${state}`;
      throw new Error(message);
    }

    await delay(GEMINI_POLL_INTERVAL_MS);
    latestOperation = await client.operations.getVideosOperation({
      operation: latestOperation,
    });
  }

  throw new Error('Timed out while waiting for the Gemini video to render.');
}

async function buildGeminiImageReference(file) {
  if (!file?.path) {
    return null;
  }

  const mimeType = inferImageMimeType(file);
  if (!mimeType || !mimeType.startsWith('image/')) {
    return null;
  }

  try {
    const fileData = await fsPromises.readFile(file.path);
    if (!fileData?.length) {
      return null;
    }

    return {
      imageBytes: fileData.toString('base64'),
      mimeType,
    };
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to read reference image`, error);
    return null;
  }
}

async function downloadVideoLocally({ provider, apiKey, videoId, downloadUrl, contentType }) {
  if (provider === GOOGLE_PROVIDER) {
    return downloadRemoteAsset({
      downloadUrl,
      contentType,
      fileNamePrefix: sanitizeFileComponent(videoId || 'veo'),
      apiKey,
    });
  }

  return downloadOpenAIVideo({ apiKey, videoId });
}

async function downloadOpenAIVideo({ apiKey, videoId }) {
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

async function downloadRemoteAsset({ downloadUrl, contentType, fileNamePrefix, apiKey }) {
  if (!downloadUrl) {
    throw new Error('Missing download URL for generated video.');
  }

  let finalUrl = downloadUrl;
  const headers = {};

  try {
    const parsed = new URL(downloadUrl);
    const isGoogleHost = parsed.hostname.endsWith('googleapis.com');
    if (apiKey && isGoogleHost && !parsed.searchParams.has('key')) {
      parsed.searchParams.set('key', apiKey);
      finalUrl = parsed.toString();
    }
    if (apiKey && isGoogleHost) {
      headers['x-goog-api-key'] = apiKey;
    }
  } catch (error) {
    // Ignore URL parsing issues and fall back to raw URL.
  }

  const response = await fetch(finalUrl, {
    method: 'GET',
    headers,
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to download Gemini video (status ${response.status}).`);
  }

  const resolvedContentType = contentType || response.headers.get('content-type') || 'video/mp4';
  const extension = inferExtensionFromContentType(resolvedContentType);
  const safePrefix = fileNamePrefix || `video-${Date.now()}`;
  const fileName = `${safePrefix}-${Date.now()}.${extension}`;
  const filePath = path.join(videosDir, fileName);

  if (!response.body) {
    throw new Error('Received empty video stream from Gemini.');
  }

  await streamPipeline(response.body, fs.createWriteStream(filePath));
  const stats = await fsPromises.stat(filePath);

  return {
    filePath,
    relativeUrl: `/videos/${fileName}`,
    contentType: resolvedContentType,
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
    provider: OPENAI_PROVIDER,
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

async function recordGeneratedVideo({
  videoId,
  prompt,
  model,
  provider,
  filePath,
  url,
  contentType,
  size,
  referenceUrl,
}) {
  const entry = {
    videoId,
    prompt,
    model: model || DEFAULT_MODEL,
    provider: provider || inferProvider(model || DEFAULT_MODEL),
    createdAt: new Date().toISOString(),
    url,
    filePath,
    contentType,
    size,
    referenceUrl: referenceUrl || null,
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
    provider: entry.provider || inferProvider(entry.model || DEFAULT_MODEL),
    createdAt: entry.createdAt,
    url: entry.url,
    videoUrl: entry.url,
    contentType: entry.contentType,
    size: entry.size,
    referenceUrl: entry.referenceUrl || null,
  };
}

function inferExtensionFromContentType(contentType) {
  const lowered = (contentType || '').toLowerCase();
  if (lowered.includes('mp4')) return 'mp4';
  if (lowered.includes('webm')) return 'webm';
  if (lowered.includes('quicktime')) return 'mov';
  return 'bin';
}

function inferImageMimeType(file) {
  const direct = typeof file?.mimetype === 'string' ? file.mimetype.trim().toLowerCase() : '';
  if (direct.startsWith('image/')) {
    return direct;
  }

  const extension = (typeof file?.originalname === 'string' ? path.extname(file.originalname) : '').toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.heic') return 'image/heic';
  if (extension === '.heif') return 'image/heif';

  return direct || null;
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

function resolveOpenAIApiKey(providedKey) {
  const trimmed = typeof providedKey === 'string' ? providedKey.trim() : '';
  return trimmed || process.env.OPENAI_API_KEY || '';
}

function resolveGeminiApiKey(providedKey) {
  const trimmed = typeof providedKey === 'string' ? providedKey.trim() : '';
  return trimmed || process.env.GEMINI_API_KEY || '';
}

function resolveApiKeyForProvider(provider, providedKey) {
  if (provider === GOOGLE_PROVIDER) {
    return resolveGeminiApiKey(providedKey);
  }

  return resolveOpenAIApiKey(providedKey);
}

function inferProvider(model) {
  const normalized = (model || '').toLowerCase();
  if (normalized.startsWith('veo')) {
    return GOOGLE_PROVIDER;
  }

  return OPENAI_PROVIDER;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function deleteFileQuietly(filePath) {
  fsPromises.unlink(filePath).catch(() => {});
}

function cleanUploadedFile(file) {
  if (!file) return;

  if (Array.isArray(file.generatedPaths)) {
    for (const generated of file.generatedPaths) {
      if (generated) {
        deleteFileQuietly(generated);
      }
    }
    file.generatedPaths = [];
  }

  if (file.preserve) {
    return;
  }

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
    const model = metadata?.model || DEFAULT_MODEL;
    const provider = metadata?.provider || inferProvider(model);
    const createdAt =
      metadata?.createdAt ||
      (stats.mtime instanceof Date ? stats.mtime.toISOString() : new Date(stats.mtime).toISOString());

    videos.push({
      videoId: metadata?.videoId || fileName,
      prompt: metadata?.prompt || defaultPromptForFile(fileName),
      model,
      provider,
      createdAt,
      url: `/videos/${fileName}`,
      filePath,
      contentType: metadata?.contentType || inferContentTypeFromFileName(fileName),
      size: metadata?.size || stats.size,
      referenceUrl: metadata?.referenceUrl || null,
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

function sanitizeFileComponent(value) {
  const safe = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safe || 'video';
}

function normalizeProvider(provider, model) {
  const normalized = (provider || '').toLowerCase();
  if (normalized === GOOGLE_PROVIDER || normalized === 'google' || normalized === 'gemini' || normalized === 'veo') {
    return GOOGLE_PROVIDER;
  }

  if (normalized === OPENAI_PROVIDER || normalized === 'openai' || normalized === 'sora') {
    return OPENAI_PROVIDER;
  }

  return inferProvider(model);
}

function defaultModelForProvider(provider) {
  if (provider === GOOGLE_PROVIDER) {
    return 'veo-3.1-generate-preview';
  }
  return DEFAULT_MODEL;
}

function parseSize(sizeValue) {
  if (typeof sizeValue !== 'string') return null;
  const trimmed = sizeValue.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([0-9]{2,5})\s*x\s*([0-9]{2,5})$/i);
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function isImageFile(file) {
  return Boolean(inferImageMimeType(file));
}

function extensionFromMime(mimeType) {
  if (!mimeType) return '.png';
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/bmp') return '.bmp';
  if (normalized === 'image/heic') return '.heic';
  if (normalized === 'image/heif') return '.heif';
  return '.png';
}

async function resolveReferenceSource({ uploadedFile, referenceUrl }) {
  if (uploadedFile) {
    return { file: uploadedFile, existingUrl: null };
  }

  if (!referenceUrl) {
    return null;
  }

  const normalizedFileName = normalizeReferenceUrl(referenceUrl);
  if (!normalizedFileName) {
    throw new Error('Invalid reference file.');
  }

  const absolutePath = path.join(referencesDir, normalizedFileName);
  if (!absolutePath.startsWith(referencesDir)) {
    throw new Error('Reference path is not permitted.');
  }

  const exists = await fileExists(absolutePath);
  if (!exists) {
    return null;
  }

  const mimetype = inferImageMimeType({ originalname: normalizedFileName }) || 'image/png';
  const file = {
    path: absolutePath,
    originalname: normalizedFileName,
    mimetype,
    preserve: true,
    existingUrl: `/references/${normalizedFileName}`,
  };

  if (!isImageFile(file)) {
    throw new Error('Saved reference is not an image file.');
  }

  return { file, existingUrl: file.existingUrl };
}

async function persistReferenceFile(file, existingUrl) {
  if (existingUrl) {
    return { url: existingUrl };
  }

  if (!file?.path || file.preserve || !isImageFile(file)) {
    return file?.existingUrl ? { url: file.existingUrl } : null;
  }

  const mimeType = inferImageMimeType(file) || 'image/png';
  const extension = extensionFromMime(mimeType);
  const baseName = sanitizeFileComponent(path.parse(file.originalname || 'reference').name);
  const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${baseName || 'reference'}${extension}`;
  const targetPath = path.join(referencesDir, fileName);

  await fsPromises.copyFile(file.path, targetPath);

  return {
    filePath: targetPath,
    url: `/references/${fileName}`,
  };
}

async function listSavedReferences() {
  const references = [];
  const entries = await fsPromises.readdir(referencesDir, { withFileTypes: true });

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;

    const fileName = dirent.name;
    const absolutePath = path.join(referencesDir, fileName);
    const stats = await fsPromises.stat(absolutePath);

    references.push({
      fileName,
      url: `/references/${fileName}`,
      createdAt: stats.mtime instanceof Date ? stats.mtime.toISOString() : new Date(stats.mtime).toISOString(),
      size: stats.size,
    });
  }

  references.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return references;
}

function normalizeReferenceUrl(value) {
  if (typeof value !== 'string') return null;
  let trimmed = value.trim();
  if (!trimmed) return null;

  const prefix = '/references/';
  const idx = trimmed.indexOf(prefix);
  if (idx >= 0) {
    trimmed = trimmed.slice(idx + prefix.length);
  }

  trimmed = trimmed.split('?')[0].split('#')[0];
  trimmed = trimmed.replace(/^[./\\]+/, '');
  if (!trimmed) return null;
  return path.basename(trimmed);
}

async function fileExists(targetPath) {
  try {
    const stats = await fsPromises.stat(targetPath);
    return stats.isFile();
  } catch (error) {
    return false;
  }
}

function resolveGoogleModelName(model) {
  const normalized = (model || '').toLowerCase();
  if (!normalized || normalized === 'veo-3' || normalized.startsWith('veo-3.0')) {
    return 'veo-3.1-generate-preview';
  }

  if (normalized.startsWith('veo-3.1')) {
    return 'veo-3.1-generate-preview';
  }

  return model || 'veo-3.1-generate-preview';
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
