import { describe, expect, it } from "vitest";
import { makeParsed } from "../helpers/parse-fixture.ts";

describe("makeParsed", () => {
  it("defaults unresolved imports and empty symbols", () => {
    const parsed = makeParsed([
      { file: "src/a.ts", imports: [{ specifier: "./b" }] },
      { file: "src/b.ts" },
    ]);

    expect(parsed.program.root).toBe("/proj");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]?.imports[0]).toMatchObject({
      fromFile: "src/a.ts",
      specifier: "./b",
      resolvedPath: null,
      external: false,
      kind: "import",
    });
    expect(parsed.files[1]?.imports).toEqual([]);
    expect(parsed.files[1]?.symbols).toMatchObject({
      file: "src/b.ts",
      functions: [],
      classes: [],
      isRoute: false,
      isTest: false,
    });
  });

  it("honors root, paths, and resolvedPath overrides", () => {
    const parsed = makeParsed(
      [
        {
          file: "src/order.ts",
          imports: [
            {
              specifier: "#/payment",
              resolvedPath: "src/payment.ts",
            },
          ],
          complexity: 4,
          isTest: false,
        },
      ],
      {
        root: "/repo",
        compilerOptions: {
          baseUrl: ".",
          paths: { "#/*": ["src/*"] },
        },
      },
    );

    expect(parsed.program.root).toBe("/repo");
    expect(parsed.program.compilerOptions.paths).toEqual({
      "#/*": ["src/*"],
    });
    expect(parsed.files[0]?.complexity).toBe(4);
    expect(parsed.files[0]?.imports[0]?.resolvedPath).toBe("src/payment.ts");
  });
});
