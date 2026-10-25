// Language chooses an output destination, never a person's identity.
export const baseLanguage = value => typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
export function recipientFor(detected, preferences, certain = true) {
  const language = baseLanguage(detected);
  const resident = baseLanguage(preferences.resident);
  const visitor = baseLanguage(preferences.visitor);
  if (!certain || !language || resident === visitor) return null;
  if (language === resident) return 'visitor';
  if (language === visitor) return 'resident';
  return null;
}

// Deliberately tolerant starting point. Tune on the Pi and microphone.
export class TurnBoundary {
  constructor(started, silenceMs = 2200) {
    this.started = started; this.silenceMs = silenceMs; this.voicedMs = 0;
    this.lastSample = started; this.lastVoice = started;
  }
  sample(level, now) {
    const elapsed = Math.min(150, Math.max(0, now - this.lastSample));
    this.lastSample = now;
    if (level >= .015) { this.voicedMs += elapsed; this.lastVoice = now; }
    const heardSpeech = this.voicedMs >= 300;
    if (heardSpeech && now - this.lastVoice >= this.silenceMs) return 'finish';
    if (!heardSpeech && now - this.started >= 15000) return 'no-speech';
    return 'listen';
  }
}
