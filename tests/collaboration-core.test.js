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

function schoolGridFixture() {
  const value = schoolFixture();
  value.counts.faculty_count = 5;
  value.nodes.push({
    ...value.nodes[2],
    id: "d",
    name: "Dena Delta",
    x: 0.75,
    y: 0.2,
  });
  value.nodes.push({
    ...value.nodes[0],
    id: "e",
    name: "Evan Epsilon",
    departments: ["one", "two"],
    school_ids: ["engineering", "scs"],
    primary_department: "one",
    primary_school: "engineering",
    x: -0.2,
    y: 0.3,
  });
  value.edges.push({
    source: "c",
    target: "d",
    cross_department: false,
    cross_school: false,
    works: [{ id: "w4", title: "SCS collaboration", year: 2023 }],
  });
  value.edges.push({
    source: "c",
    target: "e",
    cross_department: true,
    cross_school: false,
    works: [{ id: "w5", title: "Cross-appointed collaboration", year: 2023 }],
  });
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

test("school filters keep both CMU endpoints in scope and preserve department links", () => {
  const graph = core.parseGraph(schoolFixture());
  assert.deepEqual(graph.schools.map((school) => school.school_id), ["engineering", "scs"]);
  assert.equal(graph.edgeById.get("b|c").cross_school, true);
  const state = core.stateFromSearch("?schools=scs,missing&cross_school=1", graph);
  assert.deepEqual(state.schools, ["scs"]);
  assert.equal(state.crossSchool, true);
  assert.equal(core.stateToSearch(state, graph), "?schools=scs&cross_school=1");
  const spaced = core.stateFromSearch("?schools=scs&layout=department-force&spacing=10&school_spacing=7", graph);
  assert.equal(spaced.departmentSpacing, 10);
  assert.equal(spaced.schoolSpacing, 7);
  assert.equal(core.stateToSearch(spaced, graph),
    "?schools=scs&layout=department-force&spacing=10&school_spacing=7");
  assert.equal(core.stateFromSearch("?school_spacing=99", graph).schoolSpacing, 10);
  assert.equal(core.stateFromSearch("?school_spacing=-5", graph).schoolSpacing, 0);
  assert.equal(core.stateFromSearch("", graph).schoolSpacing, 0);
  const scs = core.filterGraph(graph, state);
  assert.deepEqual(scs.edges, []);
  assert.deepEqual(scs.nodes, []);
  const bothSchools = core.filterGraph(graph, {
    ...state,
    schools: ["engineering", "scs"],
  });
  assert.deepEqual(bothSchools.edges.map((edge) => edge.id), ["b|c"]);
  assert.match(core.edgesToCsv(graph, bothSchools), /cross_department,cross_school/);
  assert.match(core.edgesToCsv(graph, bothSchools), /Bela Beta,Cora Gamma,1,,,yes,yes/);
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

test("all layouts keep selected-school faculty and fold cross appointments", () => {
  const graph = core.parseGraph(schoolGridFixture());
  assert.equal(core.schoolEligible(graph, graph.nodeById.get("a"), ["scs"]), false);
  assert.equal(core.schoolEligible(graph, graph.nodeById.get("e"), ["scs"]), true);
  assert.equal(core.layoutDepartmentId(graph.nodeById.get("e")), "one");
  for (const layout of ["collaboration", "department-force", "departments"]) {
    const suffix = layout === "collaboration" ? "" : `&layout=${layout}`;
    const scsState = core.stateFromSearch(`?schools=scs${suffix}`, graph);
    const scs = core.filterGraph(graph, scsState);
    assert.deepEqual(scs.edges.map((edge) => edge.id).sort(), ["c|d", "c|e"]);
    assert.deepEqual(scs.nodes.map((node) => node.id).sort(), ["c", "d", "e"]);
    assert(scs.nodes.every((node) => node.school_ids.includes("scs")));
    for (const node of scs.nodes) {
      assert.equal(core.layoutDepartmentId(node, scsState.departments, graph, scsState.schools), "two");
    }
    assert.deepEqual(
      [...core.departmentGridLayout(scs, graph, scsState.departments, scsState.schools).keys()].sort(),
      ["c", "d", "e"],
    );
    if (layout === "department-force") {
      assert.deepEqual(
        [...core.departmentForceLayout(scs, graph, 3, [], 0, scsState.schools).keys()].sort(),
        ["c", "d", "e"],
      );
    }

    const engineeringState = core.stateFromSearch(`?schools=engineering${suffix}`, graph);
    const engineering = core.filterGraph(graph, engineeringState);
    assert.deepEqual(engineering.edges.map((edge) => edge.id), ["a|b"]);
    assert.deepEqual(engineering.nodes.map((node) => node.id), ["a", "b"]);
    const withRoster = core.filterGraph(graph, { ...engineeringState, showUnconnected: true });
    assert.deepEqual(withRoster.nodes.map((node) => node.id), ["a", "b", "e"]);
    assert(withRoster.nodes.every((node) => node.school_ids.includes("engineering")));
  }
  const unfilteredGrid = core.filterGraph(graph, core.stateFromSearch("?layout=departments", graph));
  assert(unfilteredGrid.edges.some((edge) => edge.id === "b|c"));
});

test("all layouts drop outside-school department and person selections from URLs", () => {
  const graph = core.parseGraph(schoolGridFixture());
  for (const layout of ["collaboration", "department-force", "departments"]) {
    const suffix = layout === "collaboration" ? "" : `&layout=${layout}`;
    const state = core.stateFromSearch(
      `?schools=scs${suffix}&departments=one&faculty=a,e`, graph,
    );
    assert.deepEqual(state.departments, []);
    assert.deepEqual(state.selectedIds, ["e"]);
    assert.equal(core.stateToSearch(state, graph), `?schools=scs${suffix}&faculty=e`);
    const filtered = core.filterGraph(graph, { ...state, selectedIds: ["a", "e"] });
    assert.deepEqual(filtered.nodes.map((node) => node.id).sort(), ["c", "d", "e"]);
  }
  const engineering = core.stateFromSearch("?schools=engineering&departments=two&faculty=c,e", graph);
  assert.deepEqual(engineering.departments, []);
  assert.deepEqual(engineering.selectedIds, ["e"]);
  assert.equal(core.stateToSearch(engineering, graph), "?schools=engineering&faculty=e");
  assert.equal(core.layoutDepartmentId(graph.nodeById.get("e"), ["two"], graph, ["scs"]), "two");
});

test("all layouts reject an external person linked only to another school", () => {
  const value = schoolGridFixture();
  value.nodes.push({
    id: "external-historian",
    kind: "external_coauthor",
    name: "Historical Coauthor",
    departments: [],
    school_ids: [],
    x: 0.9,
    y: 0.3,
  });
  value.edges.push({
    source: "a",
    target: "external-historian",
    cross_department: false,
    cross_school: false,
    works: [{ id: "w6", title: "Engineering history", year: 2023 }],
  });
  const graph = core.parseGraph(value);
  for (const layout of ["collaboration", "department-force", "departments"]) {
    const suffix = layout === "collaboration" ? "" : `&layout=${layout}`;
    const state = core.stateFromSearch(
      `?schools=scs${suffix}&faculty=external-historian`, graph,
    );
    assert.deepEqual(state.selectedIds, []);
    assert.equal(state.showExternal, false);
    assert.equal(core.stateToSearch(state, graph), `?schools=scs${suffix}`);
    assert.deepEqual(core.filterGraph(graph, { ...state, showExternal: true }).nodes
      .map((node) => node.id).sort(), ["c", "d", "e"]);
  }
});

test("external coauthor stays outside CMU but is searchable and visible with an MCS collaborator", () => {
  const value = schoolFixture();
  value.schools[1] = { school_id: "mcs", title: "Mellon College of Science" };
  value.departments[1].school_id = "mcs";
  value.nodes[2].school_ids = ["mcs"];
  value.nodes.push({
    id: "external-paul-erdos",
    kind: "external_coauthor",
    name: "Paul Erdős",
    departments: [],
    primary_department: "",
    school_ids: [],
    primary_school: "",
    mapped_publication_count: 2,
    homepage_url: "https://example.com/erdos",
    x: 0.7,
    y: 0.2,
  });
  value.edges = [{
    source: "c",
    target: "external-paul-erdos",
    cross_department: false,
    cross_school: false,
    works: [
      {
        id: "1990-paper",
        title: "Representations of integers as the sum of k terms",
        year: 1990,
        doi: "10.1002/rsa.3240010302",
        source_types: ["curated_verified"],
        source_verified_at: "2026-10-24",
        source_verification_urls: ["https://doi.org/10.1002/rsa.3240010302"],
      },
      { id: "1995-paper", title: "Independence of solution sets and minimal asymptotic bases", year: 1995 },
    ],
  }];
  value.years.minimum = 1990;
  const graph = core.parseGraph(value);
  const erdos = graph.nodeById.get("external-paul-erdos");
  assert.equal(erdos.kind, "external_coauthor");
  assert.deepEqual(erdos.departments, []);
  assert.deepEqual(erdos.school_ids, []);
  assert.equal(erdos.primary_department, "");
  assert.equal(erdos.primary_school, "");
  assert.equal(core.facultyMatches(graph, "erdős")[0].id, erdos.id);
  assert.equal(graph.edges[0].works[0].source_types[0], "curated_verified");
  assert.equal(graph.edges[0].works[0].source_verified_at, "2026-10-24");
  assert.equal(graph.edges[0].works[0].source_verification_urls[0], "https://doi.org/10.1002/rsa.3240010302");
  assert.equal(core.defaultState(graph).showExternal, false);
  const hidden = core.filterGraph(graph, core.stateFromSearch("?schools=mcs", graph));
  assert.equal(hidden.edges.length, 0);
  assert.deepEqual(hidden.nodes.map((node) => node.id), ["c"]);
  assert.equal(hidden.nodes[0].hidden_external_connection, true);
  const mcsState = core.stateFromSearch("?schools=mcs&external=1", graph);
  assert.equal(mcsState.showExternal, true);
  assert.equal(core.stateToSearch(mcsState, graph), "?schools=mcs&external=1");
  const mcs = core.filterGraph(graph, mcsState);
  assert.equal(mcs.edges.length, 1);
  assert.deepEqual(mcs.nodes.map((node) => node.id).sort(), ["c", "external-paul-erdos"]);
  for (const layout of ["collaboration", "department-force", "departments"]) {
    const suffix = layout === "collaboration" ? "" : `&layout=${layout}`;
    const hiddenView = core.stateFromSearch(`?schools=mcs${suffix}`, graph);
    const hiddenGraph = core.filterGraph(graph, hiddenView);
    assert.deepEqual(hiddenGraph.nodes.map((node) => node.id), ["c"]);
    assert.equal(hiddenGraph.nodes[0].hidden_external_connection, true);
    const visibleView = core.stateFromSearch(`?schools=mcs${suffix}&external=1`, graph);
    const visibleGraph = core.filterGraph(graph, visibleView);
    assert.deepEqual(visibleGraph.nodes.map((node) => node.id).sort(), ["c", "external-paul-erdos"]);
    assert.equal(visibleGraph.edges.length, 1);
    assert.equal(core.layoutDepartmentId(visibleGraph.nodeById.get("c"), [], graph, ["mcs"]), "two");
    const selectedErdos = core.stateFromSearch(
      `?schools=mcs${suffix}&faculty=external-paul-erdos,a`, graph,
    );
    assert.deepEqual(selectedErdos.selectedIds, ["external-paul-erdos"]);
    assert.equal(selectedErdos.showExternal, true);
    assert.equal(core.stateToSearch(selectedErdos, graph),
      `?schools=mcs&external=1${suffix}&faculty=external-paul-erdos`);
  }
  for (const positions of [
    core.collaborationLayout(mcs),
    core.departmentGridLayout(mcs, graph),
    core.departmentForceLayout(mcs, graph),
  ]) {
    assert.deepEqual([...positions.keys()].sort(), ["c", "external-paul-erdos"]);
    assert([...positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  }
  const math = core.filterGraph(graph, core.stateFromSearch("?departments=two&external=1", graph));
  assert.equal(math.edges.length, 1);
  const crossSchool = core.filterGraph(graph, core.stateFromSearch("?schools=mcs&external=1&cross_school=1", graph));
  assert.equal(crossSchool.edges.length, 0);
  assert.equal(core.stateFromSearch("?faculty=external-paul-erdos", graph).showExternal, true);
  const csv = core.edgesToCsv(graph, mcs);
  assert.match(csv, /^person_1,person_1_kind,person_2,person_2_kind,/);
  assert.match(csv, /external_coauthor/);

  value.nodes.at(-1).school_ids = ["mcs"];
  assert.throws(() => core.parseGraph(value), /must not have a CMU school/);
  value.nodes.at(-1).school_ids = [];
  value.nodes.at(-1).departments = ["two"];
  assert.throws(() => core.parseGraph(value), /must not have a CMU department/);
  value.nodes.at(-1).departments = [];
  value.edges[0].cross_school = true;
  assert.throws(() => core.parseGraph(value), /External coauthor edges cannot be cross/);
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
    primary_department: "",
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
  assert.equal(graph.nodeById.get("a").primary_department, "");
  assert.deepEqual(graph.nodeById.get("a").roles, []);
  assert.equal(graph.nodeById.get("a").mapped_publication_count, 0);
  assert.equal(graph.edgeById.get("a|b").works[0].title, "Untitled work");
  assert.equal(graph.edgeById.get("a|b").works[0].year, null);
  assert.equal(graph.edgeById.get("a|b").works[0].citations, 0);
});

test("parseGraph keeps unresolved primaries and rejects invented or mismatched ones", () => {
  const value = schoolGridFixture();
  const joint = value.nodes.find((node) => node.id === "e");
  joint.primary_department = "";
  joint.primary_school = "";
  const graph = core.parseGraph(value);
  const unresolved = graph.nodeById.get("e");
  assert.equal(unresolved.primary_department, "");
  assert.equal(unresolved.primary_school, "");
  assert.deepEqual(unresolved.departments, ["one", "two"]);
  assert.equal(core.layoutDepartmentId(unresolved), "__primary_unresolved__");
  assert.equal(core.layoutDepartmentId(unresolved, ["two"], graph, ["scs"]),
    "__primary_unresolved__");
  assert.equal(core.facultyLabelEligible(unresolved, ["one"]), false);
  assert.equal(core.filterGraph(graph, {
    ...core.defaultState(graph), departments: ["two"], showUnconnected: true,
  }).nodes.some((node) => node.id === "e"), true);
  joint.primary_department = "missing";
  assert.throws(() => core.parseGraph(value), /primary department outside their memberships/);
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
    showExternal: false,
    showUnconnected: true,
    layout: "department-force",
    departmentSpacing: 5,
    schoolSpacing: 0,
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
  assert.equal(core.stateFromSearch("?layout=department-force&spacing=99", graph).departmentSpacing, 10);
  assert.equal(core.stateFromSearch("?school_spacing=8", graph).schoolSpacing, 0);
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

test("automatic labels keep department limits while admitting external coauthors", () => {
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
    true,
  );
  assert.equal(core.facultyLabelEligible({ departments: ["one", "two"], primary_department: "" }), false);
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
  assert.equal(
    core.facultyLabelEligible({ kind: "external_coauthor", departments: [] }),
    true,
  );
  assert.equal(
    core.facultyLabelEligible({ kind: "external_coauthor", departments: [] }, ["two"]),
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
  const maximum = core.departmentForceLayout(filtered, graph, 10);
  assert.ok(departmentDistance(maximum) > departmentDistance(far));
  assert.deepEqual(core.departmentForceLayout(filtered, graph, 99), maximum);
  assert.deepEqual(core.departmentForceLayout({ nodes: [] }, graph), new Map());
  assert.deepEqual(
    core.departmentForceLayout(
      { nodes: [{ id: "solo" }] },
      graph,
    ),
    new Map([["solo", { x: 0, y: 0 }]]),
  );
});

test("school and college distance separates display groups, including joint appointments", () => {
  const graph = core.parseGraph(schoolFixture());
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const neutral = core.departmentForceLayout(filtered, graph, 3, [], 0);
  const distant = core.departmentForceLayout(filtered, graph, 3, [], 10);
  const distanceFromEngineering = (positions) => {
    const center = {
      x: (positions.get("a").x + positions.get("b").x) / 2,
      y: (positions.get("a").y + positions.get("b").y) / 2,
    };
    return Math.hypot(positions.get("c").x - center.x, positions.get("c").y - center.y);
  };
  assert.ok(distanceFromEngineering(distant) > distanceFromEngineering(neutral));
  assert.deepEqual(core.departmentForceLayout(filtered, graph, 3, [], 0), neutral);

  const shared = schoolFixture();
  shared.nodes[1].departments.push("two");
  shared.nodes[1].school_ids.push("scs");
  const sharedGraph = core.parseGraph(shared);
  const pairNodes = [sharedGraph.nodeById.get("b"), sharedGraph.nodeById.get("c")];
  const sharedPair = {
    nodes: pairNodes,
    edges: [{ ...sharedGraph.edgeById.get("b|c"), count: 1 }],
    nodeById: new Map(pairNodes.map((node) => [node.id, node])),
  };
  assert.equal(core.forceDepartmentAssignments(sharedPair, sharedGraph, 10).get("b"), "one");
  const sharedNeutral = core.departmentForceLayout(sharedPair, sharedGraph, 3, [], 0);
  const sharedDistant = core.departmentForceLayout(sharedPair, sharedGraph, 3, [], 10);
  const pairDistance = (positions) =>
    Math.hypot(positions.get("b").x - positions.get("c").x,
      positions.get("b").y - positions.get("c").y);
  assert.ok(pairDistance(sharedDistant) > pairDistance(sharedNeutral));
});

test("whole-CMU force view forms Engineering, MCS, and separate SCS departments", () => {
  const value = schoolGridFixture();
  value.schools.push({ school_id: "mcs", title: "Mellon College of Science" });
  value.departments.push(
    { department_id: "s3d", title: "Software and Societal Systems", school_id: "scs" },
    { department_id: "math", title: "Mathematical Sciences", school_id: "mcs" },
  );
  value.nodes.find((node) => node.id === "e").departments = ["one", "s3d"];
  value.nodes.push(
    { ...value.nodes.find((node) => node.id === "e"), id: "f", name: "S3D colleague",
      primary_department: "s3d", primary_school: "scs" },
    { ...value.nodes.find((node) => node.id === "c"), id: "g", name: "MCS one",
      departments: ["math"], primary_department: "math", school_ids: ["mcs"] },
    { ...value.nodes.find((node) => node.id === "c"), id: "h", name: "MCS two",
      departments: ["math"], primary_department: "math", school_ids: ["mcs"] },
  );
  const work = (id) => [{ id, title: id, year: 2023 }];
  value.edges.push(
    { source: "e", target: "f", cross_department: false, works: work("w6") },
    { source: "g", target: "h", cross_department: false, works: work("w7") },
    { source: "b", target: "g", cross_department: true, cross_school: true,
      works: work("w8") },
  );
  const graph = core.parseGraph(value);
  const filtered = core.filterGraph(graph, core.defaultState(graph));
  const assigned = core.forceDepartmentAssignments(filtered, graph, 10);
  assert.equal(assigned.get("e"), "one");
  assert.equal(assigned.get("f"), "s3d");
  assert.equal(assigned.get("c"), "two");
  assert.equal(assigned.get("g"), "math");

  const positions = core.departmentForceLayout(filtered, graph, 1, [], 10);
  const center = (ids) => ({
    x: ids.reduce((sum, id) => sum + positions.get(id).x, 0) / ids.length,
    y: ids.reduce((sum, id) => sum + positions.get(id).y, 0) / ids.length,
  });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const engineering = center(["a", "b", "e"]);
  const scs = center(["c", "d", "f"]);
  const mcs = center(["g", "h"]);
  const csd = center(["c", "d"]);
  const s3d = center(["f"]);
  assert.ok(distance(engineering, scs) > 8);
  assert.ok(distance(engineering, mcs) > 8);
  assert.ok(distance(scs, mcs) > 8);
  assert.ok(distance(csd, s3d) > 1);
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
