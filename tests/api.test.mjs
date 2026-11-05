import test from "node:test";
import assert from "node:assert/strict";
import { shimCloudflare, Storage, KV } from "./helpers.mjs";
shimCloudflare();
const {default: worker,Fila} = await import("../worker/src/index.js");
const {makeSessionToken} = await import("../worker/src/lib/auth.js");
const {getRoutineDefs,setState,getState} = await import("../worker/src/lib/store.js");
async function fixture() {
  const def={id:"fixture",name:"Rotina sintética",description:"Não executa nada",schedule:"fixture",prompt:"sensitive-instructions-fixture",defaultOn:true};
  const kv=new KV([["routines",JSON.stringify({fixture:def})],["migrated:v2","true"],["state:fixture","0"]]);
  const storage=new Storage(),object=new Fila({storage},{});
  const env={ROTINAS:kv,FILA:{idFromName:()=>"torre",get:()=>object},JWT_SECRET:"fixture-only-secret-never-real",USERS_JSON:JSON.stringify([{username:"operator"}]),ALICE_API_KEY:"fixture-agent",BRIDGE_API_KEY:"fixture-bridge",ROUTINE_EXECUTION_ENABLED:"true"};
  const token=await makeSessionToken(env,"operator");
  const call=async(path,{method="GET",json,key="user"}={})=>worker.fetch(new Request("https://fixture.test"+path,{method,headers:{...(key==="user"?{Authorization:"Bearer "+token}:key==="agent"?{"X-Agent-Key":env.ALICE_API_KEY}:key==="bridge"?{"X-Bridge-Key":env.BRIDGE_API_KEY}:{}),"Content-Type":"application/json"},body:json===undefined?undefined:JSON.stringify(json)}),env,{waitUntil:()=>{}});
  return {env,kv,storage,object,call};
}
test("migração preserva desligamento existente e deixa KV fora da decisão de execução",async()=>{
  const f=await fixture(); await getRoutineDefs(f.env);assert.equal(await getState(f.env,"fixture",true),false);
  await setState(f.env,"fixture",true);await f.kv.put("state:fixture","0");assert.equal(await getState(f.env,"fixture",false),true);
});
test("chaves têm separação de função, inclusive chamadas diretas à API",async()=>{
  const f=await fixture();
  assert.equal((await f.call("/api/bridge/v2/control",{key:"agent"})).status,401);
  assert.equal((await f.call("/api/agent/routines",{key:"bridge"})).status,401);
  assert.equal((await f.call("/api/bridge/v2/control",{key:"user"})).status,401);
  assert.equal((await f.call("/api/agent/bridge/next",{key:"agent"})).status,410);
});
test("snapshot da ponte não contém instruções, arquivos ou chave",async()=>{
  const f=await fixture(),r=await f.call("/api/bridge/v2/control",{key:"bridge"}),text=await r.text();
  assert.equal(r.status,200);assert(!text.includes("sensitive-instructions"));assert(!text.includes(f.env.ALICE_API_KEY));assert(!text.includes(f.env.BRIDGE_API_KEY));
});
test("gatilho público devolve apenas estado/revisão, sem cache nem instruções",async()=>{
  const f=await fixture(),r=await f.call("/api/routines/gate",{key:"none"}),body=await r.json();
  assert.equal(r.status,200);assert.equal(r.headers.get("Cache-Control"),"no-store, max-age=0");assert.equal(body.protocol,2);
  assert.deepEqual(Object.keys(body.routines[0]).sort(),["id","on","version"]);
});
test("chat livre e tarefas sem homologação estão bloqueados no backend",async()=>{
  const f=await fixture();assert.equal((await f.call("/api/chat",{method:"POST",json:{message:"arbitrary"}})).status,403);
  f.env.ROUTINE_EXECUTION_ENABLED="false";assert.equal((await f.call("/api/tasks",{method:"POST",json:{}})).status,503);
});
test("criar tarefa exige revisão e não aceita comandos ou descrição livre",async()=>{
  const f=await fixture();await setState(f.env,"fixture",true);
  const {routines}=await(await f.call("/api/routines")).json();const body={requestId:"fixture_request_01",routineId:"fixture",version:routines[0].version};
  assert.equal((await f.call("/api/tasks",{method:"POST",json:{...body,description:"comando livre"}})).status,400);
  assert.equal((await f.call("/api/tasks",{method:"POST",json:{...body,version:"old"}})).status,409);
  const a=await f.call("/api/tasks",{method:"POST",json:body}),b=await f.call("/api/tasks",{method:"POST",json:body});
  assert.equal(a.status,201);assert.equal(b.status,200);assert.equal((await a.json()).task.id,(await b.json()).task.id);
});
test("conexão não é apresentada como conclusão ou execução liberada",async()=>{
  const f=await fixture();const status=await(await f.call("/api/health")).json();assert.equal(status.executionEnabled,false);assert.equal(status.chat.configured,false);
  const hb=await f.call("/api/bridge/v2/heartbeat",{key:"bridge",method:"POST",json:{protocol:2,gateway:true,mode:"observe"}});assert.equal(hb.status,200);
  const after=await(await f.call("/api/health")).json();assert.equal(after.bridge.online,true);assert.equal(after.executionEnabled,false);
});
