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

function schoolFixture() {
  const value = fixture();
  value.schools = [
    { school_id: "engineering", title: "College of Engineering" },
    { school_id: "scs", title: "School of Computer Science" },
  ];
  value.departments[0].school_id = "engineering";
  value.departments[1].school_id = "scs";
  value.nodes[0].school_ids = ["engineering"];
  value.nodes[1].school_ids = ["engineering"];
  value.nodes[2].school_ids = ["scs"];
  value.edges[1].cross_school = true;
  return value;
}

test("parseGraph validates and indexes the graph", () => {
  const graph = core.parseGraph(fixture());
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodeById.get("a").name, "Ada Alpha");
  assert.equal(graph.edgeById.get("a|b").works.length, 2);
  assert.deepEqual(graph.nodeById.get("a").school_ids, ["engineering"]);
  assert.equal(graph.schoolById.get("engineering").title, "College of Engineering");
  assert.equal(core.stateFromSearch("?cross_school=1", graph).crossSchool, false);
  assert.throws(
    () => core.parseGraph({ ...fixture(), schema_version: 99 }),
    /Unsupported graph schema/,
  );
});

test("school filters preserve outward edges and legacy department links", () => {
  const graph = core.parseGraph(schoolFixture());
  assert.deepEqual(graph.schools.map((school) => school.school_id), ["engineering", "scs"]);
  assert.equal(graph.edgeById.get("b|c").cross_school, true);
  const state = core.stateFromSearch("?schools=scs,missing&cross_school=1", graph);
  assert.deepEqual(state.schools, ["scs"]);
  assert.equal(state.crossSchool, true);
  assert.equal(core.stateToSearch(state, graph), "?schools=scs&cross_school=1");
  const scs = core.filterGraph(graph, state);
  assert.deepEqual(scs.edges.map((edge) => edge.id), ["b|c"]);
  assert.deepEqual(scs.nodes.map((node) => node.id).sort(), ["b", "c"]);
  assert.match(core.edgesToCsv(graph, scs), /cross_department,cross_school/);
  assert.match(core.edgesToCsv(graph, scs), /Bela Beta,Cora Gamma,1,,,yes,yes/);
  const department = core.filterGraph(graph, {
    ...core.defaultState(graph),
    departments: ["two"],
  });
  assert.deepEqual(department.edges, []);
  const unconnected = core.filterGraph(graph, {
    ...state,
    minimum: 2,
    showUnconnected: true,
  });
  assert.deepEqual(unconnected.nodes.map((node) => node.id), ["c"]);
});

test("parseGraph validates school joins", () => {
  const cases = [
    [(value) => (value.schools = []), /missing schools/],
    [(value) => (value.schools[1].school_id = "engineering"), /duplicate school ID/],
    [(value) => (value.departments[1].school_id = "missing"), /invalid school/],
    [(value) => (value.nodes[2].school_ids = []), /invalid school memberships/],
    [(value) => (value.nodes[2].school_ids = ["missing"]), /invalid school memberships/],
  ];
  for (const [mutate, pattern] of cases) {
    const value = schoolFixture();
    mutate(value);
    assert.throws(() => core.parseGraph(value), pattern);
  }
});

test("parseGraph rejects malformed graph relationships", () => {
  const cases = [
    [() => null, /must be an object/],
    [(value) => ({ ...value, nodes: null }), /missing nodes/],
    [(value) => ({ ...value, edges: null }), /missing edges/],
    [(value) => ({ ...value, departments: null }), /missing departments/],
    [
      (value) => ({
        ...value,
        departments: [...value.departments, { ...value.departments[0] }],
      }),
      /department ID/,
    ],
    [
      (value) => ({
        ...value,
        nodes: value.nodes.map((node, index) => (index === 0 ? { ...node, id: "" } : node)),
      }),
      /faculty ID/,
    ],
    [
      (value) => ({
        ...value,
        nodes: value.nodes.map((node, index) =>
          index === 0 ? { ...node, departments: ["missing"] } : node,
        ),
      }),
      /no valid department/,
    ],
    [
      (value) => ({
        ...value,
        nodes: value.nodes.map((node, index) => (index === 0 ? { ...node, x: NaN } : node)),
      }),
      /no position/,
    ],
    [
      (value) => ({
        ...value,
        edges: value.edges.map((edge, index) =>
          index === 0 ? { ...edge, target: edge.source } : edge,
        ),
      }),
      /Self-edge/,
    ],
    [
      (value) => ({
        ...value,
        edges: value.edges.map((edge, index) =>
          index === 0 ? { ...edge, target: "missing" } : edge,
        ),
      }),
      /unknown faculty ID/,
    ],
    [
      (value) => ({
        ...value,
        edges: [...value.edges, { ...value.edges[0], source: "b", target: "a" }],
      }),
      /Duplicate edge/,
    ],
    [
      (value) => ({
        ...value,
        edges: value.edges.map((edge, index) => (index === 0 ? { ...edge, works: [] } : edge)),
      }),
      /has no works/,
    ],
    [
      (value) => ({
        ...value,
        edges: value.edges.map((edge, index) =>
          index === 0 ? { ...edge, works: [...edge.works, { ...edge.works[0] }] } : edge,
        ),
      }),
      /duplicate work/,
    ],
    [
      (value) => ({ ...value, years: { minimum: 2025, maximum: 2020 } }),
      /invalid year domain/,
    ],
  ];

  for (const [mutate, pattern] of cases) {
    assert.throws(() => core.parseGraph(mutate(fixture())), pattern);
  }
});

test("parseGraph applies safe defaults to optional graph metadata", () => {
  const value = fixture();
  value.title = "";
  value.generated_at_utc = "";
  value.source = null;
  value.quality = null;
  value.counts = null;
  value.years = null;
  value.departments[0] = {
    department_id: "one",
    title: "",
    short_title: "",
    directory_url: "not a URL",
    color_dark: "",
    color_light: "",
    faculty_count: -1,
  };
  value.nodes[0] = {
    ...value.nodes[0],
    name: "",
    primary_department: "missing",
    roles: null,
    publication_count: "invalid",
    mapped_publication_count: -1,
    collaborator_count: null,
    collaboration_count: "",
    homepage_url: "mailto:test@example.com",
  };
  value.edges[0].works[0] = {
    id: "w1",
    title: "",
    year: "invalid",
    venue: "",
    citations: -2,
    url: "",
    doi: "",
    topic: "",
  };

  const graph = core.parseGraph(value);
  assert.equal(graph.title, "CMU Engineering Collaborations");
  assert.deepEqual(graph.source, {});
  assert.deepEqual(graph.quality, {});
  assert.deepEqual(graph.counts, {});
  assert.equal(graph.years.minimum, 0);
  assert.ok(graph.years.maximum >= 2026);
  assert.equal(graph.departmentById.get("one").title, "one");
  assert.equal(graph.departmentById.get("one").short_title, "one");
  assert.equal(graph.departmentById.get("one").directory_url, "");
  assert.equal(graph.nodeById.get("a").name, "a");
  assert.equal(graph.nodeById.get("a").primary_department, "one");
  assert.deepEqual(graph.nodeById.get("a").roles, []);
  assert.equal(graph.nodeById.get("a").mapped_publication_count, 0);
  assert.equal(graph.edgeById.get("a|b").works[0].title, "Untitled work");
  assert.equal(graph.edgeById.get("a|b").works[0].year, null);
  assert.equal(graph.edgeById.get("a|b").works[0].citations, 0);
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
    selectedIds: ["c"],
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
    "?departments=two,missing&from=2010&to=2030&minimum=50&cross=1&unconnected=1&layout=department-force&spacing=5&faculty=c,a,missing,c",
    graph,
  );
  assert.deepEqual(state, {
    departments: ["two"],
    schools: [],
    fromYear: 2020,
    toYear: 2024,
    minimum: 20,
    crossDepartment: true,
    crossSchool: false,
    showUnconnected: true,
    layout: "department-force",
    departmentSpacing: 5,
    selectedIds: ["c", "a"],
  });
  assert.equal(
    core.stateToSearch(state, graph),
    "?departments=two&minimum=20&cross=1&unconnected=1&layout=department-force&spacing=5&faculty=c%2Ca",
  );
  assert.deepEqual(core.stateFromSearch("?faculty=b", graph).selectedIds, ["b"]);
  assert.deepEqual(core.stateFromSearch("?from=2024&to=2020", graph), {
    ...core.defaultState(graph),
    fromYear: 2020,
    toYear: 2024,
  });
  assert.equal(
    core.stateToSearch({ ...core.defaultState(graph), selectedIds: null }, graph),
    "",
  );
  assert.equal(core.stateFromSearch("?layout=unsupported", graph).layout, "collaboration");
  assert.equal(core.stateFromSearch("?layout=departments", graph).layout, "departments");
  assert.equal(core.stateFromSearch("?layout=department-force&spacing=99", graph).departmentSpacing, 5);
  assert.equal(
    core.stateToSearch({ ...core.defaultState(graph), departmentSpacing: undefined }, graph),
    "",
  );
  assert.deepEqual(core.validFacultyIds("a", graph), ["a"]);
});

test("faculty search considers names and departments", () => {
  const graph = core.parseGraph(fixture());
  assert.equal(core.facultyMatches(graph, "Ada")[0].id, "a");
  assert.deepEqual(
    core.facultyMatches(graph, "Department Two").map((node) => node.id),
    ["c"],
  );
  assert.deepEqual(core.facultyMatches(graph, "Department", 10, ["a", "c"]), [
    graph.nodeById.get("b"),
  ]);
  assert.deepEqual(core.facultyMatches(graph, ""), []);
  assert.equal(core.facultyMatches(graph, "Alpha")[0].id, "a");
  assert.equal(core.facultyMatches(graph, "da")[0].id, "a");
  assert.equal(core.facultyMatches(graph, "One", 1).length, 1);
});

test("automatic labels stay within explicitly selected primary departments", () => {
  assert.equal(core.departmentLabelEligible("one"), true);
  assert.equal(core.departmentLabelEligible("one", ["two"]), false);
  assert.equal(core.departmentLabelEligible("one", ["one", "two"]), true);
  assert.equal(
    core.facultyLabelEligible({ departments: ["one"], primary_department: "one" }),
    true,
  );
  assert.equal(
    core.facultyLabelEligible({ departments: ["one"], primary_department: "one" }, ["two"]),
    false,
  );
  assert.equal(
    core.facultyLabelEligible({ departments: ["one", "two"], primary_department: "one" }),
    false,
  );
  assert.equal(
    core.facultyLabelEligible(
      { departments: ["one", "two"], primary_department: "one" },
      ["two"],
    ),
    false,
  );
  assert.equal(
    core.facultyLabelEligible(
      { departments: ["one", "two"], primary_department: "one" },
      ["one"],
    ),
    true,
  );
});

test("multi-selection builds the union of selected neighborhoods", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const selection = core.subgraphForSelection(filtered, ["a", "c", "a", "missing"]);

  assert.deepEqual(selection.selectedIds, ["a", "c"]);
  assert.deepEqual(selection.nodes.map((node) => node.id), ["a", "b", "c"]);
  assert.deepEqual(selection.edges.map((edge) => edge.id), ["a|b", "b|c"]);
  assert.equal(selection.visibleWorkCount, 3);
  assert.equal(selection.maximumEdgeCount, 2);
  assert.equal(selection.selectedIdSet.has("b"), false);
  assert.deepEqual(core.subgraphForSelection(filtered, []).nodes, []);
});

test("multi-selection layout is deterministic and includes every selected neighborhood", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const first = core.selectionLayout(filtered, ["a", "c"]);
  const second = core.selectionLayout(filtered, ["a", "c"]);

  assert.deepEqual(first, second);
  assert.deepEqual([...first.keys()].sort(), ["a", "b", "c"]);
  for (const position of first.values()) {
    assert.equal(Number.isFinite(position.x), true);
    assert.equal(Number.isFinite(position.y), true);
  }
  assert.deepEqual(core.selectionLayout(filtered, []), new Map());
});

test("selection layout centers an ego network without moving unrelated faculty", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const positions = core.selectionLayout(filtered, "b");

  assert.deepEqual(positions.get("b"), { x: 0, y: 0 });
  assert.equal(positions.has("a"), true);
  assert.equal(positions.has("c"), true);
  assert.equal(positions.size, 3);
  for (const id of ["a", "c"]) {
    const position = positions.get(id);
    assert.ok(Math.abs(Math.hypot(position.x, position.y) - 0.26) < 1e-9);
  }
  assert.deepEqual(core.selectionLayout(filtered, "missing"), new Map());
});

test("collaboration layout is deterministic and returns finite positions", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const first = core.collaborationLayout(filtered);
  const second = core.collaborationLayout(filtered);

  assert.deepEqual(first, second);
  assert.equal(first.size, filtered.nodes.length);
  for (const position of first.values()) {
    assert.equal(Number.isFinite(position.x), true);
    assert.equal(Number.isFinite(position.y), true);
  }
});

test("department grid separates deterministic affiliation clusters", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const first = core.departmentGridLayout(filtered, graph);
  const second = core.departmentGridLayout(filtered, graph);

  assert.deepEqual(first, second);
  assert.deepEqual([...first.keys()].sort(), ["a", "b", "c"]);
  for (const position of first.values()) {
    assert.equal(Number.isFinite(position.x), true);
    assert.equal(Number.isFinite(position.y), true);
  }
  const distance = (left, right) =>
    Math.hypot(first.get(left).x - first.get(right).x, first.get(left).y - first.get(right).y);
  assert.ok(distance("a", "b") < distance("b", "c"));
  assert.deepEqual(core.departmentGridLayout({ nodes: [] }, graph), new Map());

  const oneDepartment = core.filterGraph(graph, {
    ...core.defaultState(graph),
    departments: ["one"],
  });
  const centered = core.departmentGridLayout(oneDepartment, graph);
  const centerX = [...centered.values()].reduce((sum, point) => sum + point.x, 0) / centered.size;
  const centerY = [...centered.values()].reduce((sum, point) => sum + point.y, 0) / centered.size;
  assert.ok(Math.abs(centerX) < 1e-9);
  assert.ok(Math.abs(centerY) < 1e-9);
});

test("department layouts fold secondary matches into a selected affiliation", () => {
  const value = fixture();
  value.nodes[2].departments = ["two", "one"];
  const graph = core.parseGraph(value);
  const filtered = core.filterGraph(graph, {
    ...core.defaultState(graph),
    departments: ["one"],
  });
  const secondary = graph.nodeById.get("c");

  assert.equal(core.layoutDepartmentId(secondary), "two");
  assert.equal(core.layoutDepartmentId(secondary, ["missing"]), "two");
  assert.equal(core.layoutDepartmentId(secondary, ["one"]), "one");
  assert.equal(core.layoutDepartmentId(secondary, ["one", "two"]), "two");

  const distanceFromPrimaryCluster = (positions) => {
    const center = {
      x: (positions.get("a").x + positions.get("b").x) / 2,
      y: (positions.get("a").y + positions.get("b").y) / 2,
    };
    return Math.hypot(positions.get("c").x - center.x, positions.get("c").y - center.y);
  };
  const separatedGrid = core.departmentGridLayout(filtered, graph);
  const foldedGrid = core.departmentGridLayout(filtered, graph, ["one"]);
  const separatedForce = core.departmentForceLayout(filtered, graph, 3);
  const foldedForce = core.departmentForceLayout(filtered, graph, 3, ["one"]);

  assert.ok(distanceFromPrimaryCluster(foldedGrid) < distanceFromPrimaryCluster(separatedGrid));
  assert.ok(distanceFromPrimaryCluster(foldedForce) < distanceFromPrimaryCluster(separatedForce));
});

test("department force layout is deterministic, organic, and tunably separated", () => {
  const graph = core.parseGraph(fixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const balanced = core.departmentForceLayout(filtered, graph, 3);
  const repeated = core.departmentForceLayout(filtered, graph, 3);
  const close = core.departmentForceLayout(filtered, graph, 1);
  const compact = core.departmentForceLayout(filtered, graph, 2);
  const open = core.departmentForceLayout(filtered, graph, 4);
  const far = core.departmentForceLayout(filtered, graph, 5);

  assert.deepEqual(balanced, repeated);
  assert.deepEqual([...balanced.keys()].sort(), ["a", "b", "c"]);
  for (const position of balanced.values()) {
    assert.equal(Number.isFinite(position.x), true);
    assert.equal(Number.isFinite(position.y), true);
  }
  const departmentDistance = (positions) => {
    const one = {
      x: (positions.get("a").x + positions.get("b").x) / 2,
      y: (positions.get("a").y + positions.get("b").y) / 2,
    };
    return Math.hypot(one.x - positions.get("c").x, one.y - positions.get("c").y);
  };
  assert.ok(departmentDistance(far) > departmentDistance(close));
  assert.ok(departmentDistance(far) > departmentDistance(balanced) * 1.5);
  assert.ok(
    departmentDistance(far) - departmentDistance(open) >
      departmentDistance(balanced) - departmentDistance(compact),
  );
  assert.deepEqual(core.departmentForceLayout(filtered, graph, 99), far);
  assert.deepEqual(core.departmentForceLayout({ nodes: [] }, graph), new Map());
  assert.deepEqual(
    core.departmentForceLayout(
      { nodes: [{ id: "solo" }] },
      graph,
    ),
    new Map([["solo", { x: 0, y: 0 }]]),
  );
});

test("collaboration layout removes a simple pair of crossing connections", () => {
  const nodes = [
    { id: "a", x: -1, y: -1, degree: 1, strength: 1 },
    { id: "b", x: 1, y: 1, degree: 1, strength: 1 },
    { id: "c", x: -1, y: 1, degree: 1, strength: 1 },
    { id: "d", x: 1, y: -1, degree: 1, strength: 1 },
  ];
  const edges = [
    { source: "a", target: "b", count: 1 },
    { source: "c", target: "d", count: 1 },
  ];
  const sourcePositions = new Map(nodes.map((node) => [node.id, node]));
  const filtered = {
    nodes,
    edges,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
  };

  assert.equal(core.edgeCrossingCount(edges, sourcePositions), 1);
  assert.equal(core.edgeCrossingCount(edges, core.collaborationLayout(filtered)), 0);
  assert.equal(core.edgeCrossingCount(edges, new Map()), 0);
});

test("layout helpers cover empty, singleton, overlapping, and large ego networks", () => {
  assert.deepEqual(core.collaborationLayout({ nodes: [], edges: [] }), new Map());
  assert.deepEqual(
    core.collaborationLayout({ nodes: [{ id: "solo" }], edges: [] }),
    new Map([["solo", { x: 0, y: 0 }]]),
  );

  const center = { id: "center", x: 0, y: 0, degree: 11, strength: 11 };
  const leaves = Array.from({ length: 11 }, (_, index) => ({
    id: `leaf-${index}`,
    x: 0,
    y: 0,
    degree: 1,
    strength: 1,
  }));
  const nodes = [center, ...leaves];
  const edges = leaves.map((leaf, index) => ({
    id: core.edgeKey(center.id, leaf.id),
    source: center.id,
    target: leaf.id,
    count: 12 - index,
    works: [{ id: `work-${index}` }],
  }));
  const filtered = {
    nodes,
    edges,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
  };
  assert.equal(core.selectionLayout(filtered, "center").size, 12);

  const isolated = {
    nodes: [{ id: "solo", x: 1, y: 2 }],
    edges: [],
    nodeById: new Map([["solo", { id: "solo", x: 1, y: 2 }]]),
  };
  assert.deepEqual(core.selectionLayout(isolated, "solo"), new Map([["solo", { x: 1, y: 2 }]]));
});

test("URLs are sanitized and CSV output is escaped", () => {
  assert.equal(core.safeExternalUrl("javascript:alert(1)"), "");
  assert.equal(core.safeExternalUrl("not a URL"), "");
  assert.equal(core.safeExternalUrl(), "");
  assert.equal(core.safeExternalUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(core.doiUrl(), "");
  assert.equal(core.doiUrl("https://doi.org/10.1000/example"), "https://doi.org/10.1000/example");
  assert.equal(core.edgeKey("z", "a"), "a|z");
  const graph = core.parseGraph(fixture());
  graph.nodeById.get("a").name = 'Ada, "Alpha"';
  const csv = core.edgesToCsv(graph, core.filterGraph(graph, core.defaultState(graph)));
  assert.match(csv, /"Ada, ""Alpha""",Bela Beta,2,2020,2022,no/);
  assert.match(csv, /Bela Beta,Cora Gamma,1,,,yes/);
});
