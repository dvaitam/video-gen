const soraForm = document.getElementById('soraForm');
const promptInput = document.getElementById('promptInput');
const modelInput = document.getElementById('modelInput');
const durationInput = document.getElementById('durationInput');
const sizeInput = document.getElementById('sizeInput');
const referenceInput = document.getElementById('referenceInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const rememberKeyCheckbox = document.getElementById('rememberKey');
const statusMessage = document.getElementById('statusMessage');
const submitButton = document.getElementById('submitButton');
const videoPlayer = document.getElementById('videoPlayer');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const downloadLink = document.getElementById('downloadLink');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const loadRemoteButton = document.getElementById('loadRemoteButton');
const remoteList = document.getElementById('remoteList');
const remoteEmpty = document.getElementById('remoteEmpty');
const remoteStatus = document.getElementById('remoteStatus');
const fullVideoModal = document.getElementById('fullVideoModal');
const fullVideoPlayer = document.getElementById('fullVideoPlayer');
const modalCloseButton = document.getElementById('modalCloseButton');
const providerSelect = document.getElementById('providerSelect');
const referenceUrlInput = document.getElementById('referenceUrlInput');
const referencesList = document.getElementById('referencesList');
const referencesEmpty = document.getElementById('referencesEmpty');
const referencesStatus = document.getElementById('referencesStatus');
const openCameraButton = document.getElementById('openCameraButton');
const cameraPreview = document.getElementById('cameraPreview');
const captureFrameButton = document.getElementById('captureFrameButton');
const closeCameraButton = document.getElementById('closeCameraButton');
const cameraActions = document.querySelector('.camera-actions');

const MODEL_STORAGE_KEY = 'sora2-video-model';
const API_ENDPOINT = '/api/generate';
const HISTORY_ENDPOINT = '/api/videos';
const REMOTE_LIST_ENDPOINT = '/api/videos/remote/list';
const REMOTE_DOWNLOAD_ENDPOINT = '/api/videos/remote/download';
const REFERENCES_ENDPOINT = '/api/references';

const PROVIDER_STORAGE_KEY = 'sora2-provider';
const PROVIDER_KEY_MAP = {
  openai: 'sora2-api-key-openai',
  google: 'sora2-api-key-google',
};
const PROVIDER_DEFAULT_MODEL = {
  openai: 'sora-2',
  google: 'veo-3.1-generate-preview',
};
const PROVIDER_MODEL_PLACEHOLDER = {
  openai: 'sora-2 (default)',
  google: 'veo-3.1-generate-preview',
};
const PROVIDER_API_PLACEHOLDER = {
  openai: 'OpenAI API key (sk-...)',
  google: 'Gemini API key (AIza...)',
};
const VALID_PROVIDERS = Object.keys(PROVIDER_KEY_MAP);

let selectedProvider = 'openai';
let selectedReferenceUrl = '';

let cameraStream = null;
let cameraFrameRequest = null;
let cameraVideoElement = null;
let capturedBlob = null;

(() => {
  const storedProvider = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
  if (storedProvider && VALID_PROVIDERS.includes(storedProvider)) {
    selectedProvider = storedProvider;
  }

  if (providerSelect) {
    providerSelect.value = selectedProvider;
  }

  const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
  if (storedModel) {
    modelInput.value = storedModel;
  }

  applyProviderSelection(selectedProvider, { preserveModel: Boolean(modelInput.value?.trim()) });
})();

refreshHistory();
refreshReferences();

if (openCameraButton) {
  openCameraButton.addEventListener('click', (event) => {
    event.preventDefault();
    startCamera();
  });
}

if (captureFrameButton) {
  captureFrameButton.addEventListener('click', (event) => {
    event.preventDefault();
    captureCameraFrame();
  });
}

if (closeCameraButton) {
  closeCameraButton.addEventListener('click', (event) => {
    event.preventDefault();
    stopCamera();
    resetCapturedFrame();
  });
}

if (providerSelect) {
  providerSelect.addEventListener('change', (event) => {
    const value = (event.target.value || '').toLowerCase();
    selectedProvider = VALID_PROVIDERS.includes(value) ? value : 'openai';
    applyProviderSelection(selectedProvider);
  });
}

if (referencesList) {
  referencesList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reference-url]');
    if (!button) return;
    const url = button.getAttribute('data-reference-url');
    selectReference(url);
  });
}

function applyProviderSelection(provider, { preserveModel = false } = {}) {
  const normalized = VALID_PROVIDERS.includes(provider) ? provider : 'openai';
  selectedProvider = normalized;

  if (providerSelect) {
    providerSelect.value = normalized;
  }

  window.localStorage.setItem(PROVIDER_STORAGE_KEY, normalized);

  const defaultModel = PROVIDER_DEFAULT_MODEL[normalized] || 'sora-2';
  const otherDefaults = VALID_PROVIDERS.filter((key) => key !== normalized).map((key) =>
    (PROVIDER_DEFAULT_MODEL[key] || '').toLowerCase()
  );

  if (modelInput) {
    const currentModel = (modelInput.value || '').trim();
    const normalizedCurrent = currentModel.toLowerCase();
    if (!currentModel || otherDefaults.includes(normalizedCurrent)) {
      modelInput.value = defaultModel;
    }
    modelInput.placeholder = PROVIDER_MODEL_PLACEHOLDER[normalized] || '';
    window.localStorage.setItem(MODEL_STORAGE_KEY, modelInput.value.trim());
  }

  const storedKey = getStoredApiKey(normalized);
  if (apiKeyInput) {
    if (storedKey) {
      apiKeyInput.value = storedKey;
      if (rememberKeyCheckbox) {
        rememberKeyCheckbox.checked = true;
      }
    } else if (!preserveModel) {
      apiKeyInput.value = '';
      if (rememberKeyCheckbox) {
        rememberKeyCheckbox.checked = false;
      }
    } else if (rememberKeyCheckbox) {
      rememberKeyCheckbox.checked = Boolean(storedKey);
    }

    apiKeyInput.placeholder = PROVIDER_API_PLACEHOLDER[normalized] || '';
  }

  if (loadRemoteButton) {
    loadRemoteButton.disabled = normalized !== 'openai';
  }

  if (remoteStatus) {
    if (normalized !== 'openai') {
      remoteStatus.textContent = 'Switch to OpenAI provider to view remote videos.';
      remoteStatus.classList.add('status', 'status--error');
    } else {
      remoteStatus.textContent = '';
      remoteStatus.classList.remove('status--error', 'status--success');
    }
  }

  if (normalized !== 'openai') {
    renderRemoteVideos([]);
    if (remoteEmpty) remoteEmpty.style.display = 'block';
  }
}

function getStoredApiKey(provider) {
  const keyName = PROVIDER_KEY_MAP[provider];
  if (!keyName) return '';
  return window.localStorage.getItem(keyName) || '';
}

function setStoredApiKey(provider, apiKey) {
  const keyName = PROVIDER_KEY_MAP[provider];
  if (!keyName) return;
  if (apiKey) {
    window.localStorage.setItem(keyName, apiKey);
  }
}

function clearStoredApiKey(provider) {
  const keyName = PROVIDER_KEY_MAP[provider];
  if (!keyName) return;
  window.localStorage.removeItem(keyName);
}

if (referenceInput) {
  referenceInput.addEventListener('change', () => {
    if (referenceInput.files?.length) {
      clearReferenceSelection();
      capturedBlob = null;
      resetCapturedFrame();
      stopCamera();
    }
  });
}

modelInput.addEventListener('change', () => {
  const value = modelInput.value.trim();
  if (value) {
    window.localStorage.setItem(MODEL_STORAGE_KEY, value);
  } else {
    window.localStorage.removeItem(MODEL_STORAGE_KEY);
  }
});

soraForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const prompt = promptInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!prompt) {
    renderStatus('Please provide a prompt for the video model.', 'error');
    return;
  }

  toggleSubmittingState(true);
  renderStatus('Submitting prompt to the video API…');

  if (rememberKeyCheckbox.checked && apiKey) {
    setStoredApiKey(selectedProvider, apiKey);
  } else if (!rememberKeyCheckbox.checked) {
    clearStoredApiKey(selectedProvider);
  }

  let pendingStatusTimer;

  try {
    pendingStatusTimer = setInterval(() => {
      renderStatus('Still waiting for the video to finish rendering…');
    }, 5000);

    const result = await generateVideo({ apiKey });
    const videoUrl = result?.videoUrl;
    const modelName = formatModel(result?.model);
    const referenceFromResponse = typeof result?.referenceUrl === 'string' ? result.referenceUrl : '';

    if (!videoUrl) {
      throw new Error('The server response did not contain a video URL.');
    }

    if (referenceFromResponse) {
      selectedReferenceUrl = referenceFromResponse;
      if (referenceUrlInput) {
        referenceUrlInput.value = referenceFromResponse;
      }
      capturedBlob = null;
      if (referenceInput) {
        referenceInput.value = '';
      }
    }

    renderStatus(modelName ? `Video ready from ${modelName}!` : 'Video ready!', 'success');
    showVideo(videoUrl);
    await Promise.all([refreshHistory(), refreshReferences({ silent: true })]);
  } catch (error) {
    console.error(error);
    renderStatus(error.message || 'An unexpected error occurred.', 'error');
    clearVideo();
  } finally {
    if (pendingStatusTimer) {
      clearInterval(pendingStatusTimer);
    }
    toggleSubmittingState(false);
  }
});

loadRemoteButton.addEventListener('click', () => {
  refreshRemoteVideos();
});

historyList.addEventListener('click', (event) => {
  const playButton = event.target.closest('[data-history-play]');
  if (!playButton) return;

  const url = playButton.getAttribute('data-url');
  if (!url) return;

  showVideo(url);
  renderStatus('Loaded video from history.', 'success');
  openFullVideo(url);
});

remoteList.addEventListener('click', async (event) => {
  const downloadButton = event.target.closest('[data-remote-download]');
  if (!downloadButton) return;

  const videoId = downloadButton.getAttribute('data-video-id');
  const downloaded = downloadButton.getAttribute('data-downloaded') === 'true';
  const localUrl = downloadButton.getAttribute('data-local-url');

  if (downloaded && localUrl) {
    showVideo(localUrl);
    renderStatus('Loaded previously downloaded video.', 'success');
    openFullVideo(localUrl);
    return;
  }

  try {
    setRemoteStatus(`Downloading ${videoId} to the server…`);
    downloadButton.disabled = true;

    const apiKey = apiKeyInput.value.trim();
    const payload = { videoId };
    if (apiKey) {
      payload.apiKey = apiKey;
    }

    const response = await fetch(REMOTE_DOWNLOAD_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorPayload = await safeJson(response);
      const message =
        (typeof errorPayload?.error === 'string' && errorPayload.error) ||
        `Download failed with status ${response.status}`;
      throw new Error(message);
    }

    const payloadJson = await response.json();
    const videoUrl = payloadJson?.video?.url;
    const modelName = formatModel(payloadJson?.video?.model);
    if (videoUrl) {
      showVideo(videoUrl);
      renderStatus(
        modelName ? `Remote ${modelName} video downloaded and loaded.` : 'Remote video downloaded and loaded.',
        'success'
      );
      openFullVideo(videoUrl);
    }

    await Promise.all([refreshHistory(), refreshRemoteVideos({ silent: true })]);
  } catch (error) {
    console.error(error);
    renderStatus(error.message || 'Unable to download the remote video.', 'error');
  } finally {
    downloadButton.disabled = false;
    setRemoteStatus('');
  }
});

async function generateVideo({ apiKey }) {
  const formData = new FormData();
  formData.append('prompt', promptInput.value.trim());
  formData.append('provider', selectedProvider);
  if (referenceUrlInput) {
    formData.append('reference_url', (referenceUrlInput.value || '').trim());
  }

  const model = modelInput.value.trim();
  if (model) {
    formData.append('model', model);
  }

  const seconds = durationInput.value.trim();
  if (seconds) {
    formData.append('seconds', seconds);
  }

  const size = sizeInput.value.trim();
  if (size) {
    formData.append('size', size);
  }

  if (capturedBlob instanceof Blob) {
    formData.append('input_reference', capturedBlob, 'camera-reference.png');
  } else if (referenceInput.files?.length) {
    formData.append('input_reference', referenceInput.files[0]);
  }

  if (apiKey) {
    formData.append('apiKey', apiKey);
  }

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorPayload = await safeJson(response);
    const message =
      (typeof errorPayload?.error === 'string' && errorPayload.error) ||
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

function showVideo(url) {
  videoPlayer.src = url;
  videoPlayer.style.display = 'block';
  videoPlayer.load();
  videoPlaceholder.style.display = 'none';

  downloadLink.href = url;
  downloadLink.hidden = false;
}

function clearVideo() {
  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  videoPlayer.style.display = 'none';
  videoPlaceholder.style.display = 'flex';

  downloadLink.hidden = true;
  downloadLink.removeAttribute('href');
}

function toggleSubmittingState(isSubmitting) {
  submitButton.disabled = isSubmitting;
  promptInput.disabled = isSubmitting;
  modelInput.disabled = isSubmitting;
  durationInput.disabled = isSubmitting;
  sizeInput.disabled = isSubmitting;
  referenceInput.disabled = isSubmitting;
  apiKeyInput.disabled = isSubmitting;
  rememberKeyCheckbox.disabled = isSubmitting;
  if (providerSelect) providerSelect.disabled = isSubmitting;
  if (openCameraButton) openCameraButton.disabled = isSubmitting;
  if (captureFrameButton) captureFrameButton.disabled = isSubmitting;
  if (closeCameraButton) closeCameraButton.disabled = isSubmitting;
}

function renderStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.classList.remove('status--error', 'status--success');

  if (type === 'error') {
    statusMessage.classList.add('status', 'status--error');
  } else if (type === 'success') {
    statusMessage.classList.add('status', 'status--success');
  }
}

async function refreshHistory() {
  try {
    const response = await fetch(HISTORY_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Failed to load history (status ${response.status}).`);
    }

    const payload = await response.json();
    renderHistory(Array.isArray(payload?.videos) ? payload.videos : []);
  } catch (error) {
    console.error(error);
    renderHistory([]);
  }
}

async function refreshRemoteVideos({ silent = false } = {}) {
  try {
    if (!silent) {
      setRemoteStatus('Loading remote videos…');
      loadRemoteButton.disabled = true;
    }

    if (selectedProvider !== 'openai') {
      renderRemoteVideos([]);
      if (!silent) {
        setRemoteStatus('Remote videos are only available for OpenAI Sora models.', 'error');
      }
      remoteEmpty.style.display = 'block';
      return;
    }

    const apiKey = apiKeyInput.value.trim();
    const payload = {};
    if (apiKey) {
      payload.apiKey = apiKey;
    }

    const response = await fetch(REMOTE_LIST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorPayload = await safeJson(response);
      const message =
        (typeof errorPayload?.error === 'string' && errorPayload.error) ||
        `Failed to load remote videos (status ${response.status}).`;
      throw new Error(message);
    }

    const payloadJson = await response.json();
    renderRemoteVideos(Array.isArray(payloadJson?.videos) ? payloadJson.videos : []);
    setRemoteStatus('Remote videos loaded.', 'success');
  } catch (error) {
    console.error(error);
    renderRemoteVideos([]);
    setRemoteStatus(error.message || 'Unable to load remote videos.', 'error');
  } finally {
    loadRemoteButton.disabled = selectedProvider !== 'openai';
  }
}

function renderHistory(videos) {
  if (!videos.length) {
    historyEmpty.style.display = 'block';
    historyList.innerHTML = '';
    return;
  }

  historyEmpty.style.display = 'none';
  historyList.innerHTML = '';

  for (const video of videos) {
    const li = document.createElement('li');
    li.className = 'history-thumb';

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.historyPlay = 'true';
    button.dataset.url = video.url;
    button.className = 'history-thumb__button';

    const previewVideo = document.createElement('video');
    previewVideo.className = 'history-thumb__video';
    previewVideo.src = video.url;
    previewVideo.preload = 'metadata';
    previewVideo.muted = true;
    previewVideo.playsInline = true;
    previewVideo.loop = true;
    previewVideo.setAttribute('preload', 'metadata');
    previewVideo.setAttribute('muted', '');
    previewVideo.setAttribute('playsinline', '');
    previewVideo.setAttribute('loop', '');

    button.appendChild(previewVideo);
    attachThumbnailPreview(button, previewVideo);

    const caption = document.createElement('div');
    caption.className = 'history-thumb__caption';

    const title = document.createElement('p');
    title.className = 'history-thumb__title';
    title.textContent = video.prompt || '(no prompt provided)';

    const meta = document.createElement('span');
    meta.className = 'history-thumb__meta';
    const historyDetails = [formatTimestamp(video.createdAt), formatModel(video.model)];
    meta.textContent = historyDetails.filter(Boolean).join(' • ');

    caption.appendChild(title);
    caption.appendChild(meta);

    li.appendChild(button);
    li.appendChild(caption);
    historyList.appendChild(li);
  }
}

function renderRemoteVideos(videos) {
  remoteList.innerHTML = '';

  if (!videos.length) {
    remoteEmpty.style.display = 'block';
    return;
  }

  remoteEmpty.style.display = 'none';

  for (const video of videos) {
    const li = document.createElement('li');
    li.className = 'remote-entry';

    const meta = document.createElement('div');
    meta.className = 'remote-entry__meta';

    const title = document.createElement('p');
    title.className = 'remote-entry__prompt';
    title.textContent = video.prompt || '(no prompt found)';

    const details = document.createElement('span');
    details.className = 'remote-entry__time';
    const infoParts = [formatTimestamp(video.createdAt), formatModel(video.model), video.status];
    if (video.duration) infoParts.push(`${video.duration}s`);
    if (video.aspect_ratio) infoParts.push(video.aspect_ratio);
    details.textContent = infoParts.filter(Boolean).join(' • ');

    meta.appendChild(title);
    meta.appendChild(details);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.remoteDownload = 'true';
    button.dataset.videoId = video.id;
    button.dataset.downloaded = String(Boolean(video.downloaded));
    if (video.localUrl) {
      button.dataset.localUrl = video.localUrl;
    }

    if (video.downloaded && video.localUrl) {
      button.textContent = 'Open Local Copy';
    } else {
      button.textContent = 'Download to Server';
    }

    li.appendChild(meta);
    li.appendChild(button);
    remoteList.appendChild(li);
  }
}

async function refreshReferences({ silent = false } = {}) {
  if (!referencesList) return;

  try {
    if (!silent && referencesStatus) {
      referencesStatus.textContent = 'Loading saved references…';
      referencesStatus.classList.remove('status--error', 'status--success');
    }

    const response = await fetch(REFERENCES_ENDPOINT, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Failed to load references (status ${response.status}).`);
    }

    const payload = await response.json();
    const references = Array.isArray(payload?.references) ? payload.references : [];
    renderReferences(references);

    if (!silent && referencesStatus) {
      referencesStatus.classList.remove('status--error', 'status--success');
      if (references.length) {
        referencesStatus.textContent = 'Saved references ready.';
        referencesStatus.classList.add('status', 'status--success');
      } else {
        referencesStatus.textContent = '';
      }
    }
  } catch (error) {
    console.error(error);
    if (!silent && referencesStatus) {
      referencesStatus.textContent = error.message || 'Unable to load saved references.';
      referencesStatus.classList.add('status', 'status--error');
    }
    renderReferences([]);
  }
}

function renderReferences(references) {
  if (!referencesList) return;

  referencesList.innerHTML = '';

  if (!references.length) {
    if (referencesEmpty) referencesEmpty.style.display = 'block';
    updateReferenceSelectionUI();
    return;
  }

  if (referencesEmpty) referencesEmpty.style.display = 'none';

  for (const reference of references) {
    const li = document.createElement('li');
    li.className = 'reference-thumb';

    if (reference?.url === selectedReferenceUrl) {
      li.classList.add('reference-thumb--selected');
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reference-thumb__button';
    button.dataset.referenceUrl = reference?.url;

    const img = document.createElement('img');
    img.className = 'reference-thumb__image';
    img.src = reference?.url;
    img.alt = reference?.fileName || 'Saved reference';

    button.appendChild(img);
    li.appendChild(button);
    referencesList.appendChild(li);
  }

  updateReferenceSelectionUI();
}

function updateReferenceSelectionUI() {
  if (!referencesList) return;
  const items = referencesList.querySelectorAll('.reference-thumb');
  items.forEach((item) => {
    const button = item.querySelector('[data-reference-url]');
    const url = button?.getAttribute('data-reference-url');
    if (url && url === selectedReferenceUrl) {
      item.classList.add('reference-thumb--selected');
    } else {
      item.classList.remove('reference-thumb--selected');
    }
  });
}

function selectReference(url) {
  const normalized = typeof url === 'string' ? url.trim() : '';
  if (!normalized || normalized === selectedReferenceUrl) {
    clearReferenceSelection();
    return;
  }

  selectedReferenceUrl = normalized;
  if (referenceUrlInput) {
    referenceUrlInput.value = normalized;
  }
  if (referenceInput) {
    referenceInput.value = '';
  }
  capturedBlob = null;
  updateReferenceSelectionUI();
  stopCamera();
  resetCapturedFrame();
  renderStatus('Selected saved reference image.', 'success');
}

function clearReferenceSelection() {
  selectedReferenceUrl = '';
  if (referenceUrlInput) {
    referenceUrlInput.value = '';
  }
  updateReferenceSelectionUI();
}

function attachThumbnailPreview(button, videoElement) {
  const tryPlay = () => {
    videoElement.currentTime = 0;
    const playPromise = videoElement.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {});
    }
  };

  const reset = () => {
    videoElement.pause();
    videoElement.currentTime = 0;
  };

  button.addEventListener('mouseenter', tryPlay);
  button.addEventListener('focus', tryPlay);
  button.addEventListener('mouseleave', reset);
  button.addEventListener('blur', reset);
}

function setRemoteStatus(message, type) {
  remoteStatus.textContent = message;
  remoteStatus.classList.remove('status--error', 'status--success');

  if (type === 'error') {
    remoteStatus.classList.add('status', 'status--error');
  } else if (type === 'success') {
    remoteStatus.classList.add('status', 'status--success');
  }
}

function openFullVideo(url) {
  if (!fullVideoModal || !fullVideoPlayer || !url) return;

  fullVideoPlayer.src = url;
  fullVideoPlayer.load();

  fullVideoModal.classList.add('video-modal--open');
  fullVideoModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  const playPromise = fullVideoPlayer.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {});
  }
}

function closeFullVideo() {
  if (!fullVideoModal || !fullVideoPlayer) return;
  fullVideoPlayer.pause();
  fullVideoPlayer.removeAttribute('src');
  fullVideoPlayer.load();

  fullVideoModal.classList.remove('video-modal--open');
  fullVideoModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

if (modalCloseButton) {
  modalCloseButton.addEventListener('click', closeFullVideo);
}

if (fullVideoModal) {
  fullVideoModal.addEventListener('click', (event) => {
    if (event.target && event.target.dataset && event.target.dataset.modalClose !== undefined) {
      closeFullVideo();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && fullVideoModal?.classList.contains('video-modal--open')) {
    closeFullVideo();
  }
});

window.addEventListener('beforeunload', () => {
  if (cameraStream) {
    stopCamera();
  }
});

async function startCamera() {
  if (!cameraPreview || !navigator.mediaDevices?.getUserMedia) {
    renderStatus('Camera access is not supported in this browser.', 'error');
    return;
  }

  try {
    if (openCameraButton) {
      openCameraButton.disabled = true;
    }
    resetCapturedFrame();
    clearReferenceSelection();
    if (referenceUrlInput) {
      referenceUrlInput.value = '';
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    cameraVideoElement = document.createElement('video');
    cameraVideoElement.srcObject = cameraStream;
    cameraVideoElement.playsInline = true;
    cameraVideoElement.muted = true;
    await cameraVideoElement.play();

    const trackSettings = cameraStream.getVideoTracks()[0]?.getSettings() || {};
    const width = trackSettings.width || 640;
    const height = trackSettings.height || 360;
    cameraPreview.width = width;
    cameraPreview.height = height;
    cameraPreview.hidden = false;

    if (cameraActions) {
      cameraActions.hidden = false;
    }
    if (openCameraButton) {
      openCameraButton.hidden = true;
    }
    if (captureFrameButton) captureFrameButton.disabled = false;
    if (closeCameraButton) closeCameraButton.disabled = false;

    const ctx = cameraPreview.getContext('2d');
    const drawFrame = () => {
      if (!cameraStream || !ctx) return;
      ctx.drawImage(cameraVideoElement, 0, 0, cameraPreview.width, cameraPreview.height);
      cameraFrameRequest = requestAnimationFrame(drawFrame);
    };
    drawFrame();

    renderStatus('Camera ready. Capture a frame when ready.', 'success');
  } catch (error) {
    console.error('Camera start failed', error);
    renderStatus(error.message || 'Unable to access the camera.', 'error');
    stopCamera();
  }
}

function captureCameraFrame() {
  if (!cameraPreview || cameraPreview.hidden) {
    renderStatus('Start the camera before capturing a frame.', 'error');
    return;
  }

  cameraPreview.toBlob(
    (blob) => {
      if (blob) {
        capturedBlob = blob;
        renderStatus('Captured camera frame for video generation.', 'success');
        if (captureFrameButton) {
          captureFrameButton.textContent = 'Frame Captured';
          captureFrameButton.disabled = true;
        }
        clearReferenceSelection();
        if (referenceUrlInput) {
          referenceUrlInput.value = '';
        }
        stopCamera({ keepFrame: true });
      } else {
        renderStatus('Failed to capture frame.', 'error');
      }
    },
    'image/png',
    0.95
  );
}

function stopCamera({ keepFrame = false } = {}) {
  if (cameraFrameRequest !== null) {
    cancelAnimationFrame(cameraFrameRequest);
    cameraFrameRequest = null;
  }

  if (cameraVideoElement) {
    cameraVideoElement.pause();
    cameraVideoElement.srcObject = null;
    cameraVideoElement = null;
  }

  if (cameraStream) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
    cameraStream = null;
  }

  if (cameraPreview) {
    const ctx = cameraPreview.getContext('2d');
    if (!keepFrame && ctx) {
      ctx.clearRect(0, 0, cameraPreview.width, cameraPreview.height);
    }
    cameraPreview.hidden = keepFrame ? false : true;
  }

  if (cameraActions) {
    cameraActions.hidden = true;
  }

  if (openCameraButton) {
    openCameraButton.hidden = false;
    openCameraButton.disabled = false;
  }
}

function resetCapturedFrame() {
  capturedBlob = null;
  if (captureFrameButton) {
    captureFrameButton.textContent = 'Capture Frame';
    captureFrameButton.disabled = false;
  }
  if (cameraPreview) {
    const ctx = cameraPreview.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, cameraPreview.width, cameraPreview.height);
    }
    cameraPreview.hidden = true;
  }
}

function formatModel(model) {
  if (!model) return '';
  const normalized = model.toLowerCase();
  if (normalized === 'sora-2' || normalized.startsWith('sora-2')) return 'Sora v2';
  if (normalized === 'veo-3' || normalized.startsWith('veo-3')) return 'Veo 3';
  return model;
}

function formatTimestamp(isoString) {
  if (!isoString) return '';

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}
