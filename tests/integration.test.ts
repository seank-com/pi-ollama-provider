import assert from "node:assert/strict";
import test from "node:test";
import {verifyPacked} from "./fixtures/package-harness.ts";
test("packed strict provider and observability compose in both load orders",{timeout:60000},t=>{
  assert.ok(process.env.OBSERVABILITY_TARBALL,"explicit OBSERVABILITY_TARBALL is required; default tests need no companion");
  assert.ok(["blocked","enforced"].includes(process.env.EXPECTED_COMPACTION_POLICY??"blocked"));
  if(process.env.PI_CODING_AGENT_PACKAGE) assert.ok(process.env.EXPECTED_COMPACTION_POLICY,"explicit host requires explicit compaction expectation");
  return verifyPacked(t,process.env.OBSERVABILITY_TARBALL);
});
