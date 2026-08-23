#!/usr/bin/env node
/* global AbortSignal, TextDecoder, fetch, process */

/**
 * B4 live harness: one deterministic, guarded normal tap child hop.
 *
 * The caller records the selected edge before invoking this script.  This
 * script performs exactly one SSE generation and one persistence write; it
 * never retries and emits only redacted, machine-readable evidence.
 */

import { randomUUID } from "node:crypto";

const SESSION_ID = "session_b3_live_8ce2bf1163044e9f92c878345dbbfec6";
const BASE_URL = process.env.B4_WEB_BASE_URL || "http://127.0.0.1:3000";
const OWNER_TOKEN = process.env.B4_OWNER_TOKEN || "";
const REQUIRED_STAGES = [
  "searching",
  "planning",
  "generating_image",
  "aligning",
  "saving",
  "done",
];

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(reason, extra = {}) {
  emit({ ok: false, reason, ...extra });
  process.exitCode = 1;
}

function args() {
  const [hop, parentId, hotspotId, subQuery, x, y] = process.argv.slice(2);
  const parsedHop = Number(hop);
  const parsedX = Number(x);
  const parsedY = Number(y);
  if (
    !Number.isInteger(parsedHop) ||
    parsedHop < 1 ||
    parsedHop > 3 ||
    !parentId ||
    !hotspotId ||
    !subQuery ||
    !Number.isFinite(parsedX) ||
    !Number.isFinite(parsedY)
  ) {
    throw new Error("invalid hop arguments");
  }
  return {
    hop: parsedHop,
    parentId,
    hotspotId,
    subQuery,
    x: parsedX,
    y: parsedY,
  };
}

function headers(extra = {}) {
  return {
    "Content-Type": "application/json",
    Cookie: `ofb_owner=${encodeURIComponent(OWNER_TOKEN)}`,
    ...extra,
  };
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: headers(init.headers || {}),
    signal: init.signal || AbortSignal.timeout(30_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

async function readSse(response) {
  if (!response.body) throw new Error("SSE response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stages = [];
  const events = [];
  let final = null;
  let errorEvent = null;

  const consume = (frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("invalid SSE JSON");
    }
    events.push(event.type || "unknown");
    if (event.type === "status") stages.push(event.stage || "");
    if (event.type === "final") final = event;
    if (event.type === "error") errorEvent = event;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      consume(frame);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return { stages, events, final, errorEvent };
}

function validBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [x, y, w, h] = value.map(Number);
  return (
    [x, y, w, h].every(Number.isFinite) &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1 &&
    y + h <= 1
  );
}

function contractEvidence(final) {
  const plan = final?.page_plan;
  const aligned = Array.isArray(final?.aligned_hotspots)
    ? final.aligned_hotspots
    : [];
  const planned = Array.isArray(plan?.hotspots) ? plan.hotspots : [];
  const planIds = planned.map((row) => row?.id).filter(Boolean);
  const alignedIds = aligned.map((row) => row?.id).filter(Boolean);
  const sources = Array.isArray(plan?.sources) ? plan.sources : [];
  const sourceIds = new Set(sources.map((row) => row?.id).filter(Boolean));
  const textBlocks = Array.isArray(plan?.text_blocks) ? plan.text_blocks : [];
  const citedIds = textBlocks.flatMap((row) =>
    Array.isArray(row?.source_ids) ? row.source_ids : [],
  );
  const validCitations = citedIds.filter((id) => sourceIds.has(id));
  const validSources = sources.filter(
    (row) =>
      typeof row?.id === "string" &&
      row.id.length > 0 &&
      typeof row?.title === "string" &&
      row.title.trim().length > 0 &&
      typeof row?.url === "string" &&
      row.url.trim().length > 0 &&
      typeof row?.snippet === "string" &&
      row.snippet.trim().length > 0,
  );
  return {
    plan_source_count: sources.length,
    valid_source_count: validSources.length,
    text_block_count: textBlocks.length,
    valid_citation_ids: [...new Set(validCitations)],
    planned_hotspot_ids: planIds,
    aligned_hotspot_ids: alignedIds,
    parity:
      planIds.length > 0 &&
      planIds.length === alignedIds.length &&
      planIds.every((id, index) => id === alignedIds[index]),
    citations_pass: validCitations.length > 0,
    sources_pass: validSources.length > 0,
  };
}

function stageEvidence(stages) {
  const positions = REQUIRED_STAGES.map((stage) => stages.indexOf(stage));
  const ordered = positions.every(
    (position, index) => position >= 0 && (index === 0 || position > positions[index - 1]),
  );
  const forbidden = stages.filter((stage) =>
    ["click_resolving", "draft", "progress", "critic", "video", "prefetch"].some(
      (word) => stage.includes(word),
    ),
  );
  return { stages, required_stages: REQUIRED_STAGES, ordered, forbidden };
}

async function main() {
  if (!OWNER_TOKEN) throw new Error("owner cookie unavailable");
  const input = args();
  const sessionPath = `/api/sessions/${encodeURIComponent(SESSION_ID)}?limit=200`;
  const sessionResult = await jsonRequest(sessionPath);
  if (!sessionResult.response.ok || !sessionResult.body) {
    return fail("session_read_failed", { status: sessionResult.response.status });
  }
  const parent = (sessionResult.body.nodes || []).find(
    (node) => node.id === input.parentId,
  );
  if (!parent) return fail("parent_missing");
  const planned = (parent.page_plan?.hotspots || []).find(
    (hotspot) => hotspot.id === input.hotspotId,
  );
  const aligned = (parent.aligned_hotspots || []).find(
    (hotspot) => hotspot.id === input.hotspotId,
  );
  if (!planned || !aligned) return fail("selected_hotspot_not_planned_and_aligned");
  if (planned.sub_query !== input.subQuery || !planned.sub_query.trim()) {
    return fail("selected_sub_query_changed");
  }
  if (!validBbox(aligned.actual_bbox)) return fail("selected_geometry_invalid");
  if (
    Math.abs(input.x - (aligned.actual_bbox[0] + aligned.actual_bbox[2] / 2)) > 1e-6 ||
    Math.abs(input.y - (aligned.actual_bbox[1] + aligned.actual_bbox[3] / 2)) > 1e-6
  ) {
    return fail("selected_geometry_mismatch");
  }
  const existingChild = (sessionResult.body.nodes || []).find(
    (node) =>
      node.parent_id === input.parentId &&
      node.source_hotspot_id === input.hotspotId,
  );
  if (existingChild) return fail("explicit_child_already_exists");

  const traceId = `b4-h${input.hop}-${randomUUID()}`;
  const generationBody = {
    query: input.subQuery,
    aspect_ratio: "16:9",
    web_search: true,
    session_id: SESSION_ID,
    current_node_id: input.parentId,
    generation_id: traceId,
    mode: "tap",
    image: parent.image_url,
    parent_query: parent.query,
    parent_title: parent.page_title,
    click: { x_pct: input.x, y_pct: input.y },
    source_hotspot_id: input.hotspotId,
    image_tier: "fast",
    verify: false,
    max_attempts: 1,
    prefetched_subject: planned.label,
    prefetched_style: "",
    prefetched_subject_context: input.subQuery,
  };
  const generated = await fetch(`${BASE_URL}/api/generate-page`, {
    method: "POST",
    headers: headers({
      "X-Trace-Id": traceId,
      "Idempotency-Key": traceId,
    }),
    body: JSON.stringify(generationBody),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!generated.ok || !generated.body) {
    return fail("generation_http_failed", { status: generated.status });
  }
  const sse = await readSse(generated);
  const stages = stageEvidence(sse.stages);
  if (sse.errorEvent) return fail("generation_error_event", { stages: stages.stages });
  if (!stages.ordered || stages.forbidden.length > 0) {
    return fail("stage_sequence_failed", { stages: stages.stages });
  }
  const final = sse.final;
  if (!final?.image_data_url?.startsWith("data:")) {
    return fail("final_image_missing", { stages: stages.stages });
  }
  const contract = contractEvidence(final);
  if (!contract.sources_pass || !contract.citations_pass || !contract.parity) {
    return fail("page_contract_acceptance_failed", { stages: stages.stages, contract });
  }

  const nodeBody = {
    parent_id: input.parentId,
    source_hotspot_id: input.hotspotId,
    session_id: SESSION_ID,
    query: input.subQuery,
    page_title: final.page_title,
    image_data_url: final.image_data_url,
    image_model: final.image_model,
    prompt_author_model: final.prompt_author_model,
    aspect_ratio: "16:9",
    final_prompt: final.final_prompt || null,
    click_in_parent: { x_pct: input.x, y_pct: input.y },
    sources: final.sources || null,
    relation: "descend",
    scale: "peer",
    page_plan: final.page_plan,
    aligned_hotspots: final.aligned_hotspots,
  };
  const saved = await jsonRequest("/api/nodes", {
    method: "POST",
    headers: { "Idempotency-Key": `node-${traceId}` },
    body: JSON.stringify(nodeBody),
    signal: AbortSignal.timeout(120_000),
  });
  if (!saved.response.ok || !saved.body?.id) {
    return fail("node_persist_failed", { status: saved.response.status });
  }
  const childRead = await jsonRequest(`/api/nodes/${encodeURIComponent(saved.body.id)}`);
  if (!childRead.response.ok || !childRead.body) {
    return fail("child_reload_failed", { status: childRead.response.status });
  }
  const child = childRead.body;
  const persistedContract = contractEvidence({
    page_plan: child.page_plan,
    aligned_hotspots: child.aligned_hotspots,
  });
  if (
    child.parent_id !== input.parentId ||
    child.source_hotspot_id !== input.hotspotId ||
    child.query !== input.subQuery ||
    !persistedContract.parity
  ) {
    return fail("child_lineage_or_reload_failed", {
      child_id: child.id,
      parent_id: child.parent_id,
      source_hotspot_id: child.source_hotspot_id,
      query_matches: child.query === input.subQuery,
      persisted_contract: persistedContract,
    });
  }

  emit({
    ok: true,
    hop: input.hop,
    parent_id: input.parentId,
    source_hotspot_id: input.hotspotId,
    child_id: child.id,
    trace_id: traceId,
    label: planned.label,
    stages: stages.stages,
    required_stages: stages.required_stages,
    event_types: sse.events,
    contract,
    persisted_contract: persistedContract,
    persisted: {
      parent_id: child.parent_id,
      source_hotspot_id: child.source_hotspot_id,
      query_matches: child.query === input.subQuery,
      image_present: Boolean(child.image_url),
      sources_count: Array.isArray(child.sources) ? child.sources.length : 0,
    },
    expected_calls: {
      searxng_searches: 1,
      luna_planners: 1,
      gpt_image_2: 1,
      luna_alignments: 1,
      luna_total: 2,
      model_provider_calls: 3,
      click_vlm: 0,
      world_geo_extraction: 0,
      ai_prefetch: 0,
      video: 0,
      critic: 0,
      progressive_draft_extra_image: 0,
      retries: 0,
      unexpected_provider_calls: 0,
    },
  });
}

main().catch((error) => {
  fail(error instanceof Error ? error.message.slice(0, 200) : "live_hop_failed");
});
