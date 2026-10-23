"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const build = require("../scripts/build-site.js");

function artifactFixture() {
  return {
    schema_version: 7,
    quality_assessment_version: "quality-v1",
    generated_at_utc: "2026-10-23T00:00:00Z",
    source_data_oldest_at_utc: "2026-09-01T00:00:00Z",
    source_data_newest_at_utc: "2026-10-01T00:00:00Z",
    point_count: 2,
    catalogs: {
      departments: [
        {
          department_id: "mech",
          title: "Mechanical Engineering",
          directory_url: "https://example.com/mech",
        },
        {
          department_id: "ece",
          title: "Electrical & Computer Engineering",
          directory_url: "https://example.com/ece",
        },
      ],
      faculty: [
        {
          person_id: "a",
          display_name: "Ada Alpha",
          scholar_id: "scholar-a",
          memberships: [{ department_id: "mech", role: "faculty" }],
          publication_count: 2,
        },
        {
          person_id: "b",
          display_name: "Bela Beta",
          memberships: [{ department_id: "ece", role: "faculty" }],
          publication_count: 1,
        },
        {
          person_id: "c",
          display_name: "Cora Gamma",
          memberships: [{ department_id: "mech", role: "faculty" }],
          publication_count: 0,
        },
      ],
    },
    keywords: [{ keyword_id: "topic-1", label: "Design systems" }],
    points: [
      {
        work_id: "work-1",
        title: "A shared paper",
        faculty_ids: ["a", "b"],
        year: 2024,
        venue: "Journal",
        citation_count: 4,
        keyword_ids: ["topic-1"],
      },
      {
        work_id: "work-2",
        title: "A solo paper",
        faculty_ids: ["a"],
        year: null,
        citation_count: 0,
        keyword_ids: ["topic-1"],
      },
    ],
  };
}

const config = {
  title: "Fixture graph",
  heading: "Fixture",
  dataset_id: "owner/dataset",
  dataset_revision: "main",
  artifact_path: "maps/publications.json",
};

test("deriveGraph creates evidence-backed edges and coverage counts", () => {
  const graph = build.deriveGraph(artifactFixture(), config, "a".repeat(40));
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].works[0].title, "A shared paper");
  assert.equal(graph.edges[0].cross_department, true);
  assert.deepEqual(graph.counts, {
    work_count: 2,
    faculty_count: 3,
    mapped_faculty_count: 2,
    connected_faculty_count: 2,
    mapped_without_collaboration_count: 0,
    unmapped_faculty_count: 1,
    edge_count: 1,
    multiple_faculty_work_count: 1,
    pair_work_count: 1,
    cross_department_edge_count: 1,
  });
  assert.equal(graph.quality.missing_year_count, 1);
  graph.nodes.forEach((node) => {
    assert.equal(Number.isFinite(node.x), true);
    assert.equal(Number.isFinite(node.y), true);
  });
});

test("deriveGraph rejects duplicate work keys and broken faculty joins", () => {
  const duplicate = artifactFixture();
  duplicate.points[1].work_id = "work-1";
  assert.throws(() => build.deriveGraph(duplicate, config, "a".repeat(40)), /Duplicate/);

  const orphan = artifactFixture();
  orphan.points[0].faculty_ids = ["missing"];
  assert.throws(() => build.deriveGraph(orphan, config, "a".repeat(40)), /no valid faculty/);
});

test("configuration and asset stamping enforce safe inputs", () => {
  assert.equal(build.parseConfig(config).dataset_id, "owner/dataset");
  assert.throws(
    () => build.parseConfig({ ...config, artifact_path: "../secret" }),
    /Invalid artifact_path/,
  );
  const html = [
    "assets/theme.js",
    "assets/collaboration.css",
    "assets/collaboration-core.js",
    "assets/collaboration.js",
  ].join(" ");
  assert.match(build.stampAssetUrls(html, "abc"), /assets\/theme\.js\?v=abc/);
});
