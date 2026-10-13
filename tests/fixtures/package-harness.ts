import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { piPackageRoot } from "../pi-host.ts";
const root=fileURLToPath(new URL("../../",import.meta.url));

export async function verifyPacked(t:TestContext,observabilityTarball?:string) {
  const consumer=await mkdtemp(join(tmpdir(),"ollama-packed-consumer-"));t.after(()=>rm(consumer,{recursive:true,force:true}));
  const packed=JSON.parse(execFileSync("npm",["pack","--json","--pack-destination",consumer],{cwd:root,encoding:"utf8",timeout:30000}))[0];
  assert.ok(packed.files.every((file:any)=>/^(dist\/[^/]+\.(js|d\.ts)|docs\/[^/]+\.md|README\.md|LICENSE|package\.json)$/.test(file.path)));
  await writeFile(join(consumer,"package.json"),JSON.stringify({private:true,type:"module"}));
  const install=(cwd:string,tarball:string)=>execFileSync("npm",["install","--offline","--ignore-scripts","--legacy-peer-deps","--no-audit","--no-fund",tarball],{cwd,stdio:"pipe",timeout:30000});
  install(consumer,join(consumer,packed.filename));
  await mkdir(join(consumer,"home"));await writeFile(join(consumer,"home/.env"),"FIXTURE_TOKEN=registry-only\n");
  let ownerRoot:string|undefined;
  if(observabilityTarball) {
    const owner=join(consumer,"owner");await mkdir(owner);await writeFile(join(owner,"package.json"),JSON.stringify({private:true,type:"module"}));install(owner,observabilityTarball);ownerRoot=join(owner,"node_modules/@seank/pi-observability");
  }
  await writeFile(join(consumer,"probe.ts"),await readFile(new URL("./packed-probe.ts",import.meta.url),"utf8"));
  await writeFile(join(consumer,"types.ts"),'import {OLLAMA_API_ID,type OllamaChatRequest} from "@seank/pi-ollama-provider/contract"; const id:"pi-ollama-chat"=OLLAMA_API_ID; declare const request:OllamaChatRequest;void id;void request;');
  execFileSync(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"--noEmit","--strict","--target","ES2023","--module","NodeNext","types.ts"],{cwd:consumer,stdio:"pipe",timeout:30000});
  execFileSync(process.execPath,[join(consumer,"probe.ts")],{cwd:consumer,env:{...process.env,HOME:join(consumer,"home"),PI_CODING_AGENT_DIR:join(consumer,"profile"),TEST_PI_HOST:piPackageRoot(),TEST_OBSERVABILITY_ROOT:ownerRoot??"",FIXTURE_TOKEN:"packed-secret"},stdio:"pipe",timeout:30000});
}
