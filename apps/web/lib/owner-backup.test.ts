import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import { buildPortableZip } from "./export-build";
import {
  BackupArchiveError,
  buildOwnerBackupArchive,
  executeOwnerRestore,
  parseOwnerBackupArchive,
  planOwnerRestore,
  type BackupSourceNode,
} from "./owner-backup";

function sourceNode(
  id: string,
  parentId: string | null,
  sourceHotspotId: string | null,
): BackupSourceNode {
  return {
    id,
    parent_id: parentId,
    source_hotspot_id: sourceHotspotId,
    session_id: "session-a",
    query: id === "root" ? "steam engine" : "how the piston moves",
    page_title: id === "root" ? "Steam Engine" : "Piston",
    image_key: `${id}.png`,
    image_model: "openai/gpt-image-2",
    prompt_author_model: "openai/gpt-5.6-luna",
    aspect_ratio: "16:9",
    click_in_parent: parentId ? { x_pct: 0.5, y_pct: 0.5 } : null,
    sources: [],
    relation: "descend",
    scale: "peer",
    scale_tier: null,
    scene_view: null,
    page_plan: {
      schema_version: "1.0",
      title: id === "root" ? "Steam Engine" : "Piston",
      summary: "Synthetic owner-backup fixture",
      scene: {
        prompt: "Clean illustrated cutaway, no text",
        style: "textbook",
        aspect_ratio: "16:9",
      },
      text_blocks: [
        { id: "t001", role: "title", text: "Steam", anchor: "top", source_ids: [] },
        { id: "t002", role: "body", text: "Motion", anchor: "bottom", source_ids: [] },
      ],
      hotspots: [
        {
          id: "h001",
          label: "Piston",
          sub_query: "how the piston moves",
          visual_target: "central piston",
          desired_bbox: [0.4, 0.2, 0.2, 0.3],
        },
      ],
      motion_hints: [],
      sources: [],
    },
    aligned_hotspots: [
      {
        id: "h001",
        actual_bbox: [0.4, 0.2, 0.2, 0.3],
        alignment_confidence: 0.95,
        tap_region: [[0.4, 0.2], [0.6, 0.2], [0.6, 0.5], [0.4, 0.5]],
      },
    ],
    seed_type: null,
    created_at: id === "root" ? "2026-08-23T00:00:00.000Z" : "2026-08-23T00:01:00.000Z",
  };
}

async function archive() {
  return buildOwnerBackupArchive({
    sessions: ["session-a"],
    nodes: [sourceNode("root", null, null), sourceNode("child", "root", "h001")],
    images: new Map([
      ["root.png", { bytes: Buffer.from("root-image"), contentType: "image/png" }],
      ["child.png", { bytes: Buffer.from("child-image"), contentType: "image/png" }],
    ]),
    createdAt: new Date("2026-08-23T12:00:00.000Z"),
  });
}

describe("owner backup archive", () => {
  it("builds a versioned, completely hashed owner archive", async () => {
    const built = await archive();
    const parsed = await parseOwnerBackupArchive(built.bytes);
    const zip = await JSZip.loadAsync(built.bytes);

    expect(parsed.manifest).toMatchObject({
      schema: "openflipbook.backup.v1",
      created_at: "2026-08-23T12:00:00.000Z",
      sessions: 1,
      nodes: 2,
    });
    expect(parsed.manifest.files).toHaveLength(4);
    expect(parsed.manifest.files.some((row) => row.path === "manifest.json")).toBe(false);
    expect(Object.keys(zip.files).filter((name) => !name.endsWith("/"))).toEqual([
      "data/sessions.json",
      "data/nodes.json",
      "images/0001-root.png",
      "images/0002-child.png",
      "manifest.json",
    ]);
    expect(parsed.nodes[1]?.parent_id).toBe("root");
    expect(parsed.nodes[1]?.source_hotspot_id).toBe("h001");
  });

  it("rejects a payload changed after manifest hashing", async () => {
    const built = await archive();
    const zip = await JSZip.loadAsync(built.bytes);
    zip.file("data/nodes.json", JSON.stringify({ nodes: [] }));
    const tampered = await zip.generateAsync({ type: "uint8array" });

    await expect(parseOwnerBackupArchive(tampered)).rejects.toThrow(
      /hash_or_size:data\/nodes\.json/,
    );
  });

  it.each([
    ["../escape.json", "unsafe_path"],
    ["/absolute.json", "unsafe_path"],
    ["data/token.json", "forbidden_member_name"],
    ["data/pw.txt", "forbidden_member_name"],
  ])("rejects unsafe archive member %s", async (name, code) => {
    const zip = new JSZip();
    zip.file(name, "bad");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(parseOwnerBackupArchive(bytes)).rejects.toThrow(code);
  });

  it("rejects secret signals in otherwise allowlisted JSON payloads", async () => {
    const node = sourceNode("root", null, null);
    node.query = "Authorization: Bearer TOP_SECRET";

    await expect(
      buildOwnerBackupArchive({
        sessions: ["session-a"],
        nodes: [node],
        images: new Map([
          ["root.png", { bytes: Buffer.from("image"), contentType: "image/png" }],
        ]),
      }),
    ).rejects.toThrow(/secret_signal/);
  });

  it("runtime-allowlists node fields instead of spreading storage-only data", async () => {
    const node = {
      ...sourceNode("root", null, null),
      final_prompt: "internal prompt must not be backed up",
      cookie: "private browser value",
    } as BackupSourceNode;
    const built = await buildOwnerBackupArchive({
      sessions: ["session-a"],
      nodes: [node],
      images: new Map([
        ["root.png", { bytes: Buffer.from("image"), contentType: "image/png" }],
      ]),
    });
    const zip = await JSZip.loadAsync(built.bytes);
    const nodes = await zip.file("data/nodes.json")!.async("string");

    expect(nodes).not.toContain("final_prompt");
    expect(nodes).not.toContain("cookie");
    await expect(parseOwnerBackupArchive(built.bytes)).resolves.toBeTruthy();
  });

  it("rejects secret-bearing manifest metadata", async () => {
    const built = await archive();
    const zip = await JSZip.loadAsync(built.bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    manifest.password = "must-not-pass";
    zip.file("manifest.json", JSON.stringify(manifest));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(parseOwnerBackupArchive(bytes)).rejects.toThrow(/secret_signal/);
  });

  it("rejects cyclic parent graphs and mismatched scene references", async () => {
    const root = sourceNode("root", "child", "h001");
    const child = sourceNode("child", "root", "h001");
    await expect(
      buildOwnerBackupArchive({
        sessions: ["session-a"],
        nodes: [root, child],
        images: new Map([
          ["root.png", { bytes: Buffer.from("root"), contentType: "image/png" }],
          ["child.png", { bytes: Buffer.from("child"), contentType: "image/png" }],
        ]),
      }),
    ).rejects.toThrow(/parent_cycle/);

    const scene = sourceNode("root", null, null);
    scene.scene_view = {
      node_id: "another-node",
      level: "map",
      observer: null,
      map_crop: null,
    };
    await expect(
      buildOwnerBackupArchive({
        sessions: ["session-a"],
        nodes: [scene],
        images: new Map([
          ["root.png", { bytes: Buffer.from("root"), contentType: "image/png" }],
        ]),
      }),
    ).rejects.toThrow(/scene_view_lineage/);
  });
});

describe("owner restore planning and execution", () => {
  it("dry-run planning performs no storage or database mutation", async () => {
    const parsed = await parseOwnerBackupArchive((await archive()).bytes);
    const putImage = vi.fn();
    const commit = vi.fn();
    const deleteImage = vi.fn();

    const plan = planOwnerRestore(parsed, {
      existingSessionIds: new Set(["session-a"]),
      existingNodeIds: new Set(["root", "child"]),
      makeId: (() => {
        const ids = ["restore-run", "session-remap", "root-remap", "child-remap"];
        return () => ids.shift()!;
      })(),
    });

    expect(plan.session_id_map).toEqual({ "session-a": "session-remap" });
    expect(plan.node_id_map).toEqual({ root: "root-remap", child: "child-remap" });
    expect(plan.nodes[1]).toMatchObject({
      id: "child-remap",
      parent_id: "root-remap",
      source_hotspot_id: "h001",
      session_id: "session-remap",
    });
    expect(putImage).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it("confirmed isolated restore commits a remapped graph and offline-exports it", async () => {
    const parsed = await parseOwnerBackupArchive((await archive()).bytes);
    const plan = planOwnerRestore(parsed, {
      existingSessionIds: new Set(["session-a"]),
      existingNodeIds: new Set(["root", "child"]),
      makeId: (() => {
        const ids = ["restore-run", "session-copy", "root-copy", "child-copy"];
        return () => ids.shift()!;
      })(),
    });
    const stored = new Map<string, Uint8Array>();
    let committed = false;

    await executeOwnerRestore(plan, {
      putImage: async ({ key, bytes }) => {
        expect(stored.has(key)).toBe(false);
        stored.set(key, bytes);
      },
      deleteImage: async (key) => {
        stored.delete(key);
      },
      commit: async () => {
        committed = true;
      },
    });

    expect(committed).toBe(true);
    expect(stored.size).toBe(2);
    const offline = await buildPortableZip(
      plan.nodes.map((node) => ({
        id: node.id,
        parent_id: node.parent_id,
        source_hotspot_id: node.source_hotspot_id,
        session_id: node.session_id,
        query: node.query,
        page_title: node.page_title,
        image_asset: `images/${node.id}.png`,
        aspect_ratio: node.aspect_ratio,
        click_in_parent: node.click_in_parent,
        sources: node.sources,
        page_plan: node.page_plan,
        aligned_hotspots: node.aligned_hotspots,
        created_at: node.created_at,
        bytes: stored.get(node.image_key) ?? null,
      })),
      { indexHtml: "<main></main>", playerCss: "", playerJs: "" },
    );
    const offlineZip = await JSZip.loadAsync(offline);
    const book = await offlineZip.file("data/book.js")!.async("string");
    expect(book).toContain("root-copy");
    expect(book).toContain("child-copy");
    expect(book).toContain('"source_hotspot_id":"h001"');
    expect(offlineZip.file("manifest.json")).toBeNull();
  });

  it("cleans already-created image keys when a later write fails", async () => {
    const parsed = await parseOwnerBackupArchive((await archive()).bytes);
    const plan = planOwnerRestore(parsed, {
      existingSessionIds: new Set(),
      existingNodeIds: new Set(),
      makeId: () => "restore-run",
    });
    const created: string[] = [];
    const deleted: string[] = [];
    const commit = vi.fn();

    await expect(
      executeOwnerRestore(plan, {
        putImage: async ({ key }) => {
          if (created.length === 1) throw new Error("synthetic storage failure");
          created.push(key);
        },
        deleteImage: async (key) => {
          deleted.push(key);
        },
        commit,
      }),
    ).rejects.toThrow("synthetic storage failure");

    expect(deleted).toEqual(created);
    expect(commit).not.toHaveBeenCalled();
  });

  it("uses a stable typed error for malformed archives", async () => {
    await expect(parseOwnerBackupArchive(Buffer.from("not a zip"))).rejects.toBeInstanceOf(
      BackupArchiveError,
    );
  });
});
