import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

/*
 * What the MCP Registry will check when this is published, checked first:
 * server.json against the registry's own schema, and against package.json,
 * whose `mcpName` is how the registry confirms the npm package is ours.
 */

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const server = read("server.json");
const pkg = read("package.json");
const schema = read("tests/fixtures/server.schema.2025-12-11.json");

describe("server.json", () => {
  it("is valid against the registry's published schema", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: Ajv) => void)(ajv);
    const validate = ajv.compile(schema);
    expect(validate(server), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(server.$schema).toBe(schema.$id);
  });

  it("names the npm package that proves it is ours", () => {
    expect(server.name).toBe(pkg.mcpName);
    const [npm] = server.packages;
    expect(npm).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
    expect(server.version).toBe(pkg.version);
  });

  it("asks for exactly the settings the server reads", () => {
    const cli = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
    const read = [...cli.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    const declared = server.packages[0].environmentVariables.map((v: { name: string }) => v.name).sort();
    expect(declared).toEqual([...new Set(read)]);
    const key = server.packages[0].environmentVariables.find((v: { name: string }) => v.name === "BRYDGE_API_KEY");
    expect(key).toMatchObject({ isRequired: true, isSecret: true });
  });

  it("fits the registry's limits", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(pkg.repository.url).toContain(server.repository.url.replace(/^https:\/\//, ""));
  });
});
