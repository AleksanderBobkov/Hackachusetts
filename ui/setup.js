// Setup screen: person → name → photos → start companion (design-system "Product scope").
// "Saved" / "Ready" appear only after the server confirms a durable write. Failures keep
// the draft and the photos that succeeded. Every operation is keyed to the person's stable ID.

import { request, newKey, OFFLINE_MESSAGE } from "./lib/api.js";
import { languageName } from "./lib/lang.js";

const MAX_EDGE = 1920;          // downsized on this device so the Pi never decodes huge photos
const JPEG_QUALITY = 0.88;
const KEEP_ORIGINAL_BYTES = 2.5 * 1024 * 1024;
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);

const $ = (id) => document.getElementById(id);
const el = {
  loadError: $("load-error"),
  loadErrorText: $("load-error-text"),
  loadRetry: $("load-retry"),
  peopleEmpty: $("people-empty"),
  personFieldset: $("person-fieldset"),
  personList: $("person-list"),
  addPerson: $("add-person"),
  nameGroup: $("name-group"),
  nameForm: $("name-form"),
  nameInput: $("name-input"),
  nameError: $("name-error"),
  nameErrorText: $("name-error-text"),
  nameSubmit: $("name-submit"),
  nameStatus: $("name-status"),
  photoGroup: $("photo-group"),
  photosEmpty: $("photos-empty"),
  photoList: $("photo-list"),
  photoInput: $("photo-input"),
  addPhotos: $("add-photos"),
  startGroup: $("start-group"),
  translatePair: $("translate-pair"),
  startBtn: $("start-btn"),
  startStatus: $("start-status"),
  dialog: $("confirm-dialog"),
  dialogTitle: $("confirm-title"),
  dialogBody: $("confirm-body"),
  dialogActions: $("confirm-actions"),
};

const state = {
  profiles: [],
  activeId: null,
  selectedId: null,     // null = adding a new person
  creating: false,
  savedName: "",
  createKey: newKey(),  // reused on retry so a double click never creates two people
  nameBusy: false,
  startBusy: false,
  uploads: new Map(),   // profile_id → [entry]; entries stay tied to the person who started them
  uploading: false,
};

// ------------------------------------------------------------------ helpers

const selectedProfile = () => state.profiles.find((p) => p.profile_id === state.selectedId) || null;
const nameDirty = () => el.nameInput.value.trim() !== state.savedName.trim() || (state.creating && el.nameInput.value.trim() !== "");

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/ui/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function button(label, { kind = "", iconName, onClick } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${kind}`.trim();
  if (iconName) b.append(icon(iconName));
  const span = document.createElement("span");
  span.textContent = label;
  b.append(span);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function setBusy(btn, busy, busyLabel, idleLabel) {
  // Keep a stable width so the layout doesn't jump while busy.
  if (busy) btn.style.minWidth = `${btn.offsetWidth}px`;
  else btn.style.minWidth = "";
  btn.disabled = busy;
  btn.setAttribute("aria-busy", String(busy));
  btn.textContent = busy ? busyLabel : idleLabel;
}

// ------------------------------------------------------------------ dialog

/** Modal for real decisions only. Resolves with the chosen action value (Escape → cancelValue). */
function decide({ title, body, actions, cancelValue }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    el.dialogTitle.textContent = title;
    el.dialogBody.textContent = body;
    el.dialogActions.replaceChildren(...actions.map((a) =>
      button(a.label, { kind: a.kind, onClick: () => el.dialog.close(a.value) })));
    const done = () => {
      el.dialog.removeEventListener("close", done);
      resolve(el.dialog.returnValue || cancelValue);
      el.dialog.returnValue = "";
      if (opener && opener.isConnected) opener.focus();
    };
    el.dialog.addEventListener("close", done);
    el.dialog.showModal();
    el.dialogActions.querySelector("button")?.focus();
  });
}

/** If the name has unsaved edits, ask Save / Discard / Stay. Returns true to continue. */
async function resolveUnsavedName() {
  if (!nameDirty()) return true;
  const choice = await decide({
    title: "Save changes to the name?",
    body: `The name "${el.nameInput.value.trim()}" hasn't been saved yet.`,
    actions: [
      { label: "Save changes", value: "save", kind: "btn-primary" },
      { label: "Discard changes", value: "discard" },
      { label: "Stay", value: "stay" },
    ],
    cancelValue: "stay",
  });
  if (choice === "stay") return false;
  if (choice === "discard") {
    el.nameInput.value = state.savedName;
    clearNameError();
    return true;
  }
  return saveName();
}

// ------------------------------------------------------------------ loading

async function loadProfiles() {
  try {
    const data = await request("/profiles");
    state.profiles = data.profiles;
    state.activeId = data.active_profile_id;
    el.loadError.hidden = true;
    return true;
  } catch (err) {
    el.loadErrorText.textContent = err.message || OFFLINE_MESSAGE;
    el.loadError.hidden = false;
    return false;
  }
}

async function loadConfig() {
  try {
    const cfg = await request("/config");
    const a = cfg.speakers && cfg.speakers.a;
    const b = cfg.speakers && cfg.speakers.b;
    if (a && b) {
      el.translatePair.textContent =
        `${a.label} (${languageName(a.lang)}) and ${b.label} (${languageName(b.lang)}) talk; each is translated for the other.`;
    }
  } catch {
    /* keep the generic description */
  }
}

async function init() {
  const ok = await loadProfiles();
  loadConfig();
  if (!ok) return;
  const initial = state.activeId || (state.profiles[0] && state.profiles[0].profile_id) || null;
  if (initial) selectPerson(initial, { force: true });
  else startNewPerson({ force: true });
}

el.loadRetry.addEventListener("click", init);

// ------------------------------------------------------------------ person list

function renderPeople() {
  el.peopleEmpty.hidden = state.profiles.length > 0;
  el.personFieldset.hidden = state.profiles.length === 0;
  el.personList.replaceChildren(...state.profiles.map((p) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "person";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "person";
    input.value = p.profile_id;
    input.checked = p.profile_id === state.selectedId;
    input.addEventListener("change", async () => {
      if (!(await selectPerson(p.profile_id))) renderPeople(); // stayed: restore the old selection
    });

    let thumb;
    if (p.photos.length) {
      thumb = document.createElement("img");
      thumb.className = "person-thumb";
      thumb.src = p.photos[0].url;
      thumb.alt = "";            // the name is the label; never invent who is pictured
      thumb.loading = "lazy";
    } else {
      thumb = document.createElement("span");
      thumb.className = "person-thumb person-thumb-empty";
      thumb.append(icon("photo"));
    }

    const body = document.createElement("span");
    body.className = "person-body";
    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = p.display_name;
    const meta = document.createElement("span");
    meta.className = "person-meta";
    meta.textContent = p.photos.length === 1 ? "1 photo" : `${p.photos.length} photos`;
    const selected = document.createElement("span");
    selected.className = "person-selected";
    selected.append(icon("check"), document.createTextNode("Selected"));
    body.append(name, meta, selected);
    if (p.active) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Active on companion";
      body.append(document.createElement("br"), badge);
    }
    label.append(input, thumb, body);
    li.append(label);
    return li;
  }));
}

async function selectPerson(profileId, { force = false } = {}) {
  if (!force && profileId === state.selectedId && !state.creating) return true;
  if (!force && !(await resolveUnsavedName())) return false;
  state.selectedId = profileId;
  state.creating = false;
  const profile = selectedProfile();
  state.savedName = profile ? profile.display_name : "";
  el.nameInput.value = state.savedName;
  clearNameError();
  el.nameStatus.textContent = "";
  el.startStatus.replaceChildren();
  renderAll();
  return true;
}

async function startNewPerson({ force = false } = {}) {
  if (!force && !(await resolveUnsavedName())) return;
  state.selectedId = null;
  state.creating = true;
  state.savedName = "";
  state.createKey = newKey();
  el.nameInput.value = "";
  clearNameError();
  el.nameStatus.textContent = "";
  el.startStatus.replaceChildren();
  renderAll();
  el.nameInput.focus();
}

el.addPerson.addEventListener("click", () => startNewPerson());

// ------------------------------------------------------------------ name

function showNameError(message) {
  el.nameErrorText.textContent = message;
  el.nameError.hidden = false;
  el.nameInput.setAttribute("aria-invalid", "true");
}

function clearNameError() {
  el.nameError.hidden = true;
  el.nameInput.removeAttribute("aria-invalid");
}

async function saveName() {
  if (state.nameBusy) return false;
  const name = el.nameInput.value.trim();
  if (!name) {
    showNameError("Enter a name to continue");
    el.nameInput.focus();
    el.nameInput.scrollIntoView({ block: "center" });
    return false;
  }
  clearNameError();
  const idleLabel = state.creating ? "Add person" : "Save changes";
  state.nameBusy = true;
  setBusy(el.nameSubmit, true, "Saving", idleLabel);
  el.nameStatus.className = "inline-status";
  el.nameStatus.textContent = "";
  try {
    let profile;
    if (state.creating) {
      profile = await request("/profiles", {
        method: "POST",
        json: { display_name: name },
        headers: { "Idempotency-Key": state.createKey },
        fallback: "This person couldn't be added. Try again.",
      });
      state.profiles.push(profile);
      state.creating = false;
      state.selectedId = profile.profile_id;
    } else {
      profile = await request(`/profiles/${encodeURIComponent(state.selectedId)}`, {
        method: "PUT",
        json: { display_name: name },
        fallback: "The name couldn't be saved. Try again.",
      });
      state.profiles = state.profiles.map((p) => (p.profile_id === profile.profile_id ? profile : p));
    }
    state.savedName = profile.display_name;
    el.nameInput.value = profile.display_name;
    el.nameStatus.className = "inline-status is-success";
    el.nameStatus.replaceChildren(icon("check"), document.createTextNode("Saved"));
    return true;
  } catch (err) {
    // Keep the draft; say what failed and how to recover.
    if (err.status === 422) showNameError(err.message);
    el.nameStatus.className = "inline-status is-error";
    el.nameStatus.textContent = err.status === 422 ? "" : `${err.message}`;
    return false;
  } finally {
    state.nameBusy = false;
    setBusy(el.nameSubmit, false, "", state.creating ? "Add person" : "Save changes");
    renderAll({ keepNameStatus: true });
  }
}

el.nameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  saveName();
});
el.nameInput.addEventListener("input", () => {
  if (!el.nameError.hidden && el.nameInput.value.trim()) clearNameError();
  if (el.nameStatus.classList.contains("is-success")) el.nameStatus.textContent = "";
});

// ------------------------------------------------------------------ photos

function entriesFor(profileId) {
  if (!state.uploads.has(profileId)) state.uploads.set(profileId, []);
  return state.uploads.get(profileId);
}

function addFiles(files) {
  const profileId = state.selectedId;
  if (!profileId) return;
  const list = entriesFor(profileId);
  for (const file of files) {
    list.push({
      key: newKey(),
      profileId,
      file,
      name: file.name || "Photo",
      status: "queued",
      error: "",
      preview: URL.createObjectURL(file),
    });
  }
  renderPhotos();
  pumpUploads();
}

async function prepareUpload(file) {
  if (!ACCEPTED.has(file.type)) throw new Error("This photo couldn't be added. Try a JPEG or PNG.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This photo couldn't be opened. Try a JPEG or PNG.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim();
  ctx.fillRect(0, 0, canvas.width, canvas.height);  // transparent PNGs get the cream background
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("This photo couldn't be prepared. Try again.");
  return blob;
}

async function pumpUploads() {
  if (state.uploading) return;
  state.uploading = true;
  try {
    for (;;) {
      const next = [...state.uploads.values()].flat().find((e) => e.status === "queued");
      if (!next) break;
      next.status = "adding";
      renderPhotos();
      try {
        const body = await prepareUpload(next.file);
        const photo = await request(
          `/profiles/${encodeURIComponent(next.profileId)}/photos?filename=${encodeURIComponent(next.name)}`,
          {
            method: "POST",
            body,
            headers: { "Content-Type": body.type || next.file.type, "Idempotency-Key": next.key },
            fallback: "This photo couldn't be added. Try again.",
          },
        );
        // Durable on the server: it now lives in the profile's photo list.
        const profile = state.profiles.find((p) => p.profile_id === next.profileId);
        if (profile && !profile.photos.some((p) => p.photo_id === photo.photo_id)) profile.photos.push(photo);
        dropEntry(next);
      } catch (err) {
        next.status = "failed";
        next.error = err.message || "This photo couldn't be added. Try again.";
      }
      renderAll({ keepNameStatus: true });
    }
  } finally {
    state.uploading = false;
  }
}

function dropEntry(entry) {
  const list = entriesFor(entry.profileId);
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  URL.revokeObjectURL(entry.preview);
}

async function removePhoto(profile, photo, index, trigger) {
  const choice = await decide({
    title: "Remove this photo?",
    body: `Photo ${index + 1} ("${photo.name}") will be removed from ${profile.display_name}'s photos.`,
    actions: [
      { label: "Remove photo", value: "remove", kind: "btn-destructive" },
      { label: "Keep photo", value: "keep" },
    ],
    cancelValue: "keep",
  });
  if (choice !== "remove") return;
  photo._status = "removing";
  photo._error = "";
  renderPhotos();
  try {
    await request(`/profiles/${encodeURIComponent(profile.profile_id)}/photos/${encodeURIComponent(photo.photo_id)}`, {
      method: "DELETE",
      fallback: "This photo couldn't be removed. Try again.",
    });
    profile.photos = profile.photos.filter((p) => p.photo_id !== photo.photo_id);
    renderAll({ keepNameStatus: true });
    el.addPhotos.focus();
  } catch (err) {
    photo._status = "";
    photo._error = err.message;
    renderPhotos();
    trigger?.isConnected && trigger.focus();
  }
}

function photoItem({ src, name, statusText, statusClass, statusIcon, error, actions, failed }) {
  const li = document.createElement("li");
  li.className = `photo-item${failed ? " is-failed" : ""}`;
  const img = document.createElement("img");
  img.className = "photo-preview";
  img.src = src;
  img.alt = name;
  img.loading = "lazy";
  img.decoding = "async";
  const title = document.createElement("p");
  title.className = "photo-name";
  title.textContent = name;
  const status = document.createElement("p");
  status.className = `photo-state ${statusClass}`;
  if (statusIcon) status.append(icon(statusIcon));
  status.append(document.createTextNode(statusText));
  li.append(img, title, status);
  if (error) {
    const msg = document.createElement("p");
    msg.className = "photo-state is-failed";
    msg.setAttribute("role", "alert");
    msg.append(icon("alert"), document.createTextNode(error));
    li.append(msg);
  }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "photo-actions";
    row.append(...actions);
    li.append(row);
  }
  return li;
}

function renderPhotos() {
  const profile = selectedProfile();
  if (!profile) {
    el.photoList.replaceChildren();
    return;
  }
  const items = profile.photos.map((photo, index) => {
    const removing = photo._status === "removing";
    const remove = button("Remove", { iconName: "trash", kind: "btn-destructive" });
    remove.setAttribute("aria-label", `Remove photo ${index + 1}, ${photo.name}`);
    remove.addEventListener("click", () => removePhoto(profile, photo, index, remove));
    if (removing) remove.disabled = true;
    return photoItem({
      src: photo.url,
      name: photo.name,
      statusText: removing ? "Removing" : "Ready",
      statusClass: removing ? "" : "is-ready",
      statusIcon: removing ? "" : "check",
      error: photo._error,
      actions: [remove],
    });
  });
  for (const entry of entriesFor(profile.profile_id)) {
    const labels = { queued: "Waiting to add", adding: "Adding", failed: "Couldn't be added" };
    const actions = [];
    if (entry.status === "failed") {
      actions.push(button("Try again", {
        iconName: "retry",
        onClick: () => { entry.status = "queued"; entry.error = ""; renderPhotos(); pumpUploads(); },
      }));
      const discard = button("Remove", { iconName: "trash", onClick: () => { dropEntry(entry); renderPhotos(); } });
      discard.setAttribute("aria-label", `Remove ${entry.name}`);
      actions.push(discard);
    }
    items.push(photoItem({
      src: entry.preview,
      name: entry.name,
      statusText: labels[entry.status] || "",
      statusClass: entry.status === "failed" ? "is-failed" : "",
      statusIcon: entry.status === "failed" ? "" : "hourglass",
      error: entry.error,
      actions,
      failed: entry.status === "failed",
    }));
  }
  el.photoList.replaceChildren(...items);
  el.photosEmpty.hidden = items.length > 0;
}

el.addPhotos.addEventListener("click", () => el.photoInput.click());
el.photoInput.addEventListener("change", () => {
  addFiles([...el.photoInput.files]);
  el.photoInput.value = "";
});

// Drag and drop is an enhancement only; "Add photos" is the primary path.
el.photoGroup.addEventListener("dragover", (e) => {
  if (!state.selectedId) return;
  e.preventDefault();
  el.photoGroup.classList.add("is-dropping");
});
el.photoGroup.addEventListener("dragleave", () => el.photoGroup.classList.remove("is-dropping"));
el.photoGroup.addEventListener("drop", (e) => {
  e.preventDefault();
  el.photoGroup.classList.remove("is-dropping");
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
});

// ------------------------------------------------------------------ start

async function startCompanion() {
  if (state.startBusy || !state.selectedId) return;
  if (!(await resolveUnsavedName())) return;
  const profile = selectedProfile();
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "companion";
  state.startBusy = true;
  setBusy(el.startBtn, true, "Starting", "Start companion");
  el.startStatus.replaceChildren();
  try {
    const updated = await request(`/profiles/${encodeURIComponent(profile.profile_id)}/activate`, {
      method: "POST",
      json: { mode },
      fallback: "The companion couldn't be started. Try again.",
    });
    state.activeId = updated.profile_id;
    state.profiles = state.profiles.map((p) => ({ ...p, active: p.profile_id === updated.profile_id }));
    el.startStatus.replaceChildren(message("success", "check",
      `${updated.display_name} is now on the companion screen.`));
  } catch (err) {
    el.startStatus.replaceChildren(message("error", "alert", err.message));
  } finally {
    state.startBusy = false;
    setBusy(el.startBtn, false, "", "Start companion");
    renderAll({ keepNameStatus: true });
  }
}

function message(kind, iconName, text) {
  const box = document.createElement("div");
  box.className = `message message-${kind}`;
  const p = document.createElement("p");
  p.textContent = text;
  box.append(icon(iconName), p);
  return box;
}

el.startBtn.addEventListener("click", startCompanion);

// ------------------------------------------------------------------ render

function renderAll() {
  renderPeople();
  const hasPerson = Boolean(selectedProfile());
  el.nameGroup.hidden = !hasPerson && !state.creating;
  el.photoGroup.hidden = !hasPerson;
  el.startGroup.hidden = !hasPerson;
  // One dominant primary action: "Add person" while creating, "Start companion" afterwards.
  if (!state.nameBusy) el.nameSubmit.textContent = state.creating ? "Add person" : "Save changes";
  el.nameSubmit.classList.toggle("btn-primary", state.creating);
  renderPhotos();
}

window.addEventListener("beforeunload", (e) => {
  const busy = [...state.uploads.values()].flat().some((x) => x.status === "queued" || x.status === "adding");
  if (busy || nameDirty()) e.preventDefault();
});

init();
