import { registerHooks } from "node:module";
export function shimCloudflare() {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }", shortCircuit: true };
      return next(specifier, context);
    },
  });
}
export class Storage {
  constructor() { this.map = new Map(); this.tail = Promise.resolve(); this.writes = 0; }
  async get(k) { return structuredClone(this.map.get(k)); }
  async put(k,v) { this.writes++; this.map.set(k,structuredClone(v)); }
  async delete(k) { if(Array.isArray(k)) {k.forEach(v=>this.map.delete(v));return;} return this.map.delete(k); }
  async list({prefix="",limit=1000}={}) {return new Map([...this.map].filter(([k])=>k.startsWith(prefix)).sort().slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));}
  transaction(fn) {const p=this.tail.then(async()=>{const old=structuredClone(this.map);try{return await fn(this);}catch(e){this.map=old;throw e;}});this.tail=p.catch(()=>{});return p;}
}
export class KV {
  constructor(entries=[]) {this.map=new Map(entries);}
  async get(k,type) {const v=this.map.get(k);return v===undefined?null:type==="json"?JSON.parse(v):v;}
  async put(k,v) {this.map.set(k,v);}
  async delete(k) {this.map.delete(k);}
}
