"use strict";

const crypto = require("node:crypto");

// These are public, already served artifacts from the exact parent release.
// A new graph change requires a separately reviewed parent and delta contract.
const PARENT_REVISION = "ca27d2c9e649d022bdbfdb375e879532960a47a1";
const PARENT_GRAPH_SHA256 = "96fe9e59c0e575b273cde20819c3035d616dcdfdde023ae6bf8fd1938aab7e99";
const PARENT_GRAPH_BYTES = 3259327;
const POSITIONS_SHA256 = "9e6ed4ebf2415c242f2e43d9d124da87be477b4e5dcc34965f122d95dfda218f";
const CONTRACT_SHA256 = "70db39e0c2fc89526cca3d2a80830e7703001842fe945e899b5109985350d821";
const NODE_COUNT_FIELDS = [
  "publication_count",
  "mapped_publication_count",
  "pending_publication_count",
  "collaborator_count",
  "collaboration_count",
];
const STATIC_SECTIONS = ["quality", "years", "departments", "academic_homes", "schools"];
const PUBLISHED_PARENT = Object.freeze({
  revision: PARENT_REVISION,
  graphSha256: PARENT_GRAPH_SHA256,
  graphBytes: PARENT_GRAPH_BYTES,
  positionsSha256: POSITIONS_SHA256,
  contractSha256: CONTRACT_SHA256,
});

function assert(condition, message) {
  if (!condition) throw new Error(`Retained graph layout: ${message}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function edgeKey(edge) {
  return edge.source < edge.target
    ? `${edge.source}|${edge.target}`
    : `${edge.target}|${edge.source}`;
}

function staticNode(node) {
  return Object.fromEntries(
    Object.entries(node).filter(([key]) =>
      key !== "x" && key !== "y" && !NODE_COUNT_FIELDS.includes(key)),
  );
}

function counts(node) {
  return NODE_COUNT_FIELDS.map((field) => node[field]);
}

function staticSource(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    key !== "dataset_revision" && key !== "artifact_generated_at_utc"));
}

function parsePinnedDocuments(positionsText, contractText, expected) {
  assert(sha256(positionsText) === expected.positionsSha256, "position baseline SHA changed");
  assert(sha256(contractText) === expected.contractSha256, "parent graph contract SHA changed");
  let positions;
  let contract;
  try {
    positions = JSON.parse(positionsText);
    contract = JSON.parse(contractText);
  } catch {
    throw new Error("Retained graph layout: baseline or contract is invalid JSON");
  }
  for (const document of [positions, contract]) {
    assert(document.schema_version === 2, "unknown baseline schema");
    assert(document.parent_dataset_revision === expected.revision, "parent revision changed");
    assert(document.parent_graph_sha256 === expected.graphSha256, "parent graph SHA changed");
    assert(document.parent_graph_bytes === expected.graphBytes, "parent graph byte count changed");
  }
  assert(contract.position_baseline_sha256 === expected.positionsSha256, "baseline binding changed");
  assert(positions.positions && typeof positions.positions === "object", "positions are missing");
  assert(
    Object.keys(positions.positions).length === contract.parent_node_count,
    "parent position count changed",
  );
  for (const coordinates of Object.values(positions.positions)) {
    assert(
      Array.isArray(coordinates) && coordinates.length === 2 &&
        coordinates.every((value) => typeof value === "number" && Number.isFinite(value)),
      "parent position is malformed",
    );
  }
  return { positions: positions.positions, contract };
}

function assertReviewedPendingWorkIds(artifact, contract, parentOnly, expectedCount) {
  if (!Object.hasOwn(contract, "expected_new_pending_work_ids")) return;
  assert(Array.isArray(artifact?.pending_publications), "pending publication source is missing");
  const ids = artifact.pending_publications.map((row) => row.work_id);
  assert(ids.length === expectedCount, "pending work count differs from graph");
  assert(ids.every((id) => typeof id === "string" && /^work-[0-9a-f]{64}$/.test(id)),
    "pending work ID is malformed");
  assert(new Set(ids).size === ids.length, "duplicate pending work ID");
  const expectedNew = contract.expected_new_pending_work_ids;
  assert(Array.isArray(expectedNew) && expectedNew.length ===
    contract.expected_new_pending_work_count &&
    expectedNew.every((id) => typeof id === "string" && /^work-[0-9a-f]{64}$/.test(id)) &&
    new Set(expectedNew).size === expectedNew.length &&
    JSON.stringify(expectedNew) === JSON.stringify([...expectedNew].sort()),
  "reviewed new pending work IDs are malformed");
  assert(sha256(JSON.stringify(expectedNew)) === contract.expected_new_pending_work_ids_sha256,
    "reviewed new pending work IDs SHA changed");
  const expectedSet = new Set(expectedNew);
  const prior = ids.filter((id) => !expectedSet.has(id)).sort();
  const newIds = ids.filter((id) => expectedSet.has(id)).sort();
  assert(sha256(JSON.stringify(prior)) === contract.parent_pending_work_ids_sha256,
    "prior pending work IDs changed");
  if (parentOnly) {
    assert(newIds.length === 0, "immutable parent contains reviewed new pending work IDs");
  } else {
    assert(JSON.stringify(newIds) === JSON.stringify(expectedNew),
      "new pending work IDs differ from reviewed selection");
  }
}

function pinReviewedParentPositions(graph, positionsText, contractText, expected = PUBLISHED_PARENT,
  artifact = null) {
  const { positions, contract } = parsePinnedDocuments(positionsText, contractText, expected);
  assert(graph?.source?.dataset_revision, "graph revision is missing");
  assert(graph.nodes?.length === contract.parent_node_count, "node set changed");
  assert(Object.keys(contract.parent_node_static_sha256).length === graph.nodes.length,
    "parent node contract changed");
  assert(Object.keys(contract.parent_node_counts).length === graph.nodes.length,
    "parent count contract changed");
  assert(Object.keys(contract.parent_edge_sha256).length === contract.parent_edge_count,
    "parent edge contract changed");

  // Rebuilding the immutable parent must produce the exact already served bytes.
  if (graph.source.dataset_revision === expected.revision) {
    assertReviewedPendingWorkIds(artifact, contract, true, graph.counts.pending_work_count);
    for (const node of graph.nodes) {
      const baseline = positions[node.id];
      assert(baseline, "immutable parent node set changed");
      [node.x, node.y] = baseline;
    }
    const parentText = JSON.stringify(graph);
    assert(Buffer.byteLength(parentText) === expected.graphBytes &&
      sha256(parentText) === expected.graphSha256,
    "immutable parent graph no longer rebuilds byte-for-byte");
    return graph;
  }

  // A parent-only rollover is useful for byte parity but cannot approve a
  // candidate graph. Reviewed candidates must also bind the selected pending
  // work IDs; otherwise a count-only contract could accept the wrong rows.
  if (Object.hasOwn(contract, "candidate_contract_status")) {
    assert(/^REVIEWED_[A-Z0-9_]+_EXACT_STAGE_GRAPH$/.test(
      contract.candidate_contract_status), "candidate contract is not reviewed");
    assert(Object.hasOwn(contract, "expected_new_pending_work_ids"),
      "reviewed pending work selection is missing");
  }

  assert(/^[0-9a-f]{40}$/.test(graph.source.dataset_revision),
    "candidate dataset revision is not immutable");
  assertReviewedPendingWorkIds(artifact, contract, false, graph.counts.pending_work_count);
  assert(JSON.stringify(Object.keys(graph)) ===
    JSON.stringify(contract.parent_top_level_keys), "top-level graph fields changed");
  assert(graph.schema_version === contract.parent_schema_version,
    "graph schema changed");
  assert(graph.title === contract.parent_title, "graph title changed");
  assert(typeof graph.generated_at_utc === "string" && graph.generated_at_utc &&
    graph.generated_at_utc === graph.source.artifact_generated_at_utc,
  "graph generation time changed independently of its source");
  assert(sha256(JSON.stringify(staticSource(graph.source))) ===
    contract.parent_source_static_sha256,
  "graph source metadata changed from the parent");

  for (const section of STATIC_SECTIONS) {
    assert(
      sha256(JSON.stringify(graph[section])) === contract.parent_sections_sha256[section],
      `${section} changed from the parent graph`,
    );
  }
  assert(JSON.stringify(graph.counts) === JSON.stringify(contract.expected_candidate_counts),
    "candidate graph counts differ from the reviewed delta");

  const parentEdgeKeys = new Set(Object.keys(contract.parent_edge_sha256));
  const allowedNewEdgeNodes = new Set(contract.allowed_new_edge_node_ids);
  const forbiddenPartners = new Set(contract.forbidden_partner_ids);
  const seenEdges = new Set();
  const newEdges = [];
  for (const edge of graph.edges) {
    const key = edgeKey(edge);
    assert(!seenEdges.has(key), "duplicate graph edge");
    seenEdges.add(key);
    if (parentEdgeKeys.has(key)) {
      assert(sha256(JSON.stringify(edge)) === contract.parent_edge_sha256[key],
        `prior graph edge ${key} changed`);
    } else {
      assert(allowedNewEdgeNodes.has(edge.source) || allowedNewEdgeNodes.has(edge.target),
        "new edge is unrelated to the reviewed person");
      assert(!forbiddenPartners.has(edge.source) && !forbiddenPartners.has(edge.target),
        "forbidden partner edge appeared");
      newEdges.push(edge);
    }
  }
  assert([...parentEdgeKeys].every((key) => seenEdges.has(key)), "prior edge disappeared");
  assert(newEdges.length === contract.expected_new_edge_count, "new edge count changed");
  assert(newEdges.reduce((total, edge) => total + edge.works.length, 0) ===
    contract.expected_new_pair_work_count, "new pair-work count changed");
  const reviewedNewEdges = newEdges
    .map((edge) => [edgeKey(edge), edge])
    .sort(([left], [right]) => left.localeCompare(right));
  assert(sha256(JSON.stringify(reviewedNewEdges)) === contract.expected_new_edges_sha256,
    "new edge metadata differs from the reviewed delta");

  const allowedMovers = new Set(contract.allowed_position_movers);
  const seenNodes = new Set();
  for (const node of graph.nodes) {
    assert(!seenNodes.has(node.id), "duplicate graph node");
    seenNodes.add(node.id);
    assert(Object.hasOwn(positions, node.id), "unknown graph node");
    assert(sha256(JSON.stringify(staticNode(node))) ===
      contract.parent_node_static_sha256[node.id],
    `prior graph node ${node.id} changed`);
    const parentCounts = contract.parent_node_counts[node.id];
    assert(parentCounts && typeof parentCounts === "object", "parent node counts are missing");
    const deltas = contract.expected_node_count_deltas[node.id] || {};
    const expectedCounts = NODE_COUNT_FIELDS.map((field) => parentCounts[field] + (deltas[field] || 0));
    assert(JSON.stringify(counts(node)) === JSON.stringify(expectedCounts),
      `prior graph node counts for ${node.id} changed unexpectedly`);
    if (!allowedMovers.has(node.id)) {
      [node.x, node.y] = positions[node.id];
    } else {
      assert(Number.isFinite(node.x) && Number.isFinite(node.y),
        "reviewed moving node has no finite position");
    }
  }
  assert(seenNodes.size === Object.keys(positions).length, "prior graph node disappeared");
  assert([...allowedMovers].every((id) => seenNodes.has(id)), "reviewed mover is missing");
  assert(Object.keys(contract.expected_node_count_deltas).every((id) => seenNodes.has(id)),
    "reviewed count delta names an unknown node");
  return graph;
}

module.exports = { pinReviewedParentPositions };
