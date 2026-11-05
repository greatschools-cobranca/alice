import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BridgeState, routineVersion } from "../worker/src/lib/bridge-state.js";
import { Journal } from "../setup/ponte/lib/journal.mjs";
import { Engine, fingerprint } from "../setup/ponte/lib/engine.mjs";
import { transport } from "../setup/ponte/lib/transport.mjs";

export class Storage {
  constructor() { this.map = new Map(); this.tail = Promise.resolve(); this.writes = 0; }
  async get(k) { return structuredClone(this.map.get(k)); }
  async put(k, v) { this.writes++; this.map.set(k, structuredClone(v)); }
  async delete(k) { return this.map.delete(k); }
  async list({ prefix = "", limit = 1000 } = {}) { return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit).map(([k,v]) => [k, structuredClone(v)])); }
  transaction(fn) { const p = this.tail.then(async () => { const snapshot = structuredClone(this.map); try { return await fn(this); } catch (e) { this.map = snapshot; throw e; } }); this.tail = p.catch(() => {}); return p; }
}
const def = { id: "agenda-cobranca", name: "Fixture", description: "Sintética", prompt: "sem ações", schedule: "daily" };
async function fixture() {
  let now = 1000000; const storage = new Storage(), state = new BridgeState(storage, () => now);
  await state.control({ defs: { [def.id]: def }, states: { [def.id]: true } });
  const version = await routineVersion(def);
  const enqueue = (requestId = "request_fixture_0001") => state.enqueue("operator", requestId, def.id, version, { id: "t9999999999999-abcdef", status: "queued" });
  return { state, storage, version, enqueue, tick: v => now += v };
}
test("cliques simultâneos e reconexão devolvem o mesmo pedido", async () => {
  const { state, enqueue } = await fixture();
  const [a,b] = await Promise.all([enqueue(), enqueue()]);
  assert.equal(a.id,b.id); assert.equal(b.duplicate,true);
  const first = await state.next(), resumed = await state.next();
  assert.equal(first.resumed,false); assert.equal(resumed.resumed,true); assert.equal(first.claim,resumed.claim);
});
test("não libera segunda execução após expirar a concessão", async () => {
  const f = await fixture(); const a = await f.enqueue(); await f.enqueue("request_fixture_0002");
  await f.state.next(); f.tick(121000);
  const active = await f.state.next(); assert.equal(active.id,a.id); assert.equal(active.status,"uncertain");
});
test("retenção nunca apaga o recibo de uma execução incerta", async () => {
  const f = await fixture(); const original = await f.enqueue(); await f.state.next(); f.tick(8 * 86400000);
  await f.state.next(); await f.enqueue("request_fixture_new1");
  assert.equal((await f.enqueue()).id, original.id);
  assert.equal((await f.state.next()).id, original.id);
});
test("rotina desligada ou alterada não é entregue", async () => {
  const f = await fixture(); await f.enqueue(); await f.state.setState(def.id,false); assert.equal(await f.state.next(),null);
  await assert.rejects(f.enqueue("request_fixture_0002"),e => e.status === 409);
});
test("estado é imediato; escrita concorrente de cadastro exige revisão", async () => {
  const f = await fixture(); const control = await f.state.control();
  await f.state.setState(def.id,false);
  await assert.rejects(f.state.replaceDefs(control.defs,control.revision),e => e.status === 409);
  assert.equal((await f.state.control()).states[def.id],false);
});
test("confirmação repetida é idempotente e exige a mesma concessão", async () => {
  const f = await fixture(); await f.enqueue(); const j = await f.state.next();
  await assert.rejects(f.state.result(j.id,"wrong",{status:"done"}),e => e.status === 409);
  await f.state.result(j.id,j.claim,{status:"accepted",runId:"manual:fixture"});
  assert.equal((await f.state.get(j.id)).status,"accepted");
  await f.state.result(j.id,j.claim,{status:"done"});
  assert.equal((await f.state.result(j.id,j.claim,{status:"done"})).status,"done");
  assert.equal(await f.state.next(),null);
});
test("versão é SHA-256, estável na ordem dos campos e não inclui instruções", async () => {
  const a = await routineVersion(def); assert.match(a,/^[0-9a-f]{64}$/);
  assert.equal(a,await routineVersion(Object.fromEntries(Object.entries(def).reverse())));
  assert.notEqual(a,await routineVersion({...def,prompt:"alterado"}));
});
test("heartbeat grava no máximo a cada 30s se nada mudou", async () => {
  const f = await fixture(); await f.state.heartbeat(true); const n=f.storage.writes;
  for(let i=0;i<50;i++) await f.state.heartbeat(true);
  assert.equal(f.storage.writes,n); f.tick(30000); await f.state.heartbeat(true); assert.equal(f.storage.writes,n+1);
});
test("fila e recibos têm limite e não descartam pedido incerto", async () => {
  const f = await fixture(); for(let i=0;i<100;i++) await f.enqueue(`request_fixture_${String(i).padStart(4,"0")}`);
  await assert.rejects(f.enqueue("request_fixture_9999"),e => e.status===429);
});
test("transport rejeita HTML 200, redirect, caminho arbitrário e origem com senha", async () => {
  assert.throws(()=>transport("https://user:secret@example.test/","fixture"));
  const html=transport("https://example.test/","fixture",async(_,opts)=>{assert.equal(opts.redirect,"error");return new Response("<html>login</html>",{headers:{"content-type":"text/html"}});});
  await assert.rejects(html("/status"),/torre_invalid_json/);
  await assert.rejects(html("/../../evil"),/invalid_api_path/);
  const redirect=transport("https://example.test/","fixture",async()=>new Response(null,{status:302,headers:{location:"https://other.test"}}));
  await assert.rejects(redirect("/status"),/torre_http/);
});
test("journal sobrevive a término abrupto com intenção e outbox preservadas", () => {
  const dir=mkdtempSync(join(tmpdir(),"torre-test-")), path=join(dir,"j.sqlite");
  try {
    const moduleUrl=new URL("../setup/ponte/lib/journal.mjs",import.meta.url).href;
    const r=spawnSync(process.execPath,["--input-type=module","-e",`import {Journal} from ${JSON.stringify(moduleUrl)};const j=new Journal(${JSON.stringify(path)});j.put({id:'fixture',phase:'dispatching'},{claim:'c',status:'uncertain'});process.exit(137);`]);
    assert.equal(r.status,137);
    const j=new Journal(path); assert.equal(j.get("fixture").phase,"dispatching"); assert.equal(j.pendingResults().length,1); j.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("perda de resposta do gateway nunca reenvia cron.run", async () => {
  const dir=mkdtempSync(join(tmpdir(),"torre-engine-")), journal=new Journal(join(dir,"j.sqlite"));
  try {
    const native={id:"11111111-1111-1111-1111-111111111111",enabled:true,payload:{kind:"agentTurn",message:"fixture"},state:{}};
    let calls=0; const job={id:"r"+"a".repeat(32),claim:"lease",routineId:def.id,version:"fixture",status:"claimed",resumed:false};
    const api=async path => path==="/control"?{protocol:2,routines:[{id:def.id,on:true,version:"fixture"}]}:{ok:true,id:job.id,status:"uncertain"};
    const rpc={call:async method=>{if(method==="cron.list")return{jobs:[native]};calls++;throw new Error("reply_lost");}};
    const e=new Engine({api,rpc,journal,mappings:{[def.id]:{version:"fixture",manualJobId:native.id,fingerprint:fingerprint(native),guardVerified:true}}});
    await e.handle(job); assert.equal(calls,1); assert.equal(journal.get(job.id).phase,"uncertain");
    await e.handle({...job,resumed:true,status:"uncertain"}); assert.equal(calls,1);
    await e.flush(); assert.equal(journal.pendingResults().length,0);
  } finally {journal.close();rmSync(dir,{recursive:true,force:true});}
});
test("concessão retomada sem diário vira incerta, sem executar", async () => {
  let result; const journal={get:()=>null,put:(record,r)=>result=r};
  const e=new Engine({journal,mappings:{},api:()=>{throw Error("unexpected")},rpc:{call:()=>{throw Error("unexpected")}}});
  await e.handle({id:"r"+"b".repeat(32),claim:"lease",status:"claimed",resumed:true}); assert.equal(result.status,"uncertain");
});
test("aceitação aguarda o recibo nativo exato, sem executar novamente", async () => {
  const id="r"+"c".repeat(32),job={id,claim:"lease",routineId:def.id,version:"v",status:"accepted",resumed:true};
  let record={...job,phase:"accepted",runId:"manual:expected",acceptedAt:Date.now()},result;
  const journal={get:()=>record,put:(r,value)=>{record={...r};result=value;}};
  let matching=false;
  const rpc={call:async(method)=>{assert.equal(method,"cron.runs");return{entries:[{action:"finished",runId:matching?"manual:expected":"manual:unrelated",status:"ok"}]};}};
  const e=new Engine({journal,rpc,mappings:{[def.id]:{version:"v",manualJobId:"fixture"}}});
  await e.handle(job);assert.equal(result.status,"accepted");matching=true;await e.handle(job);assert.equal(result.status,"done");
});
test("gatilho sem homologação impede a chamada mutante", async () => {
  const native={id:"11111111-1111-1111-1111-111111111111",enabled:true,payload:{message:"fixture"},state:{}},job={id:"r"+"d".repeat(32),claim:"lease",routineId:def.id,version:"v",status:"claimed"};
  let record,result;
  const journal={get:()=>record,put:(r,value)=>{record={...r};if(value)result=value;}};
  const e=new Engine({journal,mappings:{[def.id]:{version:"v",manualJobId:native.id,fingerprint:fingerprint(native),guardVerified:false}},api:async()=>({protocol:2,routines:[{id:def.id,on:true,version:"v"}]}),rpc:{call:async(method)=>{assert.equal(method,"cron.list");return{jobs:[native]};}}});
  await e.handle(job);assert.equal(result.status,"rejected");assert.equal(result.reason,"version");
});
