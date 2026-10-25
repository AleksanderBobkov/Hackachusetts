import { TurnBoundary } from './routing.js';
// Backend contract: docs/architecture.md §6 "Speech adapter". Every operation belongs to one turn.
export class SpeechSession {
  constructor(onState, onResult, onError) {
    this.onState = onState; this.onResult = onResult; this.onError = onError;
    this.epoch = 0; this.volume = .8; this.state = 'ready';
    this.serverVoice = false; // the device service reads words aloud (POST /api/speak)
    this.audio = null; this.audioUrl = null; this.ttsController = null;
  }
  setState(state) { this.state = state; this.onState(state); }
  cancel() {
    ++this.epoch;
    clearTimeout(this.timeout); clearTimeout(this.captureTimeout);
    this.stopMeter();
    this.playbackDone?.(false); this.playbackDone = null;
    this.controller?.abort();
    this.ttsController?.abort(); this.ttsController = null;
    this.releaseAudio();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    globalThis.speechSynthesis?.cancel();
    this.setState('ready');
  }
  /** Change the volume. Returns true when it also applied to audio that is playing now. */
  setVolume(value) {
    this.volume = value;
    if (!this.audio) return false;
    this.audio.volume = value;
    return true;
  }
  releaseAudio() {
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onplaying = audio.onended = audio.onerror = null;
      try { audio.pause(); audio.removeAttribute?.('src'); audio.load?.(); } catch { /* already stopped */ }
    }
    if (this.audioUrl) { URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; }
  }
  stopMeter() {
    clearInterval(this.meterTimer);
    this.audioContext?.close().catch(()=>{}); this.audioContext = null;
  }
  async start(meta, automatic = false) {
    if (this.state !== 'ready') return;
    this.cancel();
    const epoch = this.epoch;
    this.setState('permission');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('Microphone capture is unavailable. Open this app on localhost or HTTPS, or type your message.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      this.recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      this.recorder.onerror = () => {
        if (epoch !== this.epoch) return;
        this.cancel(); this.onError('Recording stopped unexpectedly. Please try again.');
      };
      this.recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop()); clearTimeout(this.captureTimeout); this.stopMeter();
        if (epoch !== this.epoch) return;
        const data = new FormData();
        data.append('audio', new Blob(chunks, { type: this.recorder.mimeType }), 'turn.webm');
        data.append('metadata', JSON.stringify(meta));
        this.request(data, meta, epoch);
      };
      this.recorder.start(); this.setState('listening');
      if (automatic) {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) throw new Error('Automatic pauses are unavailable on this device. Use talk buttons in Conversation options.');
        const context = new Context(); this.audioContext = context;
        await context.resume();
        if (epoch !== this.epoch) { context.close().catch(()=>{}); return; }
        const analyser = context.createAnalyser(); analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const boundary = new TurnBoundary(performance.now());
        this.meterTimer = setInterval(()=>{
          if(epoch !== this.epoch) return;
          analyser.getFloatTimeDomainData(samples);
          const level = Math.sqrt(samples.reduce((sum, value)=>sum+value*value,0)/samples.length);
          const decision = boundary.sample(level,performance.now());
          if(decision === 'finish') { this.stopMeter(); this.finish(); }
          if(decision === 'no-speech') { this.cancel(); this.onError('I didn’t catch any speech. Tap Start conversation when you’re ready.'); }
        }, 100);
      }
      this.captureTimeout = setTimeout(() => this.finish(), 60000);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.cancel();
      this.onError(error.name === 'NotAllowedError' ? 'Microphone permission was declined. Allow access in your browser, or type your message.' : error.name === 'NotFoundError' ? 'No microphone was found. Connect one, or type your message.' : error.message);
    }
  }
  finish() { if (this.recorder?.state === 'recording') this.recorder.stop(); }
  async typed(text, meta) {
    this.cancel();
    const data = new FormData(); data.append('text', text); data.append('metadata', JSON.stringify(meta));
    await this.request(data, meta, this.epoch);
  }
  async request(body, meta, epoch) {
    this.setState(meta.stage === 'detect' ? 'transcribing' : 'processing'); this.controller = new AbortController();
    const controller = this.controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    this.timeout = timeout;
    try {
      const response = await fetch('/api/turn', { method: 'POST', body, signal: this.controller.signal });
      const result = await response.json();
      if (epoch !== this.epoch) return;
      if (!response.ok) {
        if (result.turn_id === meta.turn_id && result.person_id === meta.person_id && typeof result.transcript === 'string') this.onResult({ ...meta, stage:'partial', transcript: result.transcript, translation: null, example: false });
        throw new Error(result.error || 'Translation could not be completed. Please try again.');
      }
      if (result.turn_id !== meta.turn_id || result.person_id !== meta.person_id) throw new Error('The response did not match this conversation. Please try again.');
      if(meta.stage === 'detect') {
        if(typeof result.transcript !== 'string' || !result.transcript.trim()) throw new Error('I didn’t catch that. Please try again.');
        this.setState('ready');
        this.onResult({...meta, transcript:result.transcript, detected_language:typeof result.detected_language === 'string'?result.detected_language:null, detection_certain:result.detection_certain === true, simulated:result.simulated === true, translation:null, example:false});
        return;
      }
      if (typeof result.transcript !== 'string' || typeof result.translation !== 'string' || !result.translation.trim()) throw new Error('No translation was returned. Please try again.');
      if(meta.stage === 'translate' && result.target_language !== meta.target_language) throw new Error('The response used a different output language. Please try again.');
      this.setState('ready'); this.onResult({ ...meta, ...result, example: false });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.setState('ready'); this.onError(error.name === 'AbortError' ? 'Translation took too long. Please try again.' : error.message);
    } finally { clearTimeout(timeout); }
  }
  browserVoice(lang) {
    return globalThis.speechSynthesis?.getVoices().find(v => v.lang.toLowerCase().split('-')[0] === lang.toLowerCase().split('-')[0]);
  }
  async speak(text, lang) {
    this.cancel();
    return this.serverVoice ? this.speakFromService(text, lang) : this.speakWithBrowser(text, lang);
  }
  // The device service makes the audio; the page plays it, so Pause stops it at once and the
  // volume control applies. Falls back to an installed browser voice for the same language.
  async speakFromService(text, lang) {
    const epoch = this.epoch;
    this.setState('preparing');
    const controller = new AbortController(); this.ttsController = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    let blob;
    try {
      const response = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language: lang }), signal: controller.signal });
      if (epoch !== this.epoch) return false;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Audio could not play. You can still read the words on screen.');
      }
      blob = await response.blob();
    } catch (error) {
      if (epoch !== this.epoch) return false;
      this.ttsController = null; this.setState('ready');
      if (this.browserVoice(lang)) return this.speakWithBrowser(text, lang);
      this.onError(error.name === 'AbortError' ? 'Audio took too long. You can still read the words on screen.' : error.message);
      return false;
    } finally { clearTimeout(timer); }
    if (epoch !== this.epoch) return false;
    this.ttsController = null;
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio; this.audioUrl = url;
      audio.volume = this.volume;
      this.playbackDone = resolve;
      const settle = played => {
        if (epoch !== this.epoch) return;
        this.playbackDone = null; this.releaseAudio(); this.setState('ready'); resolve(played);
      };
      audio.onplaying = () => { if (epoch === this.epoch) this.setState('speaking'); };
      audio.onended = () => settle(true);
      audio.onerror = () => { if (epoch !== this.epoch) return; settle(false); this.onError('Audio could not play. You can still read the words on screen.'); };
      Promise.resolve(audio.play()).catch(() => { if (epoch !== this.epoch) return; settle(false); this.onError('Audio could not play. Tap Read again to listen.'); });
    });
  }
  speakWithBrowser(text, lang) {
    this.cancel();
    const epoch = this.epoch;
    const voice = this.browserVoice(lang);
    if (!voice) { this.onError('A voice for this language is not installed on this device. The words are still available to read.'); return false; }
    return new Promise(resolve=>{
    this.playbackDone = resolve;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice; utterance.lang = voice.lang; utterance.volume = this.volume; utterance.rate = .9;
    utterance.onstart = () => { if (epoch === this.epoch) this.setState('speaking'); };
    utterance.onend = () => { if (epoch === this.epoch) { this.playbackDone=null;this.setState('ready');resolve(true); } };
    utterance.onerror = () => { if (epoch === this.epoch) { this.playbackDone=null;this.setState('ready');resolve(false);this.onError('Audio could not play. You can still read the words on screen.'); } };
    this.setState('speaking'); speechSynthesis.speak(utterance);
    });
  }
}
