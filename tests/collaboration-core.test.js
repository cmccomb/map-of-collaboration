"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../assets/collaboration-core.js");

function fixture() {
  return {
    schema_version: 1,
    title: "Fixture",
    generated_at_utc: "2026-10-23T00:00:00Z",
    source: { dataset_revision: "a".repeat(40) },
    quality: { missing_year_count: 1 },
    counts: { faculty_count: 3 },
    years: { minimum: 2020, maximum: 2024, missing_count: 1 },
    departments: [
      {
        department_id: "one",
        title: "Department One",
        short_title: "One",
        color_dark: "#ffffff",
        color_light: "#000000",
        faculty_count: 2,
      },
      {
        department_id: "two",
        title: "Department Two",
        short_title: "Two",
        color_dark: "#eeeeee",
        color_light: "#111111",
        faculty_count: 1,
      },
    ],
    nodes: [
      {
        id: "a",
        name: "Ada Alpha",
        departments: ["one"],
        primary_department: "one",
        publication_count: 3,
        mapped_publication_count: 3,
        collaborator_count: 1,
        collaboration_count: 2,
        x: -0.5,
        y: 0,
      },
      {
        id: "b",
        name: "Bela Beta",
        departments: ["one"],
        primary_department: "one",
        publication_count: 4,
        mapped_publication_count: 4,
        collaborator_count: 2,
        collaboration_count: 3,
        x: 0,
        y: 0,
      },
      {
        id: "c",
        name: "Cora Gamma",
        departments: ["two"],
        primary_department: "two",
        publication_count: 1,
        mapped_publication_count: 1,
        collaborator_count: 1,
        collaboration_count: 1,
        x: 0.5,
        y: 0,
      },
    ],
    edges: [
      {
        source: "a",
        target: "b",
        cross_department: false,
        works: [
          { id: "w1", title: "First", year: 2020, citations: 1 },
          { id: "w2", title: "Second", year: 2022, citations: 2 },
        ],
      },
      {
        source: "b",
        target: "c",
        cross_department: true,
        works: [{ id: "w3", title: "Undated", year: null, citations: 0 }],
      },
    ],
  };
}

test("parseGraph validates and indexes the graph", () => {
  const graph = core.parseGraph(fixture());
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodeById.get("a").name, "Ada Alpha");
  assert.equal(graph.edgeById.get("a|b").works.length, 2);
  assert.throws(
    () => core.parseGraph({ ...fixture(), schema_version: 99 }),
    /Unsupported graph schema/,
  );
});

test("filterGraph applies time, strength, and cross-department rules", () => {
  const graph = core.parseGraph(fixture());
  const all = core.filterGraph(graph, core.defaultState(graph));
  assert.equal(all.edges.length, 2);
  assert.equal(all.nodes.length, 3);
  assert.equal(all.visibleWorkCount, 3);

  const dated = core.filterGraph(graph, {
    ...core.defaultState(graph),
    fromYear: 2021,
    toYear: 2024,
  });
  assert.deepEqual(
    dated.edges.map((edge) => [edge.id, edge.count]),
    [["a|b", 1]],
  );
  assert.equal(dated.nodes.length, 2);

  const strong = core.filterGraph(graph, {
    ...core.defaultState(graph),
    minimum: 2,
  });
  assert.deepEqual(strong.edges.map((edge) => edge.id), ["a|b"]);

  const cross = core.filterGraph(graph, {
    ...core.defaultState(graph),
    crossDepartment: true,
  });
  assert.deepEqual(cross.edges.map((edge) => edge.id), ["b|c"]);
});

test("department filtering, unconnected inclusion, and selection compose", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, {
    ...core.defaultState(graph),
    departments: ["one"],
    minimum: 3,
    showUnconnected: true,
    selectedId: "c",
  });
  assert.equal(filtered.edges.length, 0);
  assert.deepEqual(
    filtered.nodes.map((node) => node.id).sort(),
    ["a", "b", "c"],
  );
});

test("URL state is bounded and round-trips", () => {
  const graph = core.parseGraph(fixture());
  assert.deepEqual(core.stateFromSearch("", graph), core.defaultState(graph));
  const state = core.stateFromSearch(
    "?departments=two,missing&from=2010&to=2030&minimum=50&cross=1&unconnected=1&faculty=c",
    graph,
  );
  assert.deepEqual(state, {
    departments: ["two"],
    fromYear: 2020,
    toYear: 2024,
    minimum: 20,
    crossDepartment: true,
    showUnconnected: true,
    selectedId: "c",
  });
  assert.equal(
    core.stateToSearch(state, graph),
    "?departments=two&minimum=20&cross=1&unconnected=1&faculty=c",
  );
});

test("faculty search considers names and departments", () => {
  const graph = core.parseGraph(fixture());
  assert.equal(core.facultyMatches(graph, "Ada")[0].id, "a");
  assert.deepEqual(
    core.facultyMatches(graph, "Department Two").map((node) => node.id),
    ["c"],
  );
});

test("URLs are sanitized and CSV output is escaped", () => {
  assert.equal(core.safeExternalUrl("javascript:alert(1)"), "");
  assert.equal(core.safeExternalUrl("https://example.com/a"), "https://example.com/a");
  const graph = core.parseGraph(fixture());
  const csv = core.edgesToCsv(graph, core.filterGraph(graph, core.defaultState(graph)));
  assert.match(csv, /Ada Alpha,Bela Beta,2,2020,2022,no/);
  assert.match(csv, /Bela Beta,Cora Gamma,1,,,yes/);
});
