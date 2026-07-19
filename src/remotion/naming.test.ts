import { describe, expect, it } from "vitest";
import { assignSceneFileNames, toComponentName } from "./naming";
import { collisionManifest, shelterManifest } from "./__fixtures__/manifests";

describe("toComponentName (scene name → PascalCase identifier)", () => {
  it("preserves an already-clean PascalCase name (design ref: Shelter.tsx)", () => {
    expect(toComponentName("Shelter")).toBe("Shelter");
  });

  it("PascalCases multi-word and lower-case names", () => {
    expect(toComponentName("the shelter")).toBe("TheShelter");
    expect(toComponentName("shelter")).toBe("Shelter");
    expect(toComponentName("Scene 1")).toBe("Scene1");
    expect(toComponentName("The Shelter!")).toBe("TheShelter");
  });

  it("falls back to a valid identifier for digit-leading / non-alnum names", () => {
    expect(toComponentName("123abc")).toBe("Scene123abc");
    expect(toComponentName("!!!")).toBe("Scene");
  });
});

describe("assignSceneFileNames (deterministic, collision-free)", () => {
  it("assigns the expected component names + filenames for collision cases", () => {
    const assigned = assignSceneFileNames(collisionManifest.scenes);
    expect(assigned.map((a) => a.component)).toEqual([
      "Shelter",
      "Shelter2",
      "TheShelter",
      "Scene123abc",
      "Scene",
    ]);
    expect(assigned.map((a) => a.fileName)).toEqual([
      "Shelter.tsx",
      "Shelter2.tsx",
      "TheShelter.tsx",
      "Scene123abc.tsx",
      "Scene.tsx",
    ]);
  });

  it("produces no case-insensitive filename collisions", () => {
    const names = assignSceneFileNames(collisionManifest.scenes).map((a) =>
      a.fileName.toLowerCase(),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the same scene object association and order", () => {
    const assigned = assignSceneFileNames(shelterManifest.scenes);
    expect(assigned.map((a) => a.scene.id)).toEqual(["scene-1", "scene-2"]);
    expect(assigned.map((a) => a.component)).toEqual(["Shelter", "Refuge"]);
  });
});
