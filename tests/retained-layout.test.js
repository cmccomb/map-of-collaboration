"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { pinReviewedParentPositions } = require("../scripts/retained-layout.js");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const staticNode = (node) => Object.fromEntries(Object.entries(node).filter(([key]) =>
  !["x", "y", "publication_count", "mapped_publication_count",
    "collaborator_count", "collaboration_count"].includes(key)));

function fixture() {
  const parent = {
    schema_version: 1,
    title: "Fixture collaboration graph",
    generated_at_utc: "2026-11-01T00:00:00Z",
    source: { dataset_revision: "a".repeat(40),
      artifact_generated_at_utc: "2026-11-01T00:00:00Z", dataset_id: "owner/data" },
    quality: { invalid_faculty_reference_count: 0 },
    years: { minimum: 2020, maximum: 2020 },
    departments: [{ department_id: "s3d" }],
    academic_homes: [],
    schools: [{ school_id: "scs" }],
    nodes: [
      { id: "moving", name: "Moving", publication_count: 0,
        mapped_publication_count: 0, collaborator_count: 0,
        collaboration_count: 0, x: -1, y: 0 },
      { id: "partner", name: "Partner", publication_count: 1,
        mapped_publication_count: 1, collaborator_count: 1,
        collaboration_count: 1, x: 0, y: 0 },
      { id: "other", name: "Other", publication_count: 1,
        mapped_publication_count: 1, collaborator_count: 1,
        collaboration_count: 1, x: 1, y: 0 },
    ],
    edges: [{ source: "partner", target: "other", works: [{ id: "old" }] }],
    counts: { edge_count: 1, pair_work_count: 1 },
  };
  const candidate = clone(parent);
  candidate.source.dataset_revision = "b".repeat(40);
  candidate.generated_at_utc = "2026-11-02T00:00:00Z";
  candidate.source.artifact_generated_at_utc = candidate.generated_at_utc;
  candidate.nodes[0].publication_count = 2;
  candidate.nodes[0].mapped_publication_count = 2;
  candidate.nodes[0].collaborator_count = 1;
  candidate.nodes[0].collaboration_count = 2;
  candidate.nodes[0].x = 0.25;
  candidate.nodes[0].y = 0.3;
  candidate.nodes[1].collaborator_count = 2;
  candidate.nodes[1].collaboration_count = 3;
  candidate.nodes[1].x = -0.25;
  candidate.nodes[2].x = 0.75;
  candidate.edges.push({ source: "moving", target: "partner",
    works: [{ id: "selected-1" }, { id: "selected-2" }] });
  candidate.counts.edge_count = 2;
  candidate.counts.pair_work_count = 3;
  const positions = {
    schema_version: 1,
    parent_dataset_revision: parent.source.dataset_revision,
    parent_graph_sha256: sha256(JSON.stringify(parent)),
    positions: Object.fromEntries(parent.nodes.map((node) => [node.id, [node.x, node.y]])),
  };
  const positionsText = JSON.stringify(positions);
  const contract = {
    schema_version: 1,
    parent_dataset_revision: parent.source.dataset_revision,
    parent_graph_sha256: positions.parent_graph_sha256,
    position_baseline_sha256: sha256(positionsText),
    parent_node_count: parent.nodes.length,
    parent_edge_count: parent.edges.length,
    moving_node_id: "moving",
    forbidden_partner_id: "forbidden",
    expected_new_edge_count: 1,
    expected_new_pair_work_count: 2,
    expected_moving_node_publication_delta: 2,
    expected_moving_node_mapped_publication_delta: 2,
    expected_candidate_counts: candidate.counts,
    expected_new_edges_sha256: sha256(JSON.stringify([
      ["moving|partner", candidate.edges[1]],
    ])),
    parent_sections_sha256: Object.fromEntries(
      ["quality", "years", "departments", "academic_homes", "schools"]
        .map((key) => [key, sha256(JSON.stringify(parent[key]))]),
    ),
    parent_node_static_sha256: Object.fromEntries(parent.nodes.map((node) =>
      [node.id, sha256(JSON.stringify(staticNode(node)))])),
    parent_node_counts: Object.fromEntries(parent.nodes.map((node) =>
      [node.id, [node.publication_count, node.mapped_publication_count,
        node.collaborator_count, node.collaboration_count]])),
    parent_edge_sha256: { "other|partner": sha256(JSON.stringify(parent.edges[0])) },
    parent_schema_version: parent.schema_version,
    parent_title: parent.title,
    parent_top_level_keys: Object.keys(parent),
    parent_source_static_sha256: sha256(JSON.stringify({ dataset_id: "owner/data" })),
  };
  const contractText = JSON.stringify(contract);
  const expected = {
    revision: parent.source.dataset_revision,
    graphSha256: positions.parent_graph_sha256,
    positionsSha256: sha256(positionsText),
    contractSha256: sha256(contractText),
  };
  return { parent, candidate, positionsText, contractText, expected };
}

test("an immutable parent rebuild is byte-identical and reviewed growth pins prior nodes", () => {
  const data = fixture();
  assert.strictEqual(
    pinReviewedParentPositions(data.parent, data.positionsText, data.contractText, data.expected),
    data.parent,
  );
  const candidate = pinReviewedParentPositions(
    data.candidate, data.positionsText, data.contractText, data.expected);
  assert.deepEqual(candidate.nodes.map(({ x, y }) => [x, y]),
    [[0.25, 0.3], [0, 0], [1, 0]]);
  assert.equal(candidate.edges.length, 2);
});

test("a stale baseline, changed prior edge, or unrelated graph change fails closed", () => {
  const data = fixture();
  const pin = (graph, positionsText = data.positionsText, contractText = data.contractText) =>
    pinReviewedParentPositions(graph, positionsText, contractText, data.expected);
  assert.throws(() => pin(data.candidate, data.positionsText.replace('"moving"', '"wrong"')),
    /position baseline SHA changed/);
  assert.throws(() => pin(data.candidate, data.positionsText, data.contractText.replace('"moving"', '"wrong"')),
    /parent graph contract SHA changed/);
  const oldEdgeChanged = clone(data.candidate);
  oldEdgeChanged.edges[0].works[0].id = "replaced";
  assert.throws(() => pin(oldEdgeChanged), /prior graph edge/);
  const oldNodeChanged = clone(data.candidate);
  oldNodeChanged.nodes[2].name = "Changed";
  assert.throws(() => pin(oldNodeChanged), /prior graph node/);
  const unrelatedEdge = clone(data.candidate);
  unrelatedEdge.edges.push({ source: "partner", target: "other-new", works: [{ id: "x" }] });
  assert.throws(() => pin(unrelatedEdge), /new edge is unrelated/);
  const missingEdge = clone(data.candidate);
  missingEdge.edges.shift();
  assert.throws(() => pin(missingEdge), /prior edge disappeared/);
  const wrongNewWork = clone(data.candidate);
  wrongNewWork.edges[1].works[0].id = "unreviewed";
  assert.throws(() => pin(wrongNewWork), /new edge metadata/);
  const wrongCount = clone(data.candidate);
  wrongCount.nodes[1].collaboration_count += 1;
  assert.throws(() => pin(wrongCount), /node counts/);
  const extraNode = clone(data.candidate);
  extraNode.nodes.push({ id: "unexpected", x: 0, y: 0 });
  assert.throws(() => pin(extraNode), /node set changed/);
});

test("the reviewed mover alone may move; a changed parent cannot rebuild", () => {
  const data = fixture();
  const changedParent = clone(data.parent);
  changedParent.nodes[2].x = 0.75;
  assert.throws(() => pinReviewedParentPositions(
    changedParent, data.positionsText, data.contractText, data.expected),
  /immutable parent graph no longer rebuilds/);
  const changedQuality = clone(data.candidate);
  changedQuality.quality.invalid_faculty_reference_count = 1;
  assert.throws(() => pinReviewedParentPositions(
    changedQuality, data.positionsText, data.contractText, data.expected),
  /quality changed/);
  const changedSource = clone(data.candidate);
  changedSource.source.dataset_id = "other/data";
  assert.throws(() => pinReviewedParentPositions(
    changedSource, data.positionsText, data.contractText, data.expected),
  /source metadata changed/);
  const changedTitle = clone(data.candidate);
  changedTitle.title = "Unreviewed title";
  assert.throws(() => pinReviewedParentPositions(
    changedTitle, data.positionsText, data.contractText, data.expected),
  /graph title changed/);
  const extraField = clone(data.candidate);
  extraField.unreviewed = true;
  assert.throws(() => pinReviewedParentPositions(
    extraField, data.positionsText, data.contractText, data.expected),
  /top-level graph fields changed/);
});
