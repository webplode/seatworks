import assert from "node:assert/strict";
import { test } from "node:test";
import { argsProblems, typedArgs } from "../../server/desk/args.ts";

const schema = { type: "object", properties: { onBranch: { type: "boolean" }, limit: { type: "integer" }, after: { type: "array", items: { type: "string" } }, title: { type: "string" } } };

test("values a harness sent as text are read as the type the tool asks for", () => {
  const args = typedArgs(schema, { onBranch: "true", limit: "20", after: '["L1"]', title: "true" });
  assert.deepEqual(args, { onBranch: true, limit: 20, after: ["L1"], title: "true" });
  assert.deepEqual(argsProblems(schema, args), []);
});

test("text that is not the asked type is still refused", () => {
  const args = typedArgs(schema, { onBranch: '{"newBranch": "x"}', limit: "many", after: "L1", extra: "1" });
  assert.deepEqual(argsProblems(schema, args), ["onBranch must be true or false", "limit must be an integer", "after must be a list", "has no field extra"]);
});
