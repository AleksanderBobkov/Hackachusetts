import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientFor, TurnBoundary } from '../../care/routing.js';
const preferences={resident:'es',visitor:'en'};
test('routes each utterance independently without assuming alternating speakers',()=>{
  assert.equal(recipientFor('es',preferences),'visitor');
  assert.equal(recipientFor('es-MX',preferences),'visitor');
  assert.equal(recipientFor('en-US',preferences),'resident');
});
test('asks for a recipient for a third, unknown, or uncertain language',()=>{
  assert.equal(recipientFor('fr',preferences),null);
  assert.equal(recipientFor(null,preferences),null);
  assert.equal(recipientFor('en',preferences,false),null);
});
test('matching output preferences do not invent an identity',()=>{
  assert.equal(recipientFor('en',{resident:'en',visitor:'en'}),null);
});
test('a brief pause does not finish a turn; a sustained pause after speech does',()=>{
  const detector=new TurnBoundary(0);
  for(let time=100;time<=1000;time+=100)assert.equal(detector.sample(.05,time),'listen');
  assert.equal(detector.sample(0,2000),'listen');
  assert.equal(detector.sample(0,3200),'finish');
});
test('brief noise is not a speech turn and prolonged silence pauses capture',()=>{
  const detector=new TurnBoundary(0);
  detector.sample(.05,100);
  assert.equal(detector.sample(0,3000),'listen');
  assert.equal(detector.sample(0,15000),'no-speech');
});
