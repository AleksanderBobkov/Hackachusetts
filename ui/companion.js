// Resident companion screen. Renders the backend's real state (architecture §6) and sends the
// same commands as the hardware buttons. The server is the source of truth: this file never
// shows Listening / Translated / Saved unless the backend said so.
//
// URL options:  ?mock=1      scripted demo stream (labelled "Demo replay" on screen)
//               &speed=2     mock playback speed
//               ?keys=1      laptop-only keyboard shortcuts (1, 2, space, m). Leave OFF on the
//                            Pi: the backend reads the same keys from /dev/input, so the browser
//                            would send every command twice.

import { CompanionSocket } from "./lib/socket.js";
import { request } from "./lib/api.js";
import { languageName, setLanguage } from "./lib/lang.js";

const params = new URLSearchParams(location.search);
const MOCK = params.get("mock") === "1";
const MOCK_SPEED = Number(params.get("speed")) > 0 ? Number(params.get("speed")) : 1; // 0 would flood a looping stream
const KEYS = params.get("keys") === "1";

const PROCESSING = new Set(["transcribing", "thinking", "translating"]);
const SLIDE_MS = 12000;      // time per photo when nothing is happening
const READING_MS = 30000;    // keep the photo still after new captions so they can be read
const PROFILE_POLL_MS = 5000;

const MODE_SPEAKERS = { translate: ["a", "b"], companion: ["resident"], contribute: ["contributor"] };

const $ = (id) => document.getElementById(id);
const el = {
  screen: $("screen"),
  name: $("person-name"),
  modeLine: $("mode-line"),
  replay: $("replay-note"),
  statusIcon: $("status-icon"),
  statusTitle: $("status-title"),
  statusHint: $("status-hint"),
  captions: $("captions"),
  captionEmpty: $("caption-empty"),
  captionTurn: $("caption-turn"),
  originalLabel: $("original-label"),
  originalText: $("original-text"),
  mainLabel: $("main-label"),
  mainText: $("main-text"),
  mainNote: $("main-note"),
  proposal: $("proposal"),
  proposalClaims: $("proposal-claims"),
  proposalUnknowns: $("proposal-unknowns"),
  proposalUnknownsWrap: $("proposal-unknowns-wrap"),
  img: $("photo-img"),
  photoEmpty: $("photo-empty"),
  photoControls: $("photo-controls"),
  photoPause: $("photo-pause"),
  photoNext: $("photo-next"),
  talkGroup: $("talk-group"),
  talkTemplate: $("talk-template"),
  mute: $("mute-btn"),
  muteIcon: $("mute-icon"),
};

const ui = {
  connected: false,
  everConnected: false,
  server: { state: "idle", mode: "companion", speaker: null, turn_id: null },
  lastError: null,          // {turn_id, code, message}
  feedback: null,           // short note shown in the hint line until the next state change
  config: { speakers: { a: { label: "Person A", lang: "" }, b: { label: "Person B", lang: "" } }, resident_lang: "" },
  profile: null,
  photos: [],
  photoIndex: 0,
  photoPaused: false,
  readingUntil: 0,
  profileLoaded: false,
  captionTurnId: null,
  renderedMode: null,
  talkButtons: new Map(),
};

// ------------------------------------------------------------------ socket

const socket = new CompanionSocket({
  query: MOCK ? `mock=1&loop=1&speed=${MOCK_SPEED}` : "",
  onConnection(connected) {
    ui.connected = connected;
    if (connected) {
      ui.everConnected = true;
      loadConfig();
      loadProfile();
    }
    render();
  },
  onEvent: handleEvent,
});

function send(command) {
  if (!socket.send(command)) {
    ui.feedback = "Cannot connect right now. Try again in a moment.";
    render();
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ events from the backend

function handleEvent(ev) {
  switch (ev.type) {
    case "state":
      onState(ev);
      break;
    case "transcript":
      if (ev.turn_id !== ui.server.turn_id && ui.server.turn_id !== null) return; // stale
      showOriginal(ev);
      break;
    case "translation":
      showMain({ label: `Translation · ${languageName(ev.target)}`, text: ev.text, lang: ev.target,
        note: ev.machine_translation ? "Machine translation. It may be imperfect." : "" });
      break;
    case "answer":
      showMain({ label: "Companion", text: ev.text, lang: ev.language,
        note: ev.claim_ids && ev.claim_ids.length ? "From the family notes." : "" });
      break;
    case "proposal":
      showProposal(ev);
      break;
    case "error":
      onError(ev);
      break;
    case "photo":
      showPhotoFromServer(ev);
      break;
    case "playback":
    default:
      break; // playback state is reflected by the `state` event (speaking → idle/muted)
  }
}

function onState(ev) {
  const prev = ui.server;
  ui.server = { state: ev.state, mode: ev.mode, speaker: ev.speaker ?? null, turn_id: ev.turn_id ?? null };
  if (ev.state !== prev.state) ui.feedback = null;
  if (ev.state !== "error") ui.lastError = null;
  // A new turn is the next interaction: clear the previous exchange.
  if (ev.state === "listening" && ev.turn_id !== ui.captionTurnId) clearCaptions(ev.turn_id);
  if (ev.mode !== prev.mode) clearCaptions(null);
  render();
}

function onError(ev) {
  if (ev.turn_id === null || ev.turn_id === undefined) {
    // Command-level problem (not a failed turn): explain briefly, keep the current state.
    ui.feedback = ev.code === "invalid_command"
      ? "That button isn't used in this mode."
      : friendlyError(ev);
    render();
    return;
  }
  ui.lastError = { turn_id: ev.turn_id, code: ev.code, message: friendlyError(ev) };
  render();
}

function friendlyError(ev) {
  switch (ev.code) {
    case "network": return "Cannot connect right now.";
    case "mic": return "The microphone isn't working right now.";
    case "not_implemented": return "This isn't available yet.";
    case "stt_failed": return "I didn't catch that.";
    default: return ev.message || "Something went wrong.";
  }
}

// ------------------------------------------------------------------ captions

function clearCaptions(turnId) {
  ui.captionTurnId = turnId;
  el.captionTurn.hidden = true;
  el.proposal.hidden = true;
  el.captionEmpty.hidden = false;
  for (const node of [el.originalLabel, el.originalText, el.mainLabel, el.mainText, el.mainNote]) node.textContent = "";
  el.mainLabel.hidden = true;
  el.mainNote.hidden = true;
  el.captions.scrollTop = 0;
}

function revealTurn() {
  el.captionEmpty.hidden = true;
  el.captionTurn.hidden = false;
  ui.readingUntil = Date.now() + READING_MS;
}

function speakerLabel(speaker) {
  if (speaker === "resident") return "You said";
  if (speaker === "contributor") return "Story heard";
  const cfg = ui.config.speakers[speaker];
  return cfg ? `${cfg.label} said` : "Said";
}

function showOriginal(ev) {
  ui.captionTurnId = ev.turn_id;
  el.originalLabel.textContent = `${speakerLabel(ev.speaker)} · ${languageName(ev.language)}`;
  el.originalText.textContent = ev.text;
  setLanguage(el.originalText, ev.language);
  revealTurn();
}

function showMain({ label, text, lang, note }) {
  el.mainLabel.textContent = label;
  el.mainLabel.hidden = false;
  el.mainText.textContent = text;
  setLanguage(el.mainText, lang);
  el.mainNote.textContent = note;
  el.mainNote.hidden = !note;
  revealTurn();
  scrollCaptionsTo(el.mainLabel);
}

// The answer/translation is what the resident needs to read. On short screens, scroll the
// caption area so it starts at the top (the original slides up, still reachable by scrolling).
// The browser clamps scrollTop, so nothing moves when everything already fits.
function scrollCaptionsTo(node) {
  const box = el.captions;
  box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

function showProposal(ev) {
  el.proposalClaims.replaceChildren(...(ev.claims || []).map((claim) => {
    const li = document.createElement("li");
    li.textContent = claim.text || "";
    if (claim.needs_review) {
      const flag = document.createElement("span");
      flag.className = "needs-review";
      flag.textContent = "Needs a closer check";
      li.append(flag);
    }
    return li;
  }));
  const unknowns = ev.unknowns || [];
  el.proposalUnknowns.replaceChildren(...unknowns.map((u) => {
    const li = document.createElement("li");
    li.textContent = unknownLabel(u.field);
    return li;
  }));
  el.proposalUnknownsWrap.hidden = unknowns.length === 0;
  el.proposal.hidden = false;
  el.captionEmpty.hidden = true;
  scrollCaptionsTo(el.proposal);
  ui.readingUntil = Date.now() + READING_MS;
}

function unknownLabel(field) {
  if (field === "photo_year") return "The year of the photo";
  return String(field || "").replace(/_/g, " ");
}

// ------------------------------------------------------------------ status

function statusModel() {
  const { state, mode, speaker } = ui.server;
  if (!ui.connected) {
    return ui.everConnected
      ? { key: "disconnected", icon: "offline", title: "Cannot connect right now", hint: "Trying again automatically. Talk works again once connected." }
      : { key: "connecting", icon: "hourglass", title: "Connecting", hint: "Starting up. One moment." };
  }
  const who = ui.config.speakers[speaker];
  switch (state) {
    case "listening":
      if (mode === "translate" && who) {
        return { key: state, icon: "mic", title: `Listening to ${who.label} · ${languageName(who.lang)}`, hint: `Press ${who.label}'s Talk button again to finish.` };
      }
      return { key: state, icon: "mic", title: "Listening", hint: "Press Talk to finish." };
    case "transcribing":
    case "thinking":
    case "translating":
      if (mode === "translate") return { key: "processing", icon: "hourglass", title: "Getting the translation", hint: "One moment." };
      if (mode === "contribute") return { key: "processing", icon: "hourglass", title: "Preparing the story for review", hint: "One moment." };
      return { key: "processing", icon: "hourglass", title: "Getting your response", hint: "One moment." };
    case "speaking":
      return { key: state, icon: "speaker", title: "Speaking", hint: "Press Mute to stop." };
    case "muted":
      return { key: state, icon: "mic-off", title: "Microphone and sound are off", hint: "Press Mute to turn them back on." };
    case "error": {
      const message = ui.lastError ? ui.lastError.message : "Something went wrong.";
      const hint = /talk/i.test(message) ? "" : "Press Talk to try again.";
      return { key: state, icon: "alert", title: message, hint };
    }
    case "idle":
    default:
      return {
        key: "idle", icon: "ready", title: "Ready. Not recording.",
        hint: mode === "translate" ? "Press your Talk button to begin." : "Press Talk to begin.",
      };
  }
}

// ------------------------------------------------------------------ controls

function buildTalkButtons(mode) {
  ui.talkButtons.clear();
  const buttons = (MODE_SPEAKERS[mode] || ["resident"]).map((speaker) => {
    const node = el.talkTemplate.content.firstElementChild.cloneNode(true);
    const who = node.querySelector(".talk-who");
    if (mode === "translate") {
      const cfg = ui.config.speakers[speaker] || { label: speaker, lang: "" };
      who.textContent = cfg.lang ? `${cfg.label} · ${languageName(cfg.lang)}` : cfg.label;
      setLanguage(who, cfg.lang);
    } else if (mode === "contribute") {
      who.textContent = "Family story";
    }
    node.addEventListener("click", () => pressTalk(speaker));
    ui.talkButtons.set(speaker, node);
    return node;
  });
  el.talkGroup.replaceChildren(...buttons);
  ui.renderedMode = `${mode}|${JSON.stringify(ui.config.speakers)}`;
}

function pressTalk(speaker) {
  const { state } = ui.server;
  if (!ui.connected) {
    ui.feedback = "Talk works again once the connection is back.";
  } else if (state === "muted") {
    ui.feedback = "The microphone is off. Press Mute to turn it back on.";
  } else if (PROCESSING.has(state)) {
    ui.feedback = "Still working on the last one. One moment.";
  } else {
    send({ cmd: "start_turn", speaker });
    return;
  }
  render();
}

async function pressMute() {
  if (!ui.connected) {
    ui.feedback = "Cannot connect right now. Try again in a moment.";
    render();
    return;
  }
  if (ui.server.state === "muted") {
    // Unmute → Ready (never auto-records). The backend has no unmute command yet, so this
    // resets the session, which also clears translation history. See README "Known gaps".
    try {
      await request("/session/reset", { method: "POST" });
    } catch (err) {
      ui.feedback = err.message;
      render();
    }
    return;
  }
  send({ cmd: "stop_all" });
}

el.mute.addEventListener("click", pressMute);

// ------------------------------------------------------------------ photos / slideshow

function setPhotos(photos) {
  const currentId = ui.photos[ui.photoIndex]?.photo_id;
  ui.photos = photos;
  const keep = photos.findIndex((p) => p.photo_id === currentId);
  ui.photoIndex = keep >= 0 ? keep : 0;
  el.photoControls.hidden = photos.length <= 1;
  if (!photos.length) {
    el.img.hidden = true;
    el.img.removeAttribute("src");
    el.photoEmpty.hidden = false;
    return;
  }
  if (keep < 0) showPhoto(0);
}

function showPhoto(index, { notify = true } = {}) {
  if (!ui.photos.length) return;
  ui.photoIndex = ((index % ui.photos.length) + ui.photos.length) % ui.photos.length;
  const photo = ui.photos[ui.photoIndex];
  displayImage(photo.url, `Photo ${ui.photoIndex + 1} of ${ui.photos.length}`);
  if (notify && !MOCK) send({ cmd: "set_photo", photo_id: photo.photo_id });
}

function displayImage(url, alt) {
  // Decode off-screen first so the swap never shows a half-drawn image (Pi GPU is modest).
  const loader = new Image();
  loader.decoding = "async";
  loader.onload = () => {
    el.img.src = url;
    el.img.alt = alt;
    el.img.hidden = false;
    el.photoEmpty.hidden = true;
  };
  loader.onerror = () => {
    if (!ui.photos.length) {
      el.img.hidden = true;
      el.photoEmpty.hidden = false;
    }
  };
  loader.src = url;
}

function showPhotoFromServer(ev) {
  const index = ui.photos.findIndex((p) => p.photo_id === ev.photo_id);
  ui.readingUntil = Date.now() + READING_MS;
  if (index >= 0) showPhoto(index, { notify: false });
  else if (ev.url) displayImage(ev.url, "Photo");
}

function slideshowTick() {
  const quiet = ["idle", "muted", "error"].includes(ui.server.state);
  if (ui.photos.length > 1 && !ui.photoPaused && quiet && Date.now() > ui.readingUntil) {
    showPhoto(ui.photoIndex + 1);
  }
}

el.photoPause.addEventListener("click", () => {
  ui.photoPaused = !ui.photoPaused;
  el.photoPause.setAttribute("aria-pressed", String(ui.photoPaused));
  el.photoPause.querySelector("use").setAttribute("href", `/ui/icons.svg#${ui.photoPaused ? "play" : "pause"}`);
});
el.photoNext.addEventListener("click", () => showPhoto(ui.photoIndex + 1));

// ------------------------------------------------------------------ data

async function loadConfig() {
  try {
    const cfg = await request("/config");
    if (cfg && cfg.speakers) ui.config = cfg;
    render();
  } catch {
    /* keep defaults; the socket status already shows connection problems */
  }
}

let profileSignature = "";
async function loadProfile() {
  let data;
  try {
    data = await request("/profiles/active");
  } catch {
    return;
  }
  const profile = data ? data.profile : null;
  const firstLoad = !ui.profileLoaded;
  ui.profileLoaded = true;
  const signature = JSON.stringify(profile);
  if (signature === profileSignature && !firstLoad) return;
  const switched = (profile && profile.profile_id) !== (ui.profile && ui.profile.profile_id);
  profileSignature = signature;
  ui.profile = profile;
  if (switched) {
    clearCaptions(null);
    ui.photoIndex = 0;
    ui.photos = [];
  }
  setPhotos(profile ? profile.photos : []);
  render();
}

// ------------------------------------------------------------------ render

function modeLine(mode) {
  if (mode === "translate") {
    const a = ui.config.speakers.a;
    const b = ui.config.speakers.b;
    if (a && b) return `Translation · ${languageName(a.lang)} and ${languageName(b.lang)}`;
    return "Translation";
  }
  if (mode === "contribute") return "Family story";
  return "Companion";
}

function render() {
  const { state, mode, speaker } = ui.server;
  const status = statusModel();

  el.screen.dataset.state = status.key;
  el.statusIcon.setAttribute("href", `/ui/icons.svg#${status.icon}`);
  el.statusTitle.textContent = status.title;
  el.statusHint.textContent = ui.feedback || status.hint;
  el.statusHint.hidden = !el.statusHint.textContent;

  if (ui.profile) {
    el.name.textContent = ui.profile.display_name;
    el.modeLine.textContent = modeLine(mode);
  } else if (ui.profileLoaded) {
    el.name.textContent = "No one selected yet";
    el.modeLine.textContent = `Add a person at ${location.host}/setup`;
  } else {
    el.name.textContent = "";      // first fetch still in flight; don't flash "no one"
    el.modeLine.textContent = modeLine(mode);
  }
  el.replay.hidden = !MOCK;
  document.title = ui.profile ? `Companion · ${ui.profile.display_name}` : "Companion";

  const modeKey = `${mode}|${JSON.stringify(ui.config.speakers)}`;
  if (ui.renderedMode !== modeKey) buildTalkButtons(mode);
  for (const [who, button] of ui.talkButtons) {
    const listening = ui.connected && state === "listening" && speaker === who;
    button.setAttribute("aria-pressed", String(listening));
    button.querySelector(".talk-label").textContent = listening ? "Finish" : "Talk";
    button.setAttribute("aria-disabled", String(!ui.connected));
  }

  const muted = ui.connected && state === "muted";
  el.mute.setAttribute("aria-pressed", String(muted));
  el.muteIcon.setAttribute("href", `/ui/icons.svg#${muted ? "mic" : "mic-off"}`);
  el.mute.setAttribute("aria-disabled", String(!ui.connected));
}

// ------------------------------------------------------------------ optional dev keys

if (KEYS) {
  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === " " && e.target instanceof HTMLButtonElement) return; // native click handles it
    const { mode } = ui.server;
    if (e.key === "1" && mode === "translate") pressTalk("a");
    else if (e.key === "2" && mode === "translate") pressTalk("b");
    else if (e.key === " " && mode !== "translate") { e.preventDefault(); pressTalk(MODE_SPEAKERS[mode][0]); }
    else if (e.key === "m" || e.key === "M") pressMute();
  });
}

// ------------------------------------------------------------------ start

render();
socket.connect();
setInterval(slideshowTick, SLIDE_MS);
setInterval(() => { if (ui.connected) loadProfile(); }, PROFILE_POLL_MS);
