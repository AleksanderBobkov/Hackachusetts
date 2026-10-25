import { openStore, prepareMedia, limits, newId } from './db.js';
import { SpeechSession } from './speech.js';
import { recipientFor } from './routing.js';
import { startBridge } from './bridge.js';
import { initTouchKeyboard } from './keyboard.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paths = {
  heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  arrow:'M5 12h14m-6-6 6 6-6 6', back:'M19 12H5m6-6-6 6 6 6', plus:'M12 5v14M5 12h14',
  photo:'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm-1 13 5-5 5 5 3-3 5 5M8 7h.01',
  mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8',
  mute:'m3 3 18 18M9 9v3a3 3 0 0 0 5 2m1-5V5a3 3 0 0 0-6 0m-3 6v1a6 6 0 0 0 10 4m2-5v1m-6 6v4m-4 0h8',
  volume:'m11 4-6 4H2v8h3l6 4V4Zm4 4a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  home:'m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  pause:'M8 4v16M16 4v16', play:'m8 4 12 8-12 8V4Z', check:'m5 12 4 4L19 6',
  swap:'M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4', close:'m6 6 12 12M6 18 18 6',
  text:'M4 5h16M12 5v15M8 20h8', stop:'M5 5h14v14H5V5Z', people:'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-2a7 7 0 0 1 14 0v2m0-17a4 4 0 0 1 0 7m3 4a6 6 0 0 1 3 6',
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.heart}"/></svg>`;
const button = (action, text, symbol, kind='', extra='') => `<button type="button" class="btn ${kind}" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ''}${text}</button>`;
const languages = {es:'Español',en:'English'};
const state = { page:'people', people:[], selected:null, active:null, media:[], previews:new Map(), urls:[], slide:0, paused:false, muted:false, large:false, autoSpeak:true, volume:.8, partner:'Family', result:null, error:'', notice:'', uploading:false, failures:[], undo:null, listeningPreferences:{}, hear:{resident:'es',visitor:'en'}, running:false, sessionEpoch:0, manual:false, conversationStarted:false, awaitingRecipient:false, forcedRecipient:null, capabilities:{speech:false,translation:false,auto_detect:false,tts:false,simulated:false,remote:false} };
const PHOTO_INTERVAL_MS = 10000;
const CONTROLS_IDLE_MS = 8000;
let store, slideshowTimer, controlsTimer, opener, controlsVisible=true, keyboardMode=false;
let backendConnected=false, syncRunning=false, syncPending=false, syncActive=false, syncFrame=false;
const CONNECTION_ERROR='Connection to the companion was interrupted. Microphone and audio are off. Wait for it to reconnect, then start again.';
const speech = new SpeechSession(updateSpeech, receiveTurn, message=>{state.running=false;state.sessionEpoch++;clearTimeout(state.resumeTimer);state.error=message;if(state.page==='conversation')renderConversation();});
const announce = text => { $('#announcement').textContent=text; };
const person = () => state.people.find(p=>p.id===state.selected);
const active = () => state.people.find(p=>p.id===state.active);
const initial = name => Array.from(name.trim())[0]?.toLocaleUpperCase() || '?';
// Saved media has a server URL; a local Blob (not saved yet) gets a revocable object URL.
const urlFor = source => { if(typeof source==='string')return source; const url=URL.createObjectURL(source);state.urls.push(url);return url; };
const brand = `<div class="brand">${icon('heart')}Companion <span>/ Care</span></div>`;
const header = () => `<header class="topbar">${brand}<div class="toplinks">${button('help','About',null,'quiet')}</div></header>`;
const footer = () => '';
function beginPage(page) {
  clearInterval(slideshowTimer); clearTimeout(controlsTimer); pauseConversation(); state.error=''; state.page=page;
  state.urls.forEach(url=>URL.revokeObjectURL(url));state.urls=[];
  requestAnimationFrame(()=>window.scrollTo({top:0,left:0}));
}
function releaseUrls(){state.urls.forEach(url=>URL.revokeObjectURL(url));state.urls=[];}
function focusHeading(){ const h=$('main h1')||$('main h2');if(h){h.tabIndex=-1;h.focus({preventScroll:true});} }
async function loadPeople(){
  state.people=(await store.people()).sort((a,b)=>a.created-b.created);
  state.previews.clear();
  for(const p of state.people){const media=p.media||[];state.previews.set(p.id,{count:media.length,first:media.find(m=>m.type==='image')});}
}
async function loadCapabilities(){
  const response=await fetch('/api/capabilities');
  if(!response.ok)throw new Error('Speech service unavailable');
  const data=await response.json();
  state.capabilities={speech:data.speech===true,translation:data.translation===true,auto_detect:data.auto_detect===true,tts:data.tts===true,simulated:data.simulated===true,remote:data.remote===true};
  speech.serverVoice=state.capabilities.tts;
  if(data.output_languages&&typeof data.output_languages==='object'&&!Array.isArray(data.output_languages)){
    for(const code of Object.keys(languages))delete languages[code];
    for(const [code,label] of Object.entries(data.output_languages))if(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(code)&&typeof label==='string')languages[code]=label;
  }
}
function showSlideshow(profile){
  beginPage('standby');controlsVisible=true;state.selected=profile.id;state.active=profile.id;state.result=null;
  state.slide=0;state.paused=matchMedia('(prefers-reduced-motion: reduce)').matches;state.media=profile.media||[];
  renderStandby();focusHeading();scheduleControlsHide();
}
// Coalesce library notifications; re-read shared selection after a reconnect or activation.
async function synchronize({activate=false,frame=false}={}){
  syncPending=true;syncActive ||= activate;syncFrame ||= frame;
  if(syncRunning)return;
  syncRunning=true;
  try{
    while(syncPending){
      syncPending=false;const readActive=syncActive, openFrame=syncFrame;syncActive=false;syncFrame=false;
      await loadPeople();
      const profile=readActive?await store.activePerson():null;
      if(profile&&(openFrame||profile.id!==state.active)){showSlideshow(profile);continue;}
      if(state.page==='people')renderPeople();
      else if(state.page==='standby'){
        const id=state.media[state.slide]?.id;state.media=active()?.media||[];
        state.slide=Math.max(0,state.media.findIndex(item=>item.id===id));renderStandby();
      }else if(state.page==='conversation')renderConversation();
      // Keep an open settings form and its unsaved draft intact.
    }
  }catch(error){announce(error?.message||'Cannot refresh the companion right now.');}
  finally{syncRunning=false;}
}
function renderPeople(message=''){
  beginPage('people');
  $('#app').innerHTML=`<div class="shell">${header()}<main id="main"><div class="page-heading home-heading"><div><h1>A familiar place to start.</h1><p>Choose a person to open their photos. Tap <strong>Let’s talk</strong> when you’re ready for a conversation.</p></div>${button('add-person','Add person','plus','primary')}</div>${message?`<div class="notice error" role="alert">${escape(message)}</div>`:''}<div class="people-grid">${state.people.map(p=>{
    const preview=state.previews.get(p.id);return `<article class="person-card"><button class="person-open" data-action="select" data-id="${p.id}" aria-label="Open slideshow for ${escape(p.name)}"><div class="person-art">${preview?.first?`<img src="${urlFor(preview.first.display)}" alt="">`:`<span class="initial" aria-hidden="true">${escape(initial(p.name))}</span>`}</div><div class="person-details"><h2>${escape(p.name)}</h2><div class="person-meta">${icon('photo')}${preview?.count||0} ${(preview?.count||0)===1?'photo or video':'photos & videos'}</div></div></button><div class="person-actions">${p.example?'<span class="pill example">Example person</span>':'<span class="small muted">Slideshow</span>'}${button('person-settings','','settings','quiet square',`data-id="${p.id}" aria-label="Photos and settings for ${escape(p.name)}" title="Photos & settings"`)}</div></article>`;
  }).join('')}</div></main></div>`;
}
async function openSetup(id){
  const media=await store.media(id); // load first: if the device can't answer, the current screen stays as it was
  beginPage('setup');state.selected=id;state.media=media;state.notice='';state.failures=[];state.undo=null;renderSetup();focusHeading();
}
function renderSetup(){
  releaseUrls();
  const p=person();
  $('#app').innerHTML=`<div class="shell">${header()}<main id="main"><div class="backline">${button('people','Everyone','back','quiet')}</div><div class="page-heading"><div><p class="eyebrow">Photos & settings</p><h1>${escape(p.name)}</h1><p>Add favorite photos or short videos, then open the slideshow.<br>Photos change every 10 seconds.</p></div>${button('start','View slideshow','arrow','primary',state.uploading?'disabled':'')}</div><div class="setup-grid"><details class="profile-settings"><summary>Edit name</summary><form id="name-form"><div class="field"><label for="person-name">Name</label><input id="person-name" name="name" value="${escape(p.name)}" autocomplete="off" required ${state.uploading?'disabled':''}><p id="name-error" class="error-text" role="alert"></p></div>${button('save-name','Save name','check','',state.uploading?'disabled':'')}</form></details><section aria-labelledby="photos-title"><div class="section-title"><h2 id="photos-title">Photos & videos</h2><span class="muted">${state.media.length} of ${limits.items} items</span></div><div id="dropzone" class="dropzone">${icon('photo')}<p>Choose the faces and moments they’ll enjoy seeing.</p>${button('upload',state.uploading?'Adding your files…':'Add photos or videos','plus','primary',state.uploading?'disabled':'')}<p class="small muted">JPEG, PNG, WebP · Up to 12 MB per photo<br>MP4, WebM · Up to 50 MB and 60 seconds per video</p><input class="sr-only" type="file" id="file-input" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple tabindex="-1" aria-label="Choose photos and videos"></div><div class="notice ${state.error?'error':''}" role="status">${escape(state.error||state.notice)}${state.undo?button('undo','Undo removal',null,'quiet'):''}</div>${state.failures.map((f,i)=>`<div class="notice error"><strong>${escape(f.file.name)}</strong><br>${escape(f.error)}<div class="row">${button('retry-upload','Try again',null,'',`data-index="${i}" ${state.uploading?'disabled':''}`)}${button('dismiss-upload','Dismiss',null,'quiet',`data-index="${i}"`)}</div></div>`).join('')}<div class="media-grid">${state.media.map(m=>`<article class="media-card">${m.type==='image'?`<img src="${urlFor(m.display)}" alt="${escape(m.name)}" loading="lazy">`:`<video src="${urlFor(m.display)}" muted preload="metadata" aria-label="${escape(m.name)}"></video>`}<div class="media-caption">${escape(m.name)}<br><span class="muted">${m.type==='video'?'Video · silent in slideshow':'Photo'} · Saved</span></div>${button('remove-media','Remove',null,'',`data-id="${m.id}" ${state.uploading?'disabled':''}`)}</article>`).join('')}</div></section></div></main>${footer()}</div>`;
  bindUpload();
  $('#name-form').addEventListener('submit',e=>{e.preventDefault();saveName();});
  $('#person-name').addEventListener('input',()=>{$('#person-name').setAttribute('aria-invalid','false');$('#name-error').textContent='';});
}
function showDialog(html){opener=document.activeElement;const d=$('#dialog');d.classList.toggle('conversation-dialog',state.page==='conversation');d.innerHTML=html;const title=d.querySelector('h2');if(title){title.id='dialog-title';d.setAttribute('aria-labelledby','dialog-title');}d.showModal();const first=d.querySelector('input,textarea,select,button');first?.focus();}
function closeDialog(){ $('#dialog').close();if(opener?.isConnected)opener.focus();else if(opener?.dataset?.action)$(`[data-action="${opener.dataset.action}"]`)?.focus({preventScroll:true}); }
function addPerson(){
  const createKey=newId(); // one key per dialog: a retry after a lost response can't duplicate
  showDialog(`<form id="add-form"><p class="eyebrow">Someone new</p><h2>Who is this for?</h2><p class="muted">A name is all you need to get started.</p><div class="field"><label for="new-name">Name</label><input id="new-name" autocomplete="off" placeholder="Their name" required><p id="add-error" class="error-text" role="alert"></p></div><div class="dialog-actions">${button('close-dialog','Cancel',null,'quiet')}<button type="submit" class="btn primary">Add person ${icon('arrow')}</button></div></form>`);
  $('#add-form').addEventListener('submit',async event=>{
    event.preventDefault();const name=$('#new-name').value.trim();if(!name){$('#add-error').textContent='Enter a name to continue.';return;}
    const submit=event.submitter;submit.disabled=true;
    try{const p=await store.savePerson({name,example:false},{key:createKey});if(!state.people.some(x=>x.id===p.id))state.people.push(p);closeDialog();await openSetup(p.id);announce('Person saved. Add photos when you’re ready.');}
    catch(error){submit.disabled=false;$('#add-error').textContent=error?.message||'The name could not be saved. Please try again.';}
  });
}
async function saveName(){
  const field=$('#person-name');const name=field.value.trim();if(!name){$('#name-error').textContent='Enter a name to continue.';field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby','name-error');field.focus();return false;}
  const save=$('[data-action="save-name"]');save.disabled=true;
  try{const updated=await store.savePerson({...person(),name});Object.assign(person(),updated);state.notice='Name saved.';state.error='';renderSetup();announce('Name saved.');return true;}
  catch(error){save.disabled=false;$('#name-error').textContent=error?.message||'Your changes could not be saved. Please try again.';return false;}
}
async function leaveSetup(next){
  if(state.uploading){state.error='Please wait for these files to finish adding.';renderSetup();return;}
  if($('#person-name')&&$('#person-name').value!==person().name){
    showDialog(`<h2>Save the name change?</h2><p>Your photos are already saved.</p><div class="dialog-actions">${button('close-dialog','Stay',null,'quiet')}${button('discard-name','Discard changes')}${button('save-leave','Save changes',null,'primary')}</div>`);
    $('[data-action="discard-name"]').onclick=()=>{closeDialog();$('#person-name').value=person().name;next();};
    $('[data-action="save-leave"]').onclick=async()=>{closeDialog();if(await saveName())next();};return;
  }await next();
}
function bindUpload(){
  $('#file-input').onchange=event=>upload([...event.target.files]);
  const zone=$('#dropzone');zone.ondragover=e=>{e.preventDefault();zone.classList.add('dragging');};zone.ondragleave=()=>zone.classList.remove('dragging');zone.ondrop=e=>{e.preventDefault();zone.classList.remove('dragging');if(!state.uploading)upload([...e.dataTransfer.files]);};
}
async function upload(files){
  if(state.uploading||!files.length)return;
  if($('#person-name').value!==person().name){await leaveSetup(()=>upload(files));return;}
  const owner=state.selected;state.uploading=true;state.error='';state.notice='Adding files…';renderSetup();let saved=0;
  try{
    let used=(await store.allMedia()).reduce((sum,item)=>sum+item.size,0);
    for(const file of files){
      try{
        if(state.media.length>=limits.items)throw new Error('This person has 50 items. Remove an item before adding more.');
        const media=await prepareMedia(file,owner);
        if(used+media.size>limits.totalBytes)throw new Error('The 200 MB photo and video library is full. Remove an item before adding more.');
        const stored=await store.saveMedia(media,{key:media.key});
        if(state.media.some(m=>m.id===stored.id))continue; // this file was already added
        used+=stored.size;state.media.push(stored);saved++;
      }catch(error){state.failures.push({file,error:error.message||'This file couldn’t be added. Please try again.'});}
    }
    state.notice=`${saved} ${saved===1?'file':'files'} added and saved.${state.failures.length?' Some files need attention below.':''}`;
  }catch{state.error='Cannot connect to the companion right now. Your selected files have not been saved. Please try again.';}
  finally{state.uploading=false;if(state.page==='setup'&&state.selected===owner)renderSetup();announce(state.notice||state.error);}
}
async function removeMedia(id){
  const item=state.media.find(m=>m.id===id);try{const restorable=await store.removeMedia(item);state.media=state.media.filter(m=>m.id!==id);state.undo=restorable;state.notice=`Removed ${item.name}.`;state.error='';renderSetup();$('[data-action="undo"]')?.focus();}catch{state.error='This file could not be removed. Please try again.';renderSetup();}
}
async function startCompanion(){
  pauseConversation();
  const profile=await store.activatePerson(state.selected);
  showSlideshow(profile);
}
function scheduleControlsHide(){
  clearTimeout(controlsTimer);
  if(state.page!=='standby'||!controlsVisible||!state.media.length)return;
  controlsTimer=setTimeout(()=>{
    if(keyboardMode&&document.activeElement?.closest('.frame-chrome'))return;
    controlsVisible=false;syncFrameControls();
  },CONTROLS_IDLE_MS);
}
function syncFrameControls(){
  const frame=$('.standby');if(!frame)return;
  frame.classList.toggle('controls-hidden',!controlsVisible);
  document.querySelectorAll('.frame-chrome').forEach(el=>{el.inert=!controlsVisible;});
  $('.standby-stage').setAttribute('aria-label',controlsVisible?'Keep slideshow controls visible':'Show slideshow controls');
}
function revealControls(){
  if(state.page!=='standby')return;
  controlsVisible=true;syncFrameControls();scheduleControlsHide();
}
function renderStandby(){
  const focusedAction=document.activeElement?.dataset?.action;
  releaseUrls();
  clearInterval(slideshowTimer);const p=active();const item=state.media[state.slide];
  $('#app').innerHTML=`<main id="main" class="standby resident"><header class="standby-header"><div class="frame-chrome frame-home">${button('people','','home','quiet square','aria-label="Home" title="Home"')}</div><h1 class="identity">${escape(p.name)}</h1></header><div class="standby-stage" data-action="reveal-controls" role="button" tabindex="0" aria-label="Show slideshow controls">${item?(item.type==='image'?`<img src="${urlFor(item.display)}" alt="${escape(item.name)}">`:`<video id="slide-video" src="${urlFor(item.display)}" ${state.paused?'':'autoplay'} muted playsinline ${state.media.length===1?'loop':''} aria-label="${escape(item.name)}"></video>`):`<div class="standby-empty"><div class="empty-art">${icon('photo')}</div><h2>A little time together.</h2><p>You can start a conversation now.<br>Add photos from this person’s settings on the home screen.</p></div>`}</div><div class="frame-hint" aria-hidden="true">Tap the screen for controls</div><footer class="standby-footer frame-chrome">${button('wake','Let’s talk','mic','primary frame-talk')}${state.media.length?`<div class="slide-controls">${state.media.length>1?button('previous','', 'back','square','aria-label="Previous photo or video"'):''}${button('pause',state.paused?'Play':'Pause',state.paused?'play':'pause','',state.media.length===1&&item.type==='image'?'disabled':'')}${state.media.length>1?button('next','','arrow','square','aria-label="Next photo or video"'):''}</div><span class="count" aria-label="Slide ${state.slide+1} of ${state.media.length}">${state.slide+1} / ${state.media.length}</span>`:''}</footer></main>`;
  syncFrameControls();
  $('.standby-stage').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();revealControls();}};
  const video=$('#slide-video');if(video){video.onended=()=>{if(!state.paused&&state.media.length>1)advance(1);};video.onerror=()=>{state.paused=true;revealControls();announce('This video cannot play on this device. Choose the next item.');};if(!state.paused)video.play()?.catch(()=>{state.paused=true;revealControls();const play=$('[data-action="pause"]');if(play)play.innerHTML=icon('play')+'Play';announce('Video paused. Press Play to try again.');});}
  if(!state.paused&&state.media.length>1&&item.type!=='video')slideshowTimer=setInterval(()=>advance(1),PHOTO_INTERVAL_MS);
  if(controlsVisible&&['previous','next','pause'].includes(focusedAction))$(`[data-action="${focusedAction}"]`)?.focus({preventScroll:true});
  else if(focusedAction==='reveal-controls')$('.standby-stage')?.focus({preventScroll:true});
}
function advance(delta){state.slide=(state.slide+delta+state.media.length)%state.media.length;renderStandby();}
function wake(){
  beginPage('conversation');state.result=null;state.awaitingRecipient=false;state.conversationStarted=false;
  state.hear={...(state.listeningPreferences[state.active]||{resident:'es',visitor:'en'})};
  renderConversation();focusHeading();announce('Choose what each person wants to hear, then tap Start conversation.');
}
const partnerName = () => state.partner==='Nurse'?'Nurse':'Visitor';
const recipientName = recipient => recipient==='resident'?active().name:partnerName();
function languageName(code){
  if(!code||code==='auto')return 'Language detected automatically';
  try{return languages[code]||new Intl.DisplayNames(['en'],{type:'language'}).of(code)||code;}catch{return code;}
}
function languageOptions(value){return Object.entries(languages).map(([code,name])=>`<option value="${escape(code)}" ${code===value?'selected':''}>${escape(name)}</option>`).join('');}
function statusLabel(){
  if(state.awaitingRecipient)return 'Who is this for?';
  if(speech.state!=='ready')return ({permission:'Allow microphone access',listening:'Listening',transcribing:'Understanding your words',processing:'Translating',preparing:'Getting ready to read aloud',speaking:'Reading aloud'})[speech.state];
  if(state.running)return 'Getting ready to listen';
  return state.conversationStarted?'Conversation paused':'Ready when you are';
}
function conversationHint(){
  if(state.awaitingRecipient)return 'Choose who should hear these words. Your words are kept below.';
  if(speech.state==='listening')return state.manual?'Speak now. Tap Finish speaking when you’re done.':'Speak one at a time. Pause when you’re finished; we’ll translate for you.';
  if(speech.state==='permission')return 'Allow the microphone in your browser to begin. You can pause at any time.';
  if(['transcribing','processing'].includes(speech.state))return state.capabilities.remote?'The microphone is off. Your words are being sent to the online translation service.':'You can pause at any time. The microphone is off while we translate.';
  if(speech.state==='speaking'||speech.state==='preparing')return 'Listen or read along. The microphone is off while the words play.';
  if(state.running)return 'The next person can speak when Listening appears.';
  if(state.result)return state.manual?'Microphone off. Choose who you’re speaking to when you’re ready.':'Microphone off. Start again whenever you’re ready.';
  if(state.manual)return 'Tap who you’re speaking to. Speak, then tap Finish speaking.';
  return state.autoSpeak?'Tap Start, then speak one at a time. We’ll translate and read the words aloud.':'Tap Start, then speak one at a time. Read the translation on screen.';
}
function updateSpeech(){if(state.page==='conversation'){renderConversation();announce(statusLabel());}}
function pauseConversation(){
  state.running=false;state.forcedRecipient=null;state.sessionEpoch++;clearTimeout(state.resumeTimer);speech.cancel();
}
function turnMeta(stage='detect',recipient=null){
  return {turn_id:newId(),person_id:state.active,stage,source_language:'auto',
    preferred_output_languages:{...state.hear},...(recipient?{recipient,target_language:state.hear[recipient]}:{})};
}
function startConversation(recipient=null){
  if(state.running){pauseConversation();renderConversation();return;}
  if(!backendConnected){state.error=CONNECTION_ERROR;renderConversation();return;}
  if(!state.capabilities.speech||!state.capabilities.auto_detect||!state.capabilities.translation){
    state.error='Live translation isn’t connected yet. Choose Try an example to see how a conversation works.';
    renderConversation();return;
  }
  state.error='';state.muted=false;state.running=true;state.conversationStarted=true;
  state.awaitingRecipient=false;state.forcedRecipient=recipient;state.sessionEpoch++;
  speech.start(turnMeta(),!state.manual);
}
function resumeListening(epoch){
  clearTimeout(state.resumeTimer);
  if(!state.running||state.manual||state.awaitingRecipient||state.page!=='conversation'||epoch!==state.sessionEpoch)return;
  state.resumeTimer=setTimeout(()=>{
    if(state.running&&state.page==='conversation'&&!$('#dialog').open&&epoch===state.sessionEpoch)speech.start(turnMeta(),true);
  },450);
}
function receiveTurn(result){
  if(state.page!=='conversation')return;
  if(result.stage==='detect'){
    state.result={...result,translation:null,recipient:null};
    const recipient=state.forcedRecipient||recipientFor(result.detected_language,state.hear,result.detection_certain);
    state.forcedRecipient=null;
    if(!recipient){state.awaitingRecipient=true;renderConversation();announce('Who is this for? Choose a person to hear the translation.');return;}
    translateFor(recipient);return;
  }
  state.result={...state.result,...result};state.error='';renderConversation();
  if(result.translation)completeTurn();
}
async function completeTurn(){
  const epoch=state.sessionEpoch;
  if(state.autoSpeak&&state.result?.translation){const played=await speech.speak(state.result.translation,state.result.target_language);if(!played)return;}
  if(epoch!==state.sessionEpoch||state.page!=='conversation')return;
  if(state.manual){state.running=false;renderConversation();}else resumeListening(epoch);
}
function translateFor(recipient){
  if(!state.result?.transcript)return;
  state.awaitingRecipient=false;state.error='';
  state.result={...state.result,recipient,target_language:state.hear[recipient],translation:null,pronunciation:''};
  if(state.result.example){
    const text=state.result.exampleTranslations?.[state.hear[recipient]];
    if(text){state.result.translation=text;renderConversation();completeTurn();}
    else{pauseConversation();state.error='This example has no translation for that language. Try Spanish or English.';renderConversation();}
    return;
  }
  if(!state.capabilities.translation){pauseConversation();state.error='Your words are kept here. Connect the translation service to translate them.';renderConversation();return;}
  speech.typed(state.result.transcript,turnMeta('translate',recipient));
}
function talkControls(){
  if(state.awaitingRecipient)return state.running?button('pause-conversation','Pause conversation','pause'):'';
  if(state.running||speech.state!=='ready')return button('pause-conversation','Pause conversation','pause','primary')+
    (speech.state==='listening'?button('finish-turn','Finish speaking','check'):['speaking','preparing'].includes(speech.state)?button('speak-now','Speak now','mic'):'');
  if(state.manual)return button('manual-resident',`Speak to ${escape(active().name)}`,'mic','primary')+button('manual-visitor',`Speak to ${partnerName().toLowerCase()}`,'mic');
  return button('start-conversation','Start conversation','mic','primary');
}
function preferenceFields(){return `<div class="hearing-preferences"><div class="field"><label for="resident-hears">${escape(active().name)} wants to hear</label><select id="resident-hears">${languageOptions(state.hear.resident)}</select></div><div class="field"><label for="visitor-hears">${partnerName()} wants to hear</label><select id="visitor-hears">${languageOptions(state.hear.visitor)}</select></div></div>`;}
function routingGuide(){
  const resident=languageName(state.hear.resident), visitor=languageName(state.hear.visitor);
  if(state.hear.resident.split('-')[0]===state.hear.visitor.split('-')[0])return `<div class="route-guide"><p class="route-same">You both want to hear ${escape(resident)}.</p><p>We’ll ask who should hear each turn because language alone can’t tell us.</p></div>`;
  return `<div class="route-guide"><div class="route-map"><p>If someone speaks <strong>${escape(resident)}</strong><span aria-hidden="true"> → </span><strong>${escape(partnerName())}</strong> hears ${escape(visitor)}.</p><p>If someone speaks <strong>${escape(visitor)}</strong><span aria-hidden="true"> → </span><strong>${escape(active().name)}</strong> hears ${escape(resident)}.</p></div><p class="route-fallback">Another language or unsure? We’ll ask who should hear it. We detect the language, not the person.</p></div>`;
}
function bindPreferences(){
  for(const [id,key] of [['resident-hears','resident'],['visitor-hears','visitor']]){
    const field=$('#'+id);if(field)field.onchange=e=>{state.hear[key]=e.target.value;state.listeningPreferences[state.active]={...state.hear};state.result=null;state.awaitingRecipient=false;state.error='';const guide=$('.route-guide');if(guide)guide.innerHTML=routingGuide();};
  }
}
// Disclosures under a live translation: machine translation, and the AI voice when it reads aloud.
function captionNote(r){
  if(r.example)return '';
  if(r.simulated)return '<p class="caption-note">Simulated for testing. This is not a real translation.</p>';
  const voice=state.autoSpeak&&state.capabilities.tts?' Read aloud by an AI voice.':'';
  return r.machine_translation===false?'':`<p class="caption-note">Machine translation. It may be imperfect.${voice}</p>`;
}
function serviceNote(){
  const c=state.capabilities;
  if(!(c.auto_detect&&c.translation))return 'Preview · Live translation not connected';
  if(c.simulated)return 'Test mode · Simulated speech service, not real translation';
  return c.remote?'Input language detected automatically · Speech is sent to an online service':'Input language detected automatically';
}
function renderConversation(){
  const focused=document.activeElement?.dataset?.action;
  const r=state.result, started=state.conversationStarted||!!r;
  const detected=r?.detected_language?(r.detection_certain===false?'Language unclear':languageName(r.detected_language)):null;
  const choices=button('recipient-resident',`${escape(active().name)} · ${escape(languageName(state.hear.resident))}`,null,'primary')+button('recipient-visitor',`${partnerName()} · ${escape(languageName(state.hear.visitor))}`);
  $('#app').innerHTML=`<main id="main" class="conversation resident conversation-v2 ${state.large?'large-text':''}">
    <div class="conversation-top">
    <header class="conversation-header"><div class="conversation-home">${button('people','Home','home','quiet','title="Choose a person"')}</div><h1 class="identity">${escape(active().name)}</h1></header>
    <nav class="conversation-navigation" aria-label="Conversation navigation">${button('back-slideshow','Back to photos','back')}${button('accessibility','Text size & sound','settings')}</nav>
    </div>
    <div class="conversation-heading"><h2 id="conversation-status">${escape(statusLabel())}</h2><p id="conversation-hint">${escape(conversationHint())}</p></div>
    ${started?`<div class="hearing-summary"><p>${escape(active().name)} hears <strong>${escape(languageName(state.hear.resident))}</strong><span aria-hidden="true"> · </span>${partnerName()} hears <strong>${escape(languageName(state.hear.visitor))}</strong></p>${button('languages','Change languages',null,'quiet')}</div>`:''}
    ${!started?`<section class="conversation-welcome" aria-label="Listening languages"><h2>What would you each like to hear?</h2>${preferenceFields()}<p class="automatic-note">${icon('swap')}Speak in any language. We’ll detect it for you.</p>${routingGuide()}</section>`:
    `<div class="caption-grid"><section class="caption-pane" aria-label="Original words" tabindex="0"><div class="caption-label"><span>${detected?`${escape(detected)} · Original`:'Original words'}</span>${r?.example?'<span class="pill example">Example</span>':r?.simulated?'<span class="pill example">Simulated</span>':''}</div>${r?`<p class="caption-text" ${r.detected_language?`lang="${escape(r.detected_language)}"`:''} dir="auto">${escape(r.transcript)}</p>`:`<p class="caption-text muted">Your words will appear here.</p>`}</section>
    <section class="caption-pane translated" aria-label="Translated words" tabindex="0">${state.awaitingRecipient?`<h2>Who should hear this?</h2><p class="recipient-instruction">Tap a person to hear the translation.</p><div class="recipient-choices">${choices}</div>`:
    `<div class="caption-label"><span>${r?.recipient?`For ${escape(recipientName(r.recipient))} · ${escape(languageName(r.target_language))}`:'Translated words'}</span>${r?.recipient?button('change-recipient','Change',null,'quiet recipient-change','aria-label="Change who hears this translation"'):''}</div>
    ${r?.translation?`<p class="caption-text" lang="${escape(r.target_language)}" dir="auto">${escape(r.translation)}</p>${r.pronunciation?`<p class="caption-pronunciation" lang="${escape(r.target_language)}-Latn"><span class="sr-only">Pronunciation: </span>${escape(r.pronunciation)}</p>`:''}<div class="caption-actions">${button('replay','Read again','volume','replay',state.running?'disabled':'')}${captionNote(r)}</div>`:`<p class="caption-text muted">${speech.state==='processing'?'Translating your words…':r?'Your translation will appear here.':'Read the translation here, or listen aloud.'}</p>`}`}</section></div>`}
    ${state.error?`<div class="notice error" role="alert">${escape(state.error)}</div>`:''}
    <div class="talk-controls conversation-actions" id="talk-controls">${talkControls()}</div>
    <footer class="conversation-bottom"><div class="row">${button('type','Type instead','text','quiet',state.running?'disabled':'')}${button('examples','Try an example',null,'quiet',state.running?'disabled':'')}</div><p class="preview-note">${escape(serviceNote())}</p></footer>
  </main>`;
  bindPreferences();
  if(focused)$(`[data-action="${focused}"]`)?.focus({preventScroll:true});
}
function editLanguages(){
  pauseConversation();
  showDialog(`<h2>What would you like to hear?</h2>${preferenceFields()}<p class="muted">These are listening languages. You can speak in any language.</p><div class="dialog-actions">${button('save-languages','Done',null,'primary')}</div>`);
  bindPreferences();
}
const conversationExamples=[
  {detected_language:'es',detection_certain:true,transcript:'Me alegra mucho que estés aquí.',exampleTranslations:{es:'Me alegra mucho que estés aquí.',en:'I’m so glad you’re here.'}},
  {detected_language:'en',detection_certain:true,transcript:'I’m happy to see you too, Grandma.',exampleTranslations:{es:'Yo también me alegro de verte, abuela.',en:'I’m happy to see you too, Grandma.'}},
  {detected_language:'fr',detection_certain:true,transcript:'Je suis heureux de vous voir.',exampleTranslations:{es:'Me alegra verte.',en:'I’m happy to see you.'}},
  {detected_language:null,detection_certain:false,transcript:'Okay.',exampleTranslations:{es:'Está bien.',en:'Okay.'}}
];
function examples(){
  pauseConversation();
  showDialog(`<h2>Try a conversation</h2><p class="muted">Written examples with Spanish and English translations. The microphone stays off.</p><div class="example-list">${['Spanish → English','English → Spanish','A third language: French','A short word: “Okay”'].map((label,index)=>button('example',label,null,'',`data-index="${index}"`)).join('')}</div><div class="dialog-actions">${button('close-dialog','Close',null,'quiet')}</div>`);
}
function useExample(index){
  pauseConversation();state.conversationStarted=true;state.error='';
  let example=structuredClone(conversationExamples[index]);
  if(state.partner==='Nurse'&&index<2)example=index===0?{detected_language:'es',detection_certain:true,transcript:'Tengo frío. ¿Me puede traer una manta?',exampleTranslations:{es:'Tengo frío. ¿Me puede traer una manta?',en:'I’m cold. Could you bring me a blanket?'}}:{detected_language:'en',detection_certain:true,transcript:'I’ll bring you a blanket.',exampleTranslations:{en:'I’ll bring you a blanket.',es:'Voy a traerle una manta.'}};
  closeDialog();receiveTurn({...example,...turnMeta(),example:true});
}
function typed(){
  pauseConversation();
  showDialog(`<form id="type-form"><h2>Type your words.</h2><div class="field"><label for="typed-message">Message · any language</label><textarea id="typed-message" rows="4" required maxlength="2000"></textarea></div><p class="muted">${state.capabilities.auto_detect?'We’ll detect the language. If the direction is unclear, we’ll ask who should hear it.':'Live translation isn’t connected. You can still show your original words.'}</p><div class="dialog-actions">${button('close-dialog','Cancel',null,'quiet')}<button type="submit" class="btn primary">${state.capabilities.auto_detect?'Translate':'Show words'}</button></div></form>`);
  $('#type-form').onsubmit=e=>{e.preventDefault();const text=$('#typed-message').value.trim();if(!text)return;closeDialog();state.conversationStarted=true;state.error='';state.result={...turnMeta(),transcript:text,translation:null};renderConversation();if(state.capabilities.auto_detect&&state.capabilities.translation)speech.typed(text,turnMeta());else{state.error='Original words only. Live translation isn’t connected yet.';renderConversation();}};
}
function accessibility(){
  pauseConversation();
  showDialog(`<h2>Text size & sound</h2><p class="muted">Make the words easier to read and choose how loud they play.</p><label class="toggle"><input id="large-text" type="checkbox" ${state.large?'checked':''}>Make the words larger</label><label class="toggle"><input id="auto-speak" type="checkbox" ${state.autoSpeak?'checked':''}>Read translations aloud</label><div class="field"><label for="volume">Speaker volume <span id="volume-value">${Math.round(state.volume*100)}%</span></label><input id="volume" type="range" min="0" max="100" value="${state.volume*100}"></div><p class="small muted">Volume changes the sound. To stop the microphone and sound, tap Pause conversation.</p><div class="divider"></div><h3>Speaking preferences</h3><label class="toggle"><input id="manual-talk" type="checkbox" ${state.manual?'checked':''}>Use buttons to take turns speaking</label><p class="small muted">Choose who you’re speaking to, then tap Finish speaking.</p><div class="field"><label for="partner">Who are you talking with?</label><select id="partner"><option value="Family" ${state.partner==='Family'?'selected':''}>Family or visitor</option><option value="Nurse" ${state.partner==='Nurse'?'selected':''}>A nurse</option></select></div><div class="dialog-actions">${button('close-dialog','Done',null,'primary')}</div>`);
  $('#manual-talk').onchange=e=>{state.manual=e.target.checked;renderConversation();};
  $('#large-text').onchange=e=>{state.large=e.target.checked;renderConversation();};
  $('#auto-speak').onchange=e=>{state.autoSpeak=e.target.checked;renderConversation();};
  $('#partner').onchange=e=>{state.partner=e.target.value;state.result=null;state.awaitingRecipient=false;renderConversation();};
  $('#volume').oninput=e=>{state.volume=Number(e.target.value)/100;speech.setVolume(state.volume);$('#volume-value').textContent=`${e.target.value}%`;};
}

function aboutService(){
  const c=state.capabilities;
  if(!(c.speech&&c.translation))return 'Live transcription and translation need a connected speech service.';
  if(c.simulated)return 'Test mode: the speech service gives simulated results, not real transcription or translation. They are labeled Simulated.';
  return `An online service transcribes and translates speech. Each recording is sent after the person finishes speaking. Translations are made by a machine and may be imperfect.${c.tts?' The voice that reads them aloud is AI-generated.':''}`;
}
function about(){showDialog(`<p class="eyebrow">Companion / Care</p><h2>Made for a little more connection.</h2><p>People, their photos and short videos, a slideshow, and two-language conversations with captions and spoken translations.</p><div class="notice">${escape(aboutService())} Example conversations are labeled.</div><p class="muted">Names, photos and videos are saved on this companion device, so every screen shows the same people. Conversations are not saved. Example people are fictional. Nothing here identifies people in photos or creates lasting memories from conversations.</p><div class="dialog-actions">${button('close-dialog','Got it',null,'primary')}</div>`);}
document.addEventListener('pointerdown',()=>{keyboardMode=false;});
document.addEventListener('keydown',event=>{keyboardMode=true;if(state.page==='standby'&&event.key==='Tab')revealControls();});
document.addEventListener('focusin',()=>{if(state.page==='standby'&&keyboardMode)revealControls();});
document.addEventListener('click',async event=>{
  if(state.page==='standby')revealControls();
  const target=event.target.closest('[data-action]');if(!target||target.disabled)return;const action=target.dataset.action;
  try{
    if(action==='close-dialog')closeDialog();
    else if(action==='help')about();
    else if(action==='add-person')addPerson();
    else if(action==='select'){state.selected=target.dataset.id;await startCompanion();}
    else if(action==='person-settings')await openSetup(target.dataset.id);
    else if(action==='people')await leaveSetup(async()=>{await loadPeople();renderPeople();focusHeading();});
    else if(action==='save-name')await saveName();
    else if(action==='upload')$('#file-input').click();
    else if(action==='retry-upload'){const [failure]=state.failures.splice(Number(target.dataset.index),1);await upload([failure.file]);}
    else if(action==='dismiss-upload'){state.failures.splice(Number(target.dataset.index),1);renderSetup();}
    else if(action==='remove-media')await leaveSetup(()=>removeMedia(target.dataset.id));
    else if(action==='undo'){const restored=await store.saveMedia(state.undo,{key:state.undo.restoreKey});state.media.push(restored);state.undo=null;state.notice='File restored.';renderSetup();}
    else if(action==='start')await leaveSetup(startCompanion);
    else if(action==='setup-active')await openSetup(state.active);
    else if(action==='reveal-controls')revealControls();
    else if(action==='wake')wake();
    else if(action==='previous')advance(-1);
    else if(action==='next')advance(1);
    else if(action==='pause'){state.paused=!state.paused;renderStandby();}
    else if(action==='back-slideshow'){beginPage('standby');controlsVisible=true;state.paused=true;renderStandby();focusHeading();scheduleControlsHide();}
    else if(action==='start-conversation')startConversation();
    else if(action==='pause-conversation'||action==='mute'){pauseConversation();renderConversation();announce('Conversation paused. Microphone and audio stopped.');}
    else if(action==='finish-turn')speech.finish();
    else if(action==='speak-now'){pauseConversation();startConversation();}
    else if(action==='manual-resident')startConversation('resident');
    else if(action==='manual-visitor')startConversation('visitor');
    else if(action==='recipient-resident')translateFor('resident');
    else if(action==='recipient-visitor')translateFor('visitor');
    else if(action==='change-recipient'){pauseConversation();state.awaitingRecipient=true;renderConversation();}
    else if(action==='languages')editLanguages();
    else if(action==='save-languages'){closeDialog();renderConversation();}
    else if(action==='examples')examples();
    else if(action==='example')useExample(Number(target.dataset.index));
    else if(action==='replay'&&state.result?.translation){pauseConversation();speech.speak(state.result.translation,state.result.target_language);}
    else if(action==='type')typed();
    else if(action==='accessibility')accessibility();
  }catch(error){
    state.error=error?.status===0?error.message:'This change could not be completed. Please try again.';announce(state.error);
    if(state.page==='setup')renderSetup();else if(state.page==='conversation')renderConversation();
    else renderPeople(state.error); // e.g. a slideshow that couldn't load: stay on a working screen
  }
});
// Hardware bridge dispatches the same intent as on-screen controls; no global spacebar trap.
// Physical buttons arrive here through bridge.js (backend /ws relay, or ?keys=1 dev keys).
window.addEventListener('companion:control',event=>{
  const {action,speaker='resident',value}=event.detail||{};
  if(action==='STOP_ALL'){pauseConversation();if(state.page==='conversation'){renderConversation();announce('Conversation paused. Microphone and audio stopped.');}return;}
  if(action==='WAKE'&&state.page==='standby'){wake();return;}
  if(action==='SET_VOLUME'){state.volume=Math.max(0,Math.min(1,Number(value)||0));if(!speech.setVolume(state.volume)&&speech.state==='speaking'){pauseConversation();renderConversation();}return;}
  // TALK on the photo frame opens the conversation, like the on-screen Let's talk.
  if(action==='START_TURN'&&state.page==='standby'&&!$('#dialog').open){wake();return;}
  if(state.page!=='conversation'||$('#dialog').open)return;
  if(action==='START_TURN'){
    if(speech.state==='listening'){speech.finish();return;} // tap again to finish speaking
    if(['speaking','preparing'].includes(speech.state)){pauseConversation();renderConversation();announce('Reading stopped.');return;}
    if(['transcribing','processing'].includes(speech.state)){announce('Still working on the last words. One moment.');return;}
    if(!state.running&&speech.state==='ready')startConversation(state.manual?(speaker==='resident'?'visitor':'resident'):null);
  }
  if(action==='END_TURN')speech.finish();
});
window.addEventListener('companion:session',event=>{
  pauseConversation();state.awaitingRecipient=false;
  if(state.page==='conversation')renderConversation();
  announce('Conversation stopped because the shared session changed.');
  if(event.detail.reason==='profile')synchronize({activate:true,frame:true});
});
window.addEventListener('companion:library',()=>synchronize());
window.addEventListener('companion:connection',async event=>{
  backendConnected=event.detail.connected;
  if(!backendConnected){
    pauseConversation();
    if(state.page==='conversation'){state.error=CONNECTION_ERROR;renderConversation();}
    return;
  }
  try{await loadCapabilities();}catch{ /* fetch again on the next reconnect */ }
  if(state.error===CONNECTION_ERROR)state.error='';
  synchronize({activate:true});
});
window.addEventListener('beforeunload',e=>{if(state.uploading||(state.page==='setup'&&$('#person-name')?.value!==person()?.name)){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>pauseConversation());
document.addEventListener('visibilitychange',()=>{if(document.hidden){pauseConversation();if(state.page==='standby'){state.paused=true;clearInterval(slideshowTimer);clearTimeout(controlsTimer);$('#slide-video')?.pause();}}else if(state.page==='standby'){renderStandby();revealControls();}});
async function init(){
  try{
    store=await openStore();await loadPeople();
    // Fixed keys: two screens opening at once (or a reload mid-way) can't create the examples twice.
    if(!state.people.length){for(const [index,name] of ['María Elena','James','Amina'].entries())await store.savePerson({name,example:true},{key:`example-person-${index}`});await loadPeople();}
    const profile=await store.activePerson();
    if(profile)showSlideshow(profile);else renderPeople();
    try{await loadCapabilities();}catch{}
    startBridge({keys:new URLSearchParams(location.search).get('keys')==='1'});
  }catch{$('#app').innerHTML=`<main class="shell"><div class="page-heading"><h1>We can’t reach the companion right now.</h1></div><p>The companion service on this device isn’t answering. Check that it’s running, then try again. Nothing has been changed.</p>${button('reload','Try again',null,'primary')}</main>`;$('[data-action="reload"]').onclick=()=>location.reload();}
}
initTouchKeyboard();
init();
