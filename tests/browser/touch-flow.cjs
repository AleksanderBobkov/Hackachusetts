// Local integration check. Run against an isolated PROVIDER=mock backend.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/mmbur/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:8765';
const out=path.resolve('review/fixed');fs.mkdirSync(out,{recursive:true});
const evidence={checks:[],requests:[],errors:[],layouts:[]};
let browser;
(async()=>{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1280,height:720},hasTouch:true,permissions:['microphone']});
  await context.addInitScript(()=>{
    window.testTracks=[];window.testAudio=[];
    const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async options=>{const stream=await get(options);window.testTracks.push(...stream.getTracks());return stream;};
    const OriginalAudio=window.Audio;
    window.Audio=function(...args){const audio=new OriginalAudio(...args);audio.addEventListener('ended',()=>audio.testCompleted=true);window.testAudio.push(audio);return audio;};
    const OriginalSocket=window.WebSocket;
    window.WebSocket=class extends OriginalSocket{constructor(...args){super(...args);window.testSocket=this;}};
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',e=>evidence.errors.push(e.message));
  page.on('response',r=>{if(/\/api\/turn|\/api\/speak|\/controls/.test(r.url()))evidence.requests.push({path:new URL(r.url()).pathname,status:r.status()});});
  const tap=action=>page.locator(`[data-action="${action}"]`).tap();
  const status=text=>page.waitForFunction(text=>document.querySelector('#conversation-status')?.textContent===text,text);
  const stopped=()=>page.waitForFunction(()=>window.testTracks.every(t=>t.readyState==='ended')&&window.testAudio.every(a=>a.paused));
  async function layout(name){
    await page.evaluate(()=>document.fonts.ready);
    const geometry=await page.evaluate(name=>({name,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,panes:[...document.querySelectorAll('.caption-pane,.conversation-welcome')].map(el=>({class:el.className,height:el.clientHeight,scrollHeight:el.scrollHeight,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom})),buttons:[...document.querySelectorAll('main button')].map(el=>({text:el.innerText||el.getAttribute('aria-label'),bottom:el.getBoundingClientRect().bottom,top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height}))}),name);
    evidence.layouts.push(geometry);assert.equal(geometry.scrollWidth,1280);
    if(name!=='setup')assert.ok(geometry.scrollHeight<=720,`${name} overflows the screen`);
    await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});
    return geometry;
  }
  const caps=await (await page.request.get(`${base}/api/capabilities`)).json();assert.equal(caps.simulated,true,'Use an isolated mock backend for this test');
  await page.goto(base);await page.locator('.person-open,.standby').first().waitFor();
  if(await page.locator('.standby').count())await tap('people');
  await page.locator('.person-open').first().tap();await page.locator('.standby').waitFor();
  const shared=(await (await page.request.get(`${base}/profiles/active`)).json()).profile;
  assert.ok(shared);evidence.checks.push('Touch person selection updates the backend active profile');
  await layout('slideshow');await tap('wake');
  const welcome=await layout('welcome');assert.ok(welcome.panes[0].scrollHeight<=welcome.panes[0].height+1,'Default welcome content needs internal scrolling');
  await tap('type');await page.locator('#typed-message').tap();
  for(const key of ['h','i','space','t','h','e','r','e'])await page.locator(`.touch-key[data-key="${key}"]`).tap();
  assert.equal(await page.locator('#typed-message').inputValue(),'Hi there');
  await page.locator('.touch-key[data-key="backspace"]').tap();assert.equal(await page.locator('#typed-message').inputValue(),'Hi ther');
  await page.locator('.touch-key[data-key="done"]').tap();await tap('close-dialog');
  evidence.checks.push('Built-in touch keyboard types, deletes and closes without a physical keyboard');
  await tap('type');await page.locator('#typed-message').fill('Me alegra mucho que estés aquí.');
  const speechResponse=page.waitForResponse(r=>r.url().endsWith('/api/speak'));
  await page.locator('#type-form button[type=submit]').tap();
  assert.equal((await speechResponse).status(),200);await status('Conversation paused');
  assert.equal(await page.locator('.translated .caption-text').innerText(),"I'm so glad you're here.");
  await page.waitForFunction(()=>window.testAudio.some(a=>a.testCompleted));
  const translated=await layout('translated');assert.ok(translated.panes.every(p=>p.scrollHeight<=p.height+1),'Short translation/actions need internal scrolling');
  evidence.checks.push('Type/Translate drives detect -> translation -> playable TTS with correct direction');
  await tap('accessibility');await page.locator('#manual-talk').check();await tap('close-dialog');
  await tap('manual-visitor');await status('Listening');await page.waitForTimeout(3500);
  const recorded=page.waitForResponse(r=>r.url().endsWith('/api/turn'));
  await tap('finish-turn');const response=await recorded;const detection=await response.json();
  assert.equal(response.status(),200,JSON.stringify(detection));
  await status('Conversation paused');assert.equal(await page.locator('.caption-pane:not(.translated) .caption-text').innerText(),detection.transcript);
  assert.ok(await page.locator('.translated .caption-text').innerText());await stopped();
  evidence.checks.push('Touch Speak/Finish sends an actual browser MediaRecorder upload, translates and plays mock speech');
  await tap('manual-visitor');await status('Listening');await tap('pause-conversation');await stopped();await status('Conversation paused');
  evidence.checks.push('Pause immediately stops live browser capture');
  await tap('manual-visitor');await status('Listening');await page.request.post(`${base}/session/reset`);await stopped();await status('Conversation paused');
  evidence.checks.push('Backend reset stops browser capture');
  // Hold a real TTS response so there is time to reset browser playback.
  await page.route('**/api/speak',async route=>{const response=await route.fetch();const body=await response.body();const pcm=body.subarray(44);const repetitions=12;const wav=Buffer.concat([body.subarray(0,44),...Array(repetitions).fill(pcm)]);wav.writeUInt32LE(wav.length-8,4);wav.writeUInt32LE(wav.length-44,40);await route.fulfill({response,body:wav});});
  await tap('replay');await status('Reading aloud');await page.request.post(`${base}/session/reset`);await stopped();await status('Conversation paused');
  await page.unroute('**/api/speak');evidence.checks.push('Backend reset stops audio that is already playing');
  // Pause before the translation request reaches the backend; a late response must not play.
  await page.route('**/api/turn',async route=>{const body=route.request().postData()||'';if(body.includes('"stage":"translate"'))await new Promise(r=>setTimeout(r,700));try{await route.continue();}catch{}});
  await tap('type');await page.locator('#typed-message').fill("I'll bring you a blanket.");
  await page.locator('#type-form button[type=submit]').tap();await status('Translating');
  // Typed turns have no running loop, but pending work must still show the Pause control.
  await tap('pause-conversation');await stopped();await page.waitForTimeout(900);
  await status('Conversation paused');await page.unroute('**/api/turn');
  evidence.checks.push('Pause aborts a pending translation and rejects its late response');
  const staff=await context.newPage();await staff.goto(`${base}/setup`);
  const created=(await (await staff.request.post(`${base}/profiles`,{data:{display_name:'Touch Sync Test'}})).json());
  await staff.reload();await staff.locator(`input[name=person][value="${created.profile_id}"]`).check();
  await staff.locator('#start-btn').tap();await page.waitForFunction(name=>document.querySelector('.standby .identity')?.textContent===name,created.display_name);
  evidence.checks.push('Staff setup Start updates the already-open kiosk');
  await staff.request.put(`${base}/profiles/${created.profile_id}`,{data:{display_name:'Touch Sync Renamed'}});
  await page.waitForFunction(()=>document.querySelector('.standby .identity')?.textContent==='Touch Sync Renamed');
  evidence.checks.push('Library rename updates an already-open kiosk');
  await staff.close();await tap('wake');await tap('type');await page.locator('#typed-message').fill('Me alegra mucho que estés aquí.');await page.locator('#type-form button[type=submit]').tap();await status('Conversation paused');
  await tap('accessibility');await page.locator('#large-text').check();await tap('close-dialog');await layout('large-text');
  await tap('accessibility');await page.locator('#manual-talk').uncheck();await tap('close-dialog');
  await tap('start-conversation');await status('Listening');
  // Close the live socket from within this test page; the app must fail closed and reconnect.
  await page.evaluate(()=>window.testSocket?.close());
  await stopped();await status('Conversation paused');await page.waitForTimeout(1000);
  assert.notEqual(await page.locator('#conversation-status').innerText(),'Listening');
  evidence.checks.push('Socket loss stops capture and reconnect does not restart the microphone');
  // A second context has no dependency on the previous page's local state.
  await page.reload();await page.locator('.standby').waitFor();await tap('wake');
  await layout('restored-person');evidence.checks.push('Reload restores the shared active person');
  // A tone followed by silence exercises the real browser analyser and turn boundary.
  await page.evaluate(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const ctx=new AudioContext(),osc=ctx.createOscillator(),gain=ctx.createGain(),output=ctx.createMediaStreamDestination();
      osc.frequency.value=500;gain.gain.setValueAtTime(.2,ctx.currentTime);gain.gain.setValueAtTime(0,ctx.currentTime+1);
      osc.connect(gain);gain.connect(output);await ctx.resume();osc.start();
      window.testTracks.push(...output.stream.getTracks());
      for(const track of output.stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();ctx.close().catch(()=>{});};}
      return output.stream;
    };
  });
  const nextVoice=page.waitForResponse(r=>r.url().endsWith('/api/speak'));
  await tap('start-conversation');await status('Listening');
  await page.waitForFunction(()=>window.testAudio.length>0||document.querySelector('#conversation-status')?.textContent==='Who is this for?');
  if(await page.locator('[data-action="recipient-visitor"]').isVisible())await tap('recipient-visitor');
  assert.equal((await nextVoice).status(),200);
  await status('Listening');await tap('pause-conversation');await stopped();
  evidence.checks.push('Automatic pause detection submits a turn, plays the voice and resumes listening; touch Pause stops it');
  assert.deepEqual(evidence.errors,[]);evidence.checks.push('No browser JavaScript errors');
  console.log(JSON.stringify({checks:evidence.checks,layouts:evidence.layouts.map(x=>({name:x.name,panes:x.panes}))},null,2));
})().catch(error=>{evidence.failure=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(evidence,null,2));await browser?.close();});
