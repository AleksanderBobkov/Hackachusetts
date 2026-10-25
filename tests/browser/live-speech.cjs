// Explicit opt-in live provider test. The API key remains in the backend, never this script.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/mmbur/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:18765';
const out=path.resolve('review/live');fs.mkdirSync(out,{recursive:true});
const evidence={checks:[],calls:[],errors:[]};let browser;
(async()=>{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1280,height:720},hasTouch:true,permissions:['microphone']});
  const page=await context.newPage();page.setDefaultTimeout(60000);
  const caps=await (await page.request.get(`${base}/api/capabilities`)).json();
  assert.equal(caps.provider,'openai');assert.equal(caps.simulated,false);assert.equal(caps.tts,true);assert.equal(caps.translation,true);
  evidence.provider=caps.provider;evidence.simulated=caps.simulated;
  async function speechRequest(text,language){
    const started=Date.now();const response=await page.request.post(`${base}/api/speak`,{data:{text,language},timeout:35000});
    evidence.calls.push({endpoint:'/api/speak',language,status:response.status(),ms:Date.now()-started});
    if(!response.ok())throw new Error(`Live speech failed: ${await response.text()}`);
    const audio=await response.body();assert.ok(audio.length>1000);return audio;
  }
  // Known synthetic Spanish speech will stand in for microphone input in the browser.
  const sample=await speechRequest('Hola, me alegra mucho verte. ¿Cómo estás hoy?','es');
  fs.writeFileSync(path.join(out,'spanish-test.mp3'),sample);
  evidence.checks.push('Live /api/speak returns nonempty MP3 for Spanish synthetic test speech');
  await context.addInitScript(({audio})=>{
    window.testTracks=[];window.testAudio=[];
    navigator.mediaDevices.getUserMedia=async()=>{
      const ctx=new AudioContext();const bytes=Uint8Array.from(atob(audio),c=>c.charCodeAt(0));
      const buffer=await ctx.decodeAudioData(bytes.buffer);const source=ctx.createBufferSource();source.buffer=buffer;source.loop=true;
      const output=ctx.createMediaStreamDestination();source.connect(output);await ctx.resume();source.start();
      window.testTracks.push(...output.stream.getTracks());window.testSpeechDuration=buffer.duration;
      output.stream.getTracks().forEach(track=>{const stop=track.stop.bind(track);track.stop=()=>{stop();ctx.close().catch(()=>{});};});
      return output.stream;
    };
    const NativeAudio=window.Audio;window.Audio=function(...args){const audio=new NativeAudio(...args);audio.addEventListener('ended',()=>audio.testCompleted=true);window.testAudio.push(audio);return audio;};
  },{audio:sample.toString('base64')});
  page.on('pageerror',e=>evidence.errors.push(e.message));
  page.on('response',async response=>{
    if(!/\/api\/(turn|speak)$/.test(new URL(response.url()).pathname))return;
    const entry={endpoint:new URL(response.url()).pathname,status:response.status()};evidence.calls.push(entry);
    if(entry.endpoint==='/api/turn')try{entry.result=await response.json();}catch{}
  });
  const tap=action=>page.locator(`[data-action="${action}"]`).tap();
  const status=text=>page.waitForFunction(text=>document.querySelector('#conversation-status')?.textContent===text,text,{timeout:90000});
  await page.goto(base);await page.locator('.person-open,.standby').first().waitFor();
  if(await page.locator('.person-open').count())await page.locator('.person-open').first().tap();
  await page.locator('.standby').waitFor();await tap('wake');await tap('accessibility');
  await page.locator('#manual-talk').check();await tap('close-dialog');
  await tap('manual-visitor');await status('Listening');
  const seconds=await page.evaluate(()=>window.testSpeechDuration);await page.waitForTimeout((seconds+.2)*1000);
  const detectionResponse=page.waitForResponse(r=>r.url().endsWith('/api/turn'));
  await tap('finish-turn');const detected=await detectionResponse;const detection=await detected.json();
  assert.equal(detected.status(),200,JSON.stringify(detection));assert.ok(detection.transcript.trim());assert.equal(detection.simulated,false);
  await status('Conversation paused');
  const translation=await page.locator('.translated .caption-text').innerText();
  assert.ok(translation.trim());assert.ok(/glad|happy|pleas|nice|great/i.test(translation),translation);
  assert.ok(await page.evaluate(()=>window.testAudio.some(a=>a.testCompleted)),'Live TTS must finish playing');
  assert.ok(await page.evaluate(()=>window.testTracks.every(t=>t.readyState==='ended')));
  evidence.recording={transcript:detection.transcript,detected_language:detection.detected_language,translation};
  evidence.checks.push('Touch Speak/Finish -> MediaRecorder -> live transcription -> English translation -> live voice playback');
  await page.screenshot({path:path.join(out,'recorded-translation.png')});
  await tap('type');await page.locator('#typed-message').fill("I'm happy to see you. How are you today?");
  const reverseVoice=page.waitForResponse(r=>r.url().endsWith('/api/speak'));
  await page.locator('#type-form button[type=submit]').tap();
  assert.equal((await reverseVoice).status(),200);await status('Conversation paused');
  const reverse=await page.locator('.translated .caption-text').innerText();assert.ok(/alegr|feliz|content|gusto/i.test(reverse),reverse);
  evidence.reverseTranslation=reverse;evidence.checks.push('Touch Type/Translate -> live language detection -> Spanish translation -> live voice playback');
  await page.screenshot({path:path.join(out,'typed-translation.png')});
  // Replay starts a live voice request. The on-screen Pause action must cancel it.
  const pending=page.waitForRequest(r=>r.url().endsWith('/api/speak'));
  await tap('replay');await pending;await tap('pause-conversation');await status('Conversation paused');
  assert.ok(await page.evaluate(()=>window.testAudio.every(a=>a.paused)));
  evidence.checks.push('Read again requests live TTS and Pause cancels preparation/playback');
  assert.deepEqual(evidence.errors,[]);console.log(JSON.stringify(evidence,null,2));
})().catch(error=>{evidence.failure=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(evidence,null,2));await browser?.close();});
