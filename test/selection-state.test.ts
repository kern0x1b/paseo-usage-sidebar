/**
 * The persisted selection, written into a temp XDG state dir.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { readSelectionState, writeSelectionState } from "../server/selection/state";

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "usage-sidebar-state-"));
});

describe("writeSelectionState", () => {
  it("defaults to one column", () => {
    assert.deepEqual(readSelectionState(), { keys: [], configured: false, columns: 1, composerPill: true });
  });

  it("saves columns alone without marking the pins as configured", () => {
    assert.deepEqual(writeSelectionState({ columns: 2 }), { keys: [], configured: false, columns: 2, composerPill: true });
  });

  it("keeps the saved columns when only the pins change, and the pins when only columns change", () => {
    writeSelectionState({ columns: 3 });
    assert.deepEqual(writeSelectionState({ keys: ["claude:weekly"] }), {
      keys: ["claude:weekly"],
      configured: true,
      columns: 3,
      composerPill: true,
    });
    assert.deepEqual(writeSelectionState({ columns: 2 }), {
      keys: ["claude:weekly"],
      configured: true,
      columns: 2,
      composerPill: true,
    });
    assert.deepEqual(readSelectionState().columns, 2);
  });

  it("turns the composer pill off without touching pins or columns", () => {
    writeSelectionState({ keys: ["claude:weekly"], columns: 2 });
    assert.deepEqual(writeSelectionState({ composerPill: false }), {
      keys: ["claude:weekly"],
      configured: true,
      columns: 2,
      composerPill: false,
    });
  });
});
