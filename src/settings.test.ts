/**
 * Tests for readSettingsConfig — pi-memory config resolution from
 * ~/.pi/agent/settings.json, ~/.pi/memory/settings.json, and
 * {cwd}/.pi/settings.json.
 *
 * Precedence: project settings override memory-directory settings, which
 * override legacy global settings.
 * Fields supported: lessonInjection, consolidationModel.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { readSettingsConfig } from "./index.js";

let tmpProject: string;
let tmpHome: string;

function writeSettings(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings), "utf-8");
}

function writeProjectSettings(obj: Record<string, unknown>): void {
  writeSettings(path.join(tmpProject, ".pi", "settings.json"), obj);
}

describe("readSettingsConfig", () => {
  before(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "mem-settings-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mem-home-"));
  });

  beforeEach(() => {
    try {
      fs.rmSync(path.join(tmpProject, ".pi"), { recursive: true, force: true });
      fs.rmSync(path.join(tmpHome, ".pi"), { recursive: true, force: true });
    } catch {}
  });

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reads consolidationModel from ~/.pi/memory/settings.json", () => {
    writeSettings(path.join(tmpHome, ".pi", "memory", "settings.json"), {
      memory: { consolidationModel: "memory/global-model" },
    });
    const config = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(config.consolidationModel, "memory/global-model");
  });

  it("reads the legacy global settings file", () => {
    writeSettings(path.join(tmpHome, ".pi", "agent", "settings.json"), {
      memory: { consolidationModel: "legacy/global-model" },
    });
    const config = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(config.consolidationModel, "legacy/global-model");
  });

  it("prefers ~/.pi/memory/settings.json over legacy global settings", () => {
    writeSettings(path.join(tmpHome, ".pi", "agent", "settings.json"), {
      memory: { consolidationModel: "legacy/global-model" },
    });
    writeSettings(path.join(tmpHome, ".pi", "memory", "settings.json"), {
      memory: { consolidationModel: "memory/global-model" },
    });
    const config = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(config.consolidationModel, "memory/global-model");
  });

  it("project settings override ~/.pi/memory/settings.json", () => {
    writeSettings(path.join(tmpHome, ".pi", "memory", "settings.json"), {
      memory: { consolidationModel: "memory/global-model" },
    });
    writeProjectSettings({ memory: { consolidationModel: "project/model" } });
    const config = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(config.consolidationModel, "project/model");
  });

  it("reads consolidationModel from project-local `memory` block", () => {
    writeProjectSettings({ memory: { consolidationModel: "openai/gpt-4.1-mini" } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, "openai/gpt-4.1-mini");
  });

  it("reads consolidationModel from project-local `pi-memory` block", () => {
    writeProjectSettings({ "pi-memory": { consolidationModel: "ollama/qwen3:8b" } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, "ollama/qwen3:8b");
  });

  it("prefers `memory` over `pi-memory` when both are present locally", () => {
    writeProjectSettings({
      memory: { consolidationModel: "from-memory" },
      "pi-memory": { consolidationModel: "from-pi-memory" },
    });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, "from-memory");
  });

  it("ignores non-string consolidationModel", () => {
    writeProjectSettings({ memory: { consolidationModel: 42 } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, undefined);
  });

  it("ignores empty / whitespace-only consolidationModel", () => {
    writeProjectSettings({ memory: { consolidationModel: "   " } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, undefined);
  });

  it("trims surrounding whitespace on a valid model string", () => {
    writeProjectSettings({ memory: { consolidationModel: "  claude-sonnet-4-20250514  " } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, "claude-sonnet-4-20250514");
  });

  it("still reads lessonInjection alongside consolidationModel", () => {
    writeProjectSettings({
      memory: {
        lessonInjection: "selective",
        consolidationModel: "openai/gpt-4.1-mini",
      },
    });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.lessonInjection, "selective");
    assert.equal(cfg.consolidationModel, "openai/gpt-4.1-mini");
  });

  it("reads perTurnInjection = true", () => {
    writeProjectSettings({ memory: { perTurnInjection: true } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.perTurnInjection, true);
  });

  it("reads perTurnInjection = false", () => {
    writeProjectSettings({ memory: { perTurnInjection: false } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.perTurnInjection, false);
  });

  it("ignores non-boolean perTurnInjection", () => {
    writeProjectSettings({ memory: { perTurnInjection: "yes" } });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.perTurnInjection, undefined);
  });

  it("returns undefined consolidationModel when no settings.json is present", () => {
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, undefined);
  });

  it("ignores malformed JSON in local settings.json", () => {
    fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, ".pi", "settings.json"), "{ not json", "utf-8");
    // Should not throw.
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.consolidationModel, undefined);
  });

  it("a malformed consolidationModel does not clobber a valid lessonInjection", () => {
    writeProjectSettings({
      memory: {
        lessonInjection: "selective",
        consolidationModel: 123, // invalid
      },
    });
    const cfg = readSettingsConfig(tmpProject, tmpHome);
    assert.equal(cfg.lessonInjection, "selective");
    assert.equal(cfg.consolidationModel, undefined);
  });
});
