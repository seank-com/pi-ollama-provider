import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OLLAMA_API_ID, OLLAMA_PROVIDER_NAME } from "@seank/pi-ollama-provider/contract";

const project=process.cwd();
const modelId="fixture:latest";
const recorded:Array<{path:string;body:any}>=[];
let tools=false;
let heldPath="fixture.txt";
let explanationDelay=0;
let explanationText="Read the fixture file.";
const response=(res:any,content:string)=>res.end(JSON.stringify({model:modelId,message:{role:"assistant",content},done:true,done_reason:"stop",prompt_eval_count:5,eval_count:2})+"\n");
const server=createServer((req,res)=>{
  let raw="";req.setEncoding("utf8");req.on("data",chunk=>{raw+=chunk;});req.on("end",()=>{
    const body=JSON.parse(raw);recorded.push({path:req.url!,body});res.setHeader("content-type","application/x-ndjson");
    if(req.url==="/api/show") {res.end(JSON.stringify({capabilities:["completion","tools"],model_info:{"fixture.context_length":8192}}));return;}
    if(body.messages[0]?.content.startsWith("Your previous tool call omitted")) {
      const repeated=()=>{const held=JSON.parse(body.messages.at(-1).content).previousToolCall;res.end(JSON.stringify({model:modelId,message:{role:"assistant",tool_calls:[{function:{name:held.name,arguments:{...held.arguments,intent:explanationText}}}]},done:true,done_reason:"stop",prompt_eval_count:5,eval_count:2})+"\n");};
      if(explanationDelay) setTimeout(repeated,explanationDelay).unref(); else repeated();return;
    }
    if(tools && body.tools?.length && !body.messages.some((message:any)=>message.role==="tool")) {
      res.end(JSON.stringify({model:modelId,message:{role:"assistant",tool_calls:[{function:{name:"read",arguments:{path:heldPath}}}]},done:true,done_reason:"stop",prompt_eval_count:5,eval_count:2})+"\n");return;
    }
    response(res,"Fixture answer.");
  });
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const baseUrl=`http://127.0.0.1:${(server.address() as any).port}`;
const configDir=join(project,".pi/ollama-provider");mkdirSync(configDir,{recursive:true,mode:0o700});
const rawConfig={schemaVersion:1,mode:"standalone",baseUrl,timeouts:{metadataMs:1000,streamIdleMs:60000},models:{[modelId]:{displayName:"Fixture",contextWindow:8192,maxOutputTokens:1024,reasoning:false}}};
writeFileSync(join(configDir,"config.json"),JSON.stringify(rawConfig),{mode:0o600});
writeFileSync(join(project,"fixture.txt"),"Fixture source\n");
for(const name of ["@earendil-works","@seank/pi-observability","@seank/pi-markdown-datastore","@seank/pi-telegram-owner"]) assert.equal(existsSync(join(project,"node_modules",name)),false,name);
assert.equal(OLLAMA_PROVIDER_NAME,"ollama");assert.equal(OLLAMA_API_ID,"pi-ollama-chat");
const host=process.env.TEST_PI_HOST!;
const {loadExtensions,clearExtensionCache}=await import(pathToFileURL(join(host,"dist/core/extensions/loader.js")).href);
const {createEventBus}=await import(pathToFileURL(join(host,"dist/core/event-bus.js")).href);
const bus=createEventBus();
const root=join(project,"node_modules/@seank/pi-ollama-provider");
const entry=join(root,"dist/index.js");
assert.equal(existsSync(join(root,"dist/recovery.js")),false,"removed recovery must not survive incremental builds");
const strictEntry=join(project,"strict.ts");
writeFileSync(strictEntry,'import {createOllamaExtension} from "@seank/pi-ollama-provider";export default createOllamaExtension({mode:"require-observability"});');
const entries:any[]=[];const statuses:any[]=[];
const ctx:any={sessionManager:{getBranch:()=>entries},ui:{setStatus:(...args:any[])=>statuses.push(args)}};
const fire=async(loaded:any,name:string,event:any={})=>{let result:any;for(const extension of loaded.extensions)for(const handler of extension.handlers.get(name)??[]){const value=await handler(event,ctx);if(value!==undefined)result=value;}return result;};
const load=async(paths:string[])=>{clearExtensionCache();const loaded=await loadExtensions(paths,project,bus);assert.deepEqual(loaded.errors,[]);loaded.runtime.appendEntry=(customType:string,data:unknown)=>entries.push({type:"custom",customType,data});await fire(loaded,"session_start");await fire(loaded,"resources_discover");return loaded;};
const provider=(loaded:any)=>{const regs=loaded.runtime.pendingProviderRegistrations;assert.equal(regs.length,1);assert.equal(regs[0].name,"ollama");return regs[0].config;};
const chats=()=>recorded.filter(row=>row.path==="/api/chat");
const context={systemPrompt:"Fixture",tools:[{name:"read",description:"Read",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}],messages:[{role:"user",content:"Read packed-secret",timestamp:1}]};
const run=async(config:any,options:any={},requestContext:any=context)=>await config.streamSimple({id:modelId,provider:"ollama"},requestContext,options).result();

try {
  const standalone=await load([entry]);const registration=provider(standalone);
  assert.equal((await run(registration)).stopReason,"stop");
  assert.equal((await run(registration,{}, {messages:[{role:"user",content:"Summarize conversation",timestamp:1}]})).stopReason,"stop");
  tools=true;const ordinary=await run(registration);assert.equal(ordinary.stopReason,"toolUse");assert.deepEqual(ordinary.content[0].arguments,{path:"fixture.txt"});tools=false;
  let hooks=0;const before=chats().length;
  const failed=await run(registration,{onPayload:async()=>{hooks++;throw new Error("fixture");}});assert.match(failed.errorMessage,/^PAYLOAD_REJECTED/);assert.equal(hooks,1);assert.equal(chats().length,before);
  await fire(standalone,"session_shutdown");
  const strict=await load([strictEntry]);const strictRegistration=provider(strict);
  const absent=await run(strictRegistration,{onPayload:()=>undefined});assert.match(absent.errorMessage,/^OBSERVABILITY_UNAVAILABLE/);assert.equal(chats().length,before);
  assert.ok(statuses.some(row=>row[1]?.includes("OBSERVABILITY_UNAVAILABLE")));
  await fire(strict,"session_shutdown");

  if(process.env.TEST_OBSERVABILITY_ROOT) {
    const ownerRoot=process.env.TEST_OBSERVABILITY_ROOT;
    const ownerContract=await import(pathToFileURL(join(ownerRoot,"dist/contract.js")).href);
    const consumerContract=await import(pathToFileURL(join(root,"dist/observability.js")).href);
    for(const key of ["OBSERVABILITY_CAPABILITY_REQUEST","OBSERVABILITY_CAPABILITY_REPLY","TOOL_INTENT_ARGUMENT"])assert.equal(consumerContract[key],ownerContract[key]);
    const ownerEntry=join(ownerRoot,"dist/index.js");
    for(const order of [[strictEntry,ownerEntry],[ownerEntry,strictEntry]]) {
      entries.splice(0);tools=true;heldPath="fixture.txt";
      const pair=await load(order);const registration=provider(pair);
      ctx.model={id:modelId,provider:"ollama"};ctx.modelRegistry={streamSimple:(model:any,context:any,options:any)=>registration.streamSimple(model,context,options)};
      const prior=chats().length;
      const missingHook=await run(registration);assert.match(missingHook.errorMessage,/^PAYLOAD_HOOK_UNAVAILABLE/);assert.equal(chats().length,prior);
      let hooks=0;
      const onPayload=async(payload:any)=>{hooks++;return(await fire(pair,"before_provider_request",{payload}));};
      const runPrepared=async(options:any)=>{const prepared=await fire(pair,"context_with_system",{messages:[{role:"system",content:context.systemPrompt,toolsAdded:context.tools,timestamp:0},...context.messages]});return run(registration,options,{messages:prepared.messages});};
      const recovered=await runPrepared({onPayload});assert.equal(recovered.stopReason,"toolUse");assert.equal(hooks,1);
      assert.equal(recovered.content[0].arguments.intent,undefined);
      assert.equal(chats().length-prior,1,"provider never retries");
      const finalized=await fire(pair,"message_end",{message:recovered});
      const sent=chats().slice(prior);assert.equal(sent.length,2);assert.equal(JSON.stringify(sent).includes("packed-secret"),false);
      assert.equal(sent[1].body.tools.length,1);assert.ok(entries.some(row=>row.customType==="tool-intent-retry"&&row.data.outcome==="accepted"));
      assert.equal(Object.hasOwn(finalized.message.content[0].arguments,"intent"),false);
      const call=finalized.message.content[0];assert.equal(await fire(pair,"tool_call",{toolCallId:call.id,toolName:call.name,input:call.arguments}),undefined);
      assert.ok(entries.some(row=>row.customType==="tool-intent"&&row.data.toolCallId===call.id));
      assert.equal(JSON.stringify(entries).includes("packed-secret"),false);
      // The actual owner's rejection leaves the call unaudited and blocked.
      explanationText="Read the file at /srv/fixture/config.json.";
      const rejected=await runPrepared({onPayload});assert.equal(rejected.stopReason,"toolUse");
      const rejectedCall=rejected.content[0];assert.equal(Object.hasOwn(rejectedCall.arguments,"intent"),false);
      await fire(pair,"message_end",{message:rejected});assert.equal((await fire(pair,"tool_call",{toolCallId:rejectedCall.id,toolName:rejectedCall.name,input:rejectedCall.arguments})).block,true);
      assert.ok(!entries.some(row=>row.customType==="tool-intent"&&row.data.toolCallId===rejectedCall.id));
      assert.ok(entries.some(row=>row.customType==="tool-intent-retry"&&row.data.reason==="intent_path"));
      explanationText="Read the fixture file.";
      // Cancellation while the corrective call is pending retires all calls.
      explanationDelay=60_000;const controller=new AbortController();const priorRecovery=chats().length;
      ctx.signal=controller.signal;const cancelled=runPrepared({onPayload,signal:controller.signal}).then(message=>fire(pair,"message_end",{message}));const deadline=Date.now()+2000;
      while(chats().length<priorRecovery+2) {assert.ok(Date.now()<deadline,"retry must start promptly");await new Promise(resolve=>setTimeout(resolve,5));}
      controller.abort();assert.equal(await cancelled,undefined);ctx.signal=undefined;
      await fire(pair,"agent_settled");explanationDelay=0;
      tools=false;const prepared=await run(registration,{onPayload},{messages:[{role:"user",content:"Summarize packed-secret",timestamp:1}]});assert.equal(prepared.stopReason,"stop");
      const thrown=await run(registration,{onPayload:()=>{throw new Error("fixture");}});assert.match(thrown.errorMessage,/^PAYLOAD_REJECTED/);
      // Teardown retires pending hooks and invalidates the captured registration.
      let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
      const waiting=run(registration,{onPayload:()=>{entered();return held;}});await started;const count=chats().length;await fire(pair,"session_shutdown");assert.equal((await waiting).stopReason,"aborted");release();await new Promise(resolve=>setImmediate(resolve));assert.equal(chats().length,count);
      assert.equal(ownerContract.queryObservabilityCapability(bus),undefined);assert.equal((await run(registration,{onPayload:()=>undefined})).stopReason,"aborted");
    }
    // Real host execution uses the strict wrapper and the independently installed owner.
    const pi=await import(pathToFileURL(join(host,"dist/index.js")).href);
    const settingsManager=pi.SettingsManager.inMemory({compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:64},retry:{enabled:false}},{projectTrusted:true});
    const sessionManager=pi.SessionManager.inMemory(project);
    clearExtensionCache();const loader=new pi.DefaultResourceLoader({cwd:project,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[ownerEntry,strictEntry]});
    await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
    const {session}=await pi.createAgentSession({cwd:project,agentDir:process.env.PI_CODING_AGENT_DIR,resourceLoader:loader,settingsManager,sessionManager,tools:["read"]});
    try {
      await session.bindExtensions({});tools=true;heldPath="fixture.txt";await session.setModel(session.modelRuntime.getModel("ollama",modelId));await session.prompt("Read the fixture file packed-secret");
      assert.equal(session.messages.filter((message:any)=>message.role==="toolResult"&&message.toolName==="read"&&!message.isError).length,1,"held call executes exactly once");
      assert.ok(sessionManager.getBranch().some((row:any)=>row.customType==="tool-intent"));
      tools=false;await session.prompt("Preserve the fixture result. ".repeat(200));const prior=chats().length;
      if(process.env.EXPECTED_COMPACTION_POLICY === "enforced") {
        const compacted=await session.compact("Keep the fixture result packed-secret.");
        assert.match(compacted.summary,/Fixture answer/);assert.ok(chats().length>prior);
        assert.ok(chats().slice(prior).every(row=>!JSON.stringify(row).includes("packed-secret")),"compaction payload passes owner redaction");
      } else {
        await assert.rejects(session.compact("Keep the fixture result packed-secret."),/PAYLOAD_HOOK_UNAVAILABLE/);
        assert.equal(chats().length,prior,"strict compaction refusal occurs before network egress");
      }
    } finally {await session.abort();session.dispose();}
  } else {
    // Real Pi session: ordinary standalone tools execute without audit intent.
    const pi=await import(pathToFileURL(join(host,"dist/index.js")).href);
    const settingsManager=pi.SettingsManager.inMemory({compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:64},retry:{enabled:false}},{projectTrusted:true});
    const sessionManager=pi.SessionManager.inMemory(project);
    clearExtensionCache();const loader=new pi.DefaultResourceLoader({cwd:project,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[entry]});
    await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
    const {session}=await pi.createAgentSession({cwd:project,agentDir:process.env.PI_CODING_AGENT_DIR,resourceLoader:loader,settingsManager,sessionManager,tools:["read"]});
    try {
      tools=true;heldPath="fixture.txt";await session.setModel(session.modelRuntime.getModel("ollama",modelId));await session.prompt("Read the fixture file");
      assert.equal(session.messages.filter((message:any)=>message.role==="toolResult"&&message.toolName==="read"&&!message.isError).length,1,"held call executes exactly once");assert.ok(!sessionManager.getBranch().some((row:any)=>row.customType==="tool-intent"));
      tools=false;await session.prompt("Preserve the fixture result. ".repeat(200));
      const compacted=await session.compact("Keep the fixture result.");assert.match(compacted.summary,/Fixture answer/);
    }
    finally {await session.abort();session.dispose();}
  }
  assert.equal(readFileSync("fixture.txt","utf8"),"Fixture source\n");
} finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
