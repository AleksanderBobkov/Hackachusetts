// People and their photos/videos live on the companion device (backend /profiles API).
// A 2xx response means the change is on disk, so "Saved" is true. Every screen sees the same
// library, and it survives browser data clearing and kiosk reboots (the kiosk wipes its
// browser profile each boot). Transcripts and conversations are never stored.

export const limits = { imageBytes: 12 * 1024 ** 2, videoBytes: 50 * 1024 ** 2, items: 50, totalBytes: 200 * 1024 ** 2 };

export const OFFLINE_MESSAGE = 'Cannot connect to the companion right now. Try again.';

export class StoreError extends Error {
  constructor(message, status) { super(message); this.name = 'StoreError'; this.status = status; }
}

/** Random ID. Also works without a secure context (plain-http setup from a laptop). */
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hash32(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Same file for the same person → same key, so retries and repeats never duplicate it. */
export function uploadKey(personId, file) {
  const text = [personId, file.name, file.size, file.lastModified].join('\u0000');
  return `upload-${hash32(text, 2166136261)}${hash32(text, 2654435761)}`;
}

function serverMessage(data) {
  const detail = data?.detail ?? data?.error;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) return String(detail[0]?.msg || '').replace(/^Value error, /, '');
  return '';
}

async function request(path, { method = 'GET', json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
  else if (body !== undefined) init.body = body;
  let response;
  try { response = await fetch(path, init); } catch { throw new StoreError(OFFLINE_MESSAGE, 0); }
  let data = null;
  try { data = await response.json(); } catch { /* empty or non-JSON body */ }
  if (!response.ok) {
    // 4xx details are written as user-facing copy; 5xx details are not.
    const message = response.status < 500 ? serverMessage(data) : '';
    throw new StoreError(message || 'Something went wrong. Please try again.', response.status);
  }
  return data;
}

const segment = value => encodeURIComponent(String(value));
const toMedia = (personId, item) => ({
  id: item.photo_id, personId, name: item.name, type: item.type === 'video' ? 'video' : 'image',
  size: Number(item.bytes) || 0, display: item.url, url: item.url,
});
const toPerson = profile => ({
  id: profile.profile_id, name: profile.display_name, created: Math.round((Number(profile.created_at) || 0) * 1000),
  example: profile.example === true, media: (profile.media || profile.photos || []).map(item => toMedia(profile.profile_id, item)),
});

export async function openStore() {
  const list = async () => ((await request('/profiles'))?.profiles || []).map(toPerson);
  await list(); // fail early so the screen can explain that the companion isn't answering
  return {
    people: list,
    async activePerson() {
      const profile = (await request('/profiles/active'))?.profile;
      return profile ? toPerson(profile) : null;
    },
    async activatePerson(personId) {
      return toPerson(await request(`/profiles/${segment(personId)}/activate`, { method: 'POST', json: { mode: 'translate' } }));
    },
    /** Create (no id) or rename (id). Resolves with the saved person, using the server's ID. */
    async savePerson(person, { key } = {}) {
      if (person.id) return toPerson(await request(`/profiles/${segment(person.id)}`, { method: 'PUT', json: { display_name: person.name } }));
      const headers = key ? { 'Idempotency-Key': key } : {};
      return toPerson(await request('/profiles', { method: 'POST', json: { display_name: person.name, example: person.example === true }, headers }));
    },
    async media(personId) { return (await list()).find(p => p.id === personId)?.media ?? []; },
    async allMedia() { return (await list()).flatMap(p => p.media); },
    /** Upload a prepared item. Resolves with the stored item (server ID and URL). */
    async saveMedia(media, { key } = {}) {
      const headers = { 'Content-Type': media.upload.type || 'application/octet-stream', ...(key ? { 'Idempotency-Key': key } : {}) };
      const stored = await request(`/profiles/${segment(media.personId)}/photos?filename=${encodeURIComponent(media.name)}`, { method: 'POST', body: media.upload, headers });
      return toMedia(media.personId, stored);
    },
    /** Remove an item. Resolves with an in-memory copy that saveMedia can restore (Undo). */
    async removeMedia(item) {
      let upload;
      try {
        const response = await fetch(item.url);
        if (!response.ok) throw new Error(String(response.status));
        upload = await response.blob();
      } catch { throw new StoreError('This file could not be removed. Please try again.', 0); }
      await request(`/profiles/${segment(item.personId)}/photos/${segment(item.id)}`, { method: 'DELETE' });
      return { ...item, upload, size: upload.size, restoreKey: newId() };
    },
  };
}

export async function prepareMedia(file, personId) {
  const video = ['video/mp4', 'video/webm'].includes(file.type);
  if (!video && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP, MP4, or WebM file.');
  if (file.size > (video ? limits.videoBytes : limits.imageBytes)) throw new Error(video ? 'Videos must be 50 MB or smaller.' : 'Photos must be 12 MB or smaller.');
  const url = URL.createObjectURL(file);
  try {
    const element = document.createElement(video ? 'video' : 'img');
    if (video) { element.preload = 'metadata'; element.muted = true; }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('This file could not be opened. Try another file.')), 15000);
      element[video ? 'onloadedmetadata' : 'onload'] = () => { clearTimeout(timer); resolve(); };
      element.onerror = () => { clearTimeout(timer); reject(new Error('This file cannot be decoded on this device.')); };
      element.src = url;
    });
    const width = video ? element.videoWidth : element.naturalWidth;
    const height = video ? element.videoHeight : element.naturalHeight;
    if (!width || !height || width * height > 24000000) throw new Error('Choose media up to 24 megapixels.');
    if (video && (!Number.isFinite(element.duration) || element.duration > 60)) throw new Error('Choose a video of 60 seconds or less.');
    if (video && (width > 1920 || height > 1080)) throw new Error('Choose a video up to 1920 × 1080.');
    // Only the display copy is uploaded for photos (longest side 1600 px); videos as chosen.
    const result = { id: newId(), personId, name: file.name, type: video ? 'video' : 'image', created: Date.now(), key: uploadKey(personId, file) };
    if (video) { result.upload = file; element.removeAttribute('src'); element.load(); }
    else {
      const scale = Math.min(1, 1600 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(element, 0, 0, canvas.width, canvas.height);
      result.upload = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
      if (!result.upload) throw new Error('Could not prepare this photo. Try again.');
    }
    result.display = result.upload;
    result.size = result.upload.size;
    return result;
  } finally { URL.revokeObjectURL(url); }
}
