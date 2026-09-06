import test from 'node:test';
import assert from 'node:assert/strict';
import {caveShelter,aimedAt} from '../src/shelter.js';
test('high vault stops weather while open shaft and surface do not',()=>{
  const roof=(_x,y)=>y>-7&&y<0?1:-1;
  assert.equal(caveShelter(roof,()=>0,{x:0,y:-14,z:0}),1);
  assert.equal(caveShelter(()=>-1,()=>0,{x:0,y:-14,z:0}),0);
  assert.equal(caveShelter(roof,()=>0,{x:0,y:1.7,z:0}),0);
});
test('near door behind the player does not intercept the hand',()=>{
  const p={x:0,y:1,z:0},dir={x:0,y:0,z:-1};
  assert.equal(aimedAt(p,dir,{x:0,y:1,z:2}),false);
  assert.equal(aimedAt(p,dir,{x:0,y:1,z:-2}),true);
});
