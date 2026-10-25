import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSession } from '../../care/speech.js';

const metadata = { turn_id: 'turn-1', person_id: 'person-1', source_language: 'es', target_language: 'en' };
function harness() {
  const states=[], results=[], errors=[];
  globalThis.speechSynthesis={ cancel(){}, getVoices(){return [];} };
  return { session:new SpeechSession(s=>states.push(s),r=>results.push(r),e=>errors.push(e)), states, results, errors };
}
test('a cancelled request cannot deliver a late translation', async()=>{
  const {session,results}=harness();let resolve;
  globalThis.fetch=()=>new Promise(r=>resolve=r);
  const pending=session.typed('Hola',metadata);
  session.cancel();
  resolve({ok:true,json:async()=>({...metadata,transcript:'Hola',translation:'Hello'})});
  await pending;assert.equal(results.length,0);assert.equal(session.state,'ready');
});
test('a response from a different person is rejected',async()=>{
  const {session,results,errors}=harness();
  globalThis.fetch=async()=>({ok:true,json:async()=>({...metadata,person_id:'someone-else',transcript:'Hola',translation:'Hello'})});
  await session.typed('Hola',metadata);
  assert.equal(results.length,0);assert.match(errors[0],/did not match/);
});
test('translation failure retains a valid transcript without claiming translation',async()=>{
  const {session,results,errors}=harness();
  globalThis.fetch=async()=>({ok:false,json:async()=>({...metadata,transcript:'Hola',error:'Translation unavailable'})});
  await session.typed('Hola',metadata);
  assert.equal(results[0].transcript,'Hola');assert.equal(results[0].translation,null);assert.match(errors[0],/unavailable/);
});
test('a late microphone permission grant after stop closes its tracks',async()=>{
  const {session,states}=harness();let grant;let stopped=0;
  Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)}},configurable:true});
  globalThis.MediaRecorder=class {};
  const pending=session.start(metadata);session.cancel();
  grant({getTracks:()=>[{stop(){stopped++;}}]});await pending;
  assert.equal(stopped,1);assert.ok(!states.includes('listening'));
});
test('no matching voice produces readable recovery instead of the wrong language',()=>{
  const {session,errors}=harness();session.speak('Hola','es');
  assert.equal(session.state,'ready');assert.match(errors[0],/voice for this language/);
});
test('a valid response returns original words and translation for the current turn',async()=>{
  const {session,results,errors}=harness();
  globalThis.fetch=async()=>({ok:true,json:async()=>({...metadata,transcript:'Hola',translation:'Hello'})});
  await session.typed('Hola',metadata);
  assert.equal(results.length,1);assert.equal(results[0].example,false);assert.equal(results[0].translation,'Hello');assert.equal(errors.length,0);
});
test('detection returns original words without selecting a target language',async()=>{
  const {session,results}=harness();
  const meta={...metadata,stage:'detect',source_language:'auto',target_language:undefined};
  globalThis.fetch=async()=>({ok:true,json:async()=>({turn_id:meta.turn_id,person_id:meta.person_id,transcript:'Bonjour',detected_language:'fr',detection_certain:true})});
  await session.typed('Bonjour',meta);
  assert.equal(results[0].detected_language,'fr');assert.equal(results[0].translation,null);assert.equal(results[0].target_language,undefined);
});
test('missing detection certainty cannot silently choose a direction',async()=>{
  const {session,results}=harness();
  globalThis.fetch=async()=>({ok:true,json:async()=>({...metadata,transcript:'Okay',detected_language:'en'})});
  await session.typed('Okay',{...metadata,stage:'detect'});
  assert.equal(results[0].detection_certain,false);
});
test('a translation in the wrong output language is rejected',async()=>{
  const {session,results,errors}=harness();
  globalThis.fetch=async()=>({ok:true,json:async()=>({...metadata,transcript:'Hola',translation:'Bonjour',target_language:'fr'})});
  await session.typed('Hola',{...metadata,stage:'translate'});
  assert.equal(results.length,0);assert.match(errors[0],/different output language/);
});
test('stopping playback settles its completion without restarting listening',async()=>{
  const {session}=harness();
  globalThis.SpeechSynthesisUtterance=class {};
  globalThis.speechSynthesis={cancel(){},getVoices(){return [{lang:'en-US'}];},speak(){}};
  const finished=session.speak('Hello','en');session.cancel();
  assert.equal(await finished,false);assert.equal(session.state,'ready');
});
