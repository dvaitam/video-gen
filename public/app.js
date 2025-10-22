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

const LOCAL_STORAGE_KEY = 'sora2-openai-api-key';
const MODEL_STORAGE_KEY = 'sora2-video-model';
const API_ENDPOINT = '/api/generate';
const HISTORY_ENDPOINT = '/api/videos';
const REMOTE_LIST_ENDPOINT = '/api/videos/remote/list';
const REMOTE_DOWNLOAD_ENDPOINT = '/api/videos/remote/download';

(() => {
  const storedKey = window.localStorage.getItem(LOCAL_STORAGE_KEY);
  if (storedKey) {
    apiKeyInput.value = storedKey;
    rememberKeyCheckbox.checked = true;
  }

  const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
  if (storedModel) {
    modelInput.value = storedModel;
  }
})();

refreshHistory();

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
    window.localStorage.setItem(LOCAL_STORAGE_KEY, apiKey);
  } else if (!rememberKeyCheckbox.checked) {
    window.localStorage.removeItem(LOCAL_STORAGE_KEY);
  }

  let pendingStatusTimer;

  try {
    pendingStatusTimer = setInterval(() => {
      renderStatus('Still waiting for the video to finish rendering…');
    }, 5000);

    const result = await generateVideo({ apiKey });
    const videoUrl = result?.videoUrl;
    const modelName = formatModel(result?.model);

    if (!videoUrl) {
      throw new Error('The server response did not contain a video URL.');
    }

    renderStatus(modelName ? `Video ready from ${modelName}!` : 'Video ready!', 'success');
    showVideo(videoUrl);
    await refreshHistory();
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

  if (referenceInput.files?.length) {
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
    loadRemoteButton.disabled = false;
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
    li.className = 'history-entry';

    const meta = document.createElement('div');
    meta.className = 'history-entry__meta';

    const prompt = document.createElement('p');
    prompt.className = 'history-entry__prompt';
    prompt.textContent = video.prompt || '(no prompt provided)';

    const time = document.createElement('span');
    time.className = 'history-entry__time';
    const historyDetails = [formatTimestamp(video.createdAt), formatModel(video.model)];
    time.textContent = historyDetails.filter(Boolean).join(' • ');

    meta.appendChild(prompt);
    meta.appendChild(time);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.historyPlay = 'true';
    button.dataset.url = video.url;
    button.textContent = 'Play';

    li.appendChild(meta);
    li.appendChild(button);
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

function setRemoteStatus(message, type) {
  remoteStatus.textContent = message;
  remoteStatus.classList.remove('status--error', 'status--success');

  if (type === 'error') {
    remoteStatus.classList.add('status', 'status--error');
  } else if (type === 'success') {
    remoteStatus.classList.add('status', 'status--success');
  }
}

function formatModel(model) {
  if (!model) return '';
  const normalized = model.toLowerCase();
  if (normalized === 'sora-2') return 'Sora v2';
  if (normalized === 'veo-3') return 'Veo 3';
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
