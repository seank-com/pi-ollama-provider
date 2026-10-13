import test from "node:test";
import {verifyPacked} from "./fixtures/package-harness.ts";
test("packed standalone provider loads, executes ordinary tools and exposes its strict factory",{timeout:60000},t=>verifyPacked(t));
