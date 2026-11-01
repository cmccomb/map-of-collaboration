"use strict";

const crypto = require("node:crypto");

// These are public, already served artifacts from the exact parent release.
// A new graph change requires a separately reviewed parent and delta contract.
const PARENT_REVISION = "c00b628be087941fa61a1376759994902936e553";
const PARENT_GRAPH_SHA256 = "b341aa8077e3e268f9f1ed7eb85a625323fa67465e6f750708f0e8078f289154";
const POSITIONS_SHA256 = "bc2bc9da2e064a46a2b49489d386d5e6facc3151f33fd1250b48b77e301fb058";
const CONTRACT_SHA256 = "9cbc06b16d54703c614537fe62fa92c0b34943c2c1b550f38d138e8c5971983a";
const NODE_COUNT_FIELDS = [
  "publication_count",
  "mapped_publication_count",
  "collaborator_count",
  "collaboration_count",
];
const STATIC_SECTIONS = ["quality", "years", "departments", "academic_homes", "schools"];
const PUBLISHED_PARENT = Object.freeze({
  revision: PARENT_REVISION,
  graphSha256: PARENT_GRAPH_SHA256,
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
    assert(document.schema_version === 1, "unknown baseline schema");
    assert(document.parent_dataset_revision === expected.revision, "parent revision changed");
    assert(document.parent_graph_sha256 === expected.graphSha256, "parent graph SHA changed");
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

function pinReviewedParentPositions(graph, positionsText, contractText, expected = PUBLISHED_PARENT) {
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
    assert(sha256(JSON.stringify(graph)) === expected.graphSha256,
      "immutable parent graph no longer rebuilds byte-for-byte");
    for (const node of graph.nodes) {
      const baseline = positions[node.id];
      assert(baseline && baseline[0] === node.x && baseline[1] === node.y,
        "immutable parent position changed");
    }
    return graph;
  }

  assert(/^[0-9a-f]{40}$/.test(graph.source.dataset_revision),
    "candidate dataset revision is not immutable");
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
      assert(edge.source === contract.moving_node_id || edge.target === contract.moving_node_id,
        "new edge is unrelated to the reviewed person");
      assert(edge.source !== contract.forbidden_partner_id &&
        edge.target !== contract.forbidden_partner_id,
      "unreviewed Yuvraj-Seshan edge appeared");
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

  const partnerWeights = new Map(newEdges.map((edge) => [
    edge.source === contract.moving_node_id ? edge.target : edge.source,
    edge.works.length,
  ]));
  const seenNodes = new Set();
  for (const node of graph.nodes) {
    assert(!seenNodes.has(node.id), "duplicate graph node");
    seenNodes.add(node.id);
    assert(Object.hasOwn(positions, node.id), "unknown graph node");
    assert(sha256(JSON.stringify(staticNode(node))) ===
      contract.parent_node_static_sha256[node.id],
    `prior graph node ${node.id} changed`);
    const expectedCounts = [...contract.parent_node_counts[node.id]];
    if (node.id === contract.moving_node_id) {
      expectedCounts[0] += contract.expected_moving_node_publication_delta;
      expectedCounts[1] += contract.expected_moving_node_mapped_publication_delta;
      expectedCounts[2] += contract.expected_new_edge_count;
      expectedCounts[3] += contract.expected_new_pair_work_count;
    } else if (partnerWeights.has(node.id)) {
      expectedCounts[2] += 1;
      expectedCounts[3] += partnerWeights.get(node.id);
    }
    assert(JSON.stringify(counts(node)) === JSON.stringify(expectedCounts),
      `prior graph node counts for ${node.id} changed unexpectedly`);
    if (node.id !== contract.moving_node_id) {
      [node.x, node.y] = positions[node.id];
    } else {
      assert(Number.isFinite(node.x) && Number.isFinite(node.y),
        "reviewed moving node has no finite position");
    }
  }
  assert(seenNodes.size === Object.keys(positions).length, "prior graph node disappeared");
  return graph;
}

module.exports = { pinReviewedParentPositions };
