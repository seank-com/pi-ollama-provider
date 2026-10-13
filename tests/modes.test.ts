import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { parseOllamaProviderConfig } from "../src/config.ts";
import { OBSERVABILITY_CAPABILITY_REQUEST, OBSERVABILITY_CAPABILITY_REPLY, queryObservabilityPolicy } from "../src/observability.ts";
import { streamOllamaChat, type PiAssistantEvent, type PiStreamOptions, type StreamDependencies } from "../src/stream.ts";
import { fixturePolicy } from "./fixtures/policy.ts";

const model = {id:"fixture:latest",provider:"ollama"};
const context = {systemPrompt:"Fixture",tools:[{name:"inspect",description:"Inspect",parameters:{type:"object",properties:{},required:[]}}],messages:[{role:"user",content:"Inspect",timestamp:1}]};
const body = () => new Response(JSON.stringify({model:model.id,message:{role:"assistant",tool_calls:[{function:{name:"inspect",arguments:{}}}]},done:true,done_reason:"stop"})+"\n");
async function run(overrides: Partial<StreamDependencies> = {}, options: PiStreamOptions = {}, ctx: unknown = context) {
  let sends=0;const events:PiAssistantEvent[]=[];
  await streamOllamaChat({fetch:async()=>{sends++;return body();},baseUrl:"http://fixture.test:11434",keepAlive:null,streamIdleMs:1000,models:new Map([[model.id,{id:model.id,contextWindow:8192,reasoning:false}]]),...overrides},model,ctx,options,{push:event=>events.push(event),end(){}});
  const terminal=events.at(-1)!;assert.ok(terminal.type==="done"||terminal.type==="error");
  return {sends,terminal,message:terminal.type==="done"?terminal.message:(terminal as any).error};
}
test("mode configuration defaults to standalone, validates both modes, and rejects invalid values",()=>{
  const raw={schemaVersion:1,baseUrl:"http://fixture.test:11434",models:{[model.id]:{displayName:"Fixture",contextWindow:8192,maxOutputTokens:1024,reasoning:false}}};
  const parse=(mode?:unknown)=>parseOllamaProviderConfig(JSON.stringify({...raw,...(mode===undefined?{}:{mode})}),"fixture");
  assert.equal(parse().mode,"standalone");assert.equal(parse("standalone").mode,"standalone");assert.equal(parse("require-observability").mode,"require-observability");
  for(const invalid of [null,"strict",true,1,{},[]]) assert.throws(()=>parse(invalid),(error:any)=>error.code==="CONFIG_INVALID");
});
test("standalone inference and compaction preparation work without a callback or policy",async()=>{
  for(const ctx of [context,{messages:[{role:"user",content:"Summarize the earlier conversation",timestamp:1}]}]) {
    const result=await run({}, {}, ctx);assert.equal(result.sends,1);assert.equal(result.terminal.type,"done");
    assert.deepEqual(result.message.content[0].arguments,{});
  }
});
test("callback presence alone cannot satisfy strict mode",async()=>{
  let hooks=0;const result=await run({mode:"require-observability"},{onPayload:()=>{hooks++;}});
  assert.equal(result.sends,0);assert.equal(hooks,0);assert.match(result.message.errorMessage,/^OBSERVABILITY_UNAVAILABLE/);
});
test("strict inference and compaction preparation require a callback even with a live policy",async()=>{
  for(const ctx of [context,{messages:[{role:"user",content:"Summarize",timestamp:1}]}]) {
    const result=await run({mode:"require-observability",observability:()=>fixturePolicy()},{},ctx);
    assert.equal(result.sends,0);assert.match(result.message.errorMessage,/^PAYLOAD_HOOK_UNAVAILABLE/);
  }
});
test("strict valid policy and hook send once; policy revocation during a hook prevents egress",async()=>{
  const policy=fixturePolicy();let hooks=0;
  const valid=await run({mode:"require-observability",observability:()=>policy},{onPayload:()=>{hooks++;}});
  assert.equal(valid.sends,1);assert.equal(hooks,1);
  const revoked=await run({mode:"require-observability",observability:()=>policy},{onPayload:async()=>{(policy as any).ready=false;}});
  assert.equal(revoked.sends,0);assert.match(revoked.message.errorMessage,/^OBSERVABILITY_UNAVAILABLE/);
});
test("bad supplied hooks never send an unprocessed request in either mode",async()=>{
  for(const mode of ["standalone","require-observability"] as const) for(const hook of [null,()=>null,()=>{throw new Error("fixture");},async()=>{throw new Error("fixture");},(payload:any)=>({...payload,truncate:true}),(payload:any)=>({...payload,options:{num_ctx:999999}})]) {
    const result=await run({mode,observability:()=>fixturePolicy()},{onPayload:hook as any});assert.equal(result.sends,0);assert.match(result.message.errorMessage,/^PAYLOAD_REJECTED/);
  }
});
test("decorated tools with active policy make no provider recovery request",async()=>{
  const result=await run({observability:()=>fixturePolicy()}, {onPayload:(payload:any)=>({...payload,tools:payload.tools.map((tool:any)=>({...tool,function:{...tool.function,parameters:{...tool.function.parameters,required:["intent"]}}}))})});
  assert.equal(result.sends,1);assert.deepEqual(result.message.content[0].arguments,{});
});
test("policy discovery is synchronous and rejects absent, incompatible, unready and duplicate responders",()=>{
  const emitter=new EventEmitter();const bus={emit:(channel:string,data:unknown)=>{emitter.emit(channel,data);},on:(channel:string,handler:(data:unknown)=>void)=>{emitter.on(channel,handler);return()=>{emitter.off(channel,handler);};}};
  assert.equal(queryObservabilityPolicy(bus),undefined);assert.equal(emitter.listenerCount(OBSERVABILITY_CAPABILITY_REPLY),0);
  for(const policy of [{...fixturePolicy(),version:2},{...fixturePolicy(),ready:false},{...fixturePolicy(),sanitizeIntent:undefined}]) {
    const handler=(request:any)=>bus.emit(OBSERVABILITY_CAPABILITY_REPLY,{version:1,requestId:request.requestId,capability:policy});emitter.on(OBSERVABILITY_CAPABILITY_REQUEST,handler);assert.equal(queryObservabilityPolicy(bus),undefined);emitter.off(OBSERVABILITY_CAPABILITY_REQUEST,handler);
  }
  const good=(request:any)=>bus.emit(OBSERVABILITY_CAPABILITY_REPLY,{version:1,requestId:request.requestId,capability:fixturePolicy()});emitter.on(OBSERVABILITY_CAPABILITY_REQUEST,good);assert.equal(queryObservabilityPolicy(bus)?.ready,true);emitter.on(OBSERVABILITY_CAPABILITY_REQUEST,good);assert.equal(queryObservabilityPolicy(bus),undefined);
});
