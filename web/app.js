const recordButton = document.querySelector('#recordButton');
const buttonText = document.querySelector('#buttonText');
const hint = document.querySelector('#recordingHint');
const connection = document.querySelector('#connection');
const results = document.querySelector('#results');
const clearButton = document.querySelector('#clearButton');
const speakButton = document.querySelector('#speakButton');
const voiceDisclosure = document.querySelector('#voiceDisclosure');
const targetLanguage = document.querySelector('#targetLanguage');
let recording = false;
let busy = false;
let progressTimer = null;
let speechText = '';
let speechLanguage = 'English';

async function request(path, payload) {
  const response = await fetch(path, {
    method: path === '/api/status' ? 'GET' : 'POST',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

function setRecording(active) {
  recording = active;
  targetLanguage.disabled = active;
  recordButton.classList.toggle('recording', active);
  recordButton.setAttribute('aria-pressed', String(active));
  buttonText.textContent = active ? 'Tap to stop' : 'Tap to speak';
  hint.textContent = active ? 'Listening… speak clearly, then tap Stop.' : '';
}

function stopProgressUpdates() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function startProgressUpdates() {
  const labels = {
    saving: 'Saving audio…',
    transcribing: 'Transcribing speech…',
    translating: 'Translating…',
  };
  stopProgressUpdates();
  progressTimer = setInterval(async () => {
    try {
      const status = await request('/api/status');
      if (labels[status.status]) hint.textContent = labels[status.status];
    } catch (_) {
      // The main request reports an actionable error if the service is unavailable.
    }
  }, 500);
}

recordButton.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  recordButton.disabled = true;
  try {
    if (!recording) {
      results.hidden = true;
      clearButton.hidden = true;
      speakButton.hidden = true;
      voiceDisclosure.hidden = true;
      await request('/api/record', { target_language: targetLanguage.value });
      setRecording(true);
      connection.textContent = 'Microphone is listening';
    } else {
      hint.textContent = 'Saving audio…';
      startProgressUpdates();
      const result = await request('/api/stop');
      setRecording(false);
      document.querySelector('#originalLanguage').textContent = `YOU SAID — ${result.source_language}`;
      document.querySelector('#originalText').textContent = result.original;
      const originalPronunciation = document.querySelector('#originalPronunciation');
      originalPronunciation.textContent = result.original_romanization || '';
      originalPronunciation.hidden = !result.original_romanization;
      const translationCard = document.querySelector('#translationCard');
      translationCard.hidden = result.transcription_only;
      if (!result.transcription_only) {
        document.querySelector('#translatedLanguage').textContent = `TRANSLATION — ${result.target_language}`;
        document.querySelector('#translatedText').textContent = result.translation;
        const translationPronunciation = document.querySelector('#translationPronunciation');
        translationPronunciation.textContent = result.translation_romanization || '';
        translationPronunciation.hidden = !result.translation_romanization;
      }
      document.querySelector('#resultNote').textContent = result.is_mock
        ? 'Demo text — speech-to-text and translation will be connected next.'
        : result.transcription_only ? 'Transcribed by the device service.' : 'Transcribed and translated by the device service.';
      results.hidden = false;
      clearButton.hidden = false;
      speechText = result.transcription_only ? result.original : result.translation;
      speechLanguage = result.transcription_only ? result.source_language : result.target_language;
      speakButton.hidden = !speechText;
      voiceDisclosure.hidden = !speechText;
      if (speechText) {
        connection.textContent = 'Speaking aloud';
        await speakCurrentText(true);
      }
      hint.textContent = `Recording saved (${result.duration_seconds} seconds).`;
      connection.textContent = 'Ready for the next person';
    }
  } catch (error) {
    setRecording(false);
    hint.textContent = `Request problem: ${error.message}`;
    connection.textContent = 'Service needs attention';
  } finally {
    stopProgressUpdates();
    busy = false;
    recordButton.disabled = false;
  }
});

async function speakCurrentText(automatic = false) {
  if (!speechText) return;
  speakButton.disabled = true;
  hint.textContent = automatic ? 'Preparing spoken translation…' : 'Preparing audio…';
  try {
    await request('/api/speak', { text: speechText, language: speechLanguage });
    return true;
  } catch (error) {
    hint.textContent = `Speaker problem: ${error.message}`;
    return false;
  } finally {
    speakButton.disabled = false;
  }
}

speakButton.addEventListener('click', async () => {
  if (busy || !speechText) return;
  busy = true;
  await speakCurrentText();
  busy = false;
});

clearButton.addEventListener('click', async () => {
  try { await request('/api/clear'); } catch (_) { /* UI can still clear safely. */ }
  results.hidden = true;
  clearButton.hidden = true;
  speakButton.hidden = true;
  voiceDisclosure.hidden = true;
  speechText = '';
  hint.textContent = '';
  connection.textContent = 'Ready for the next person';
});

(async () => {
  try {
    const status = await request('/api/status');
    connection.textContent = status.status === 'recording' ? 'Microphone is listening' : 'Microphone ready';
    if (status.status === 'recording') setRecording(true);
  } catch (_) {
    connection.textContent = 'Cannot reach the local audio service';
  }
})();
