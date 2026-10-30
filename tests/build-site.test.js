"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const build = require("../scripts/build-site.js");
const core = require("../assets/collaboration-core.js");

const projectRoot = path.resolve(__dirname, "..");

function response(body, { ok = true, status = 200, contentLength } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length" && contentLength !== undefined
          ? String(contentLength)
          : null;
      },
    },
    async text() {
      return text;
    },
  };
}

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

function schoolArtifactFixture() {
  const artifact = artifactFixture();
  artifact.catalogs.schools = [
    { school_id: "engineering", title: "College of Engineering" },
    { school_id: "scs", title: "School of Computer Science" },
  ];
  artifact.catalogs.departments.forEach((department) => {
    department.school_id = "engineering";
  });
  artifact.catalogs.faculty.forEach((person) => {
    person.school_ids = ["engineering"];
  });
  artifact.points.forEach((point) => {
    point.school_ids = ["engineering"];
  });
  return artifact;
}

function pendingArtifactFixture() {
  const artifact = schoolArtifactFixture();
  artifact.schema_version = 8;
  artifact.catalogs.faculty.forEach((person) => {
    const department = artifact.catalogs.departments.find(
      (item) => item.department_id === person.memberships[0].department_id,
    );
    person.primary_academic_home_type = "department";
    person.primary_academic_home_id = department.department_id;
    person.primary_academic_home_title = department.title;
    person.primary_academic_home_school_id = "engineering";
    person.primary_academic_home_basis = "reviewed";
    person.primary_academic_home_source_url = "https://cmu.example.edu/faculty";
    person.primary_academic_home_verified_at = "2026-10-30";
  });
  artifact.pending_publication_count = 1;
  artifact.pending_publications = [{
    work_id: "work-pending",
    title: "Reviewed selected coauthored work",
    year: 2025,
    faculty_ids: ["a", "c"],
    source_url: "https://publisher.example.edu/work-pending",
    release_decision: "selected",
    map_hold_reason: "pending_topic_review",
    collaboration_eligible: true,
  }];
  return artifact;
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
  assert.equal(graph.edges[0].cross_school, false);
  assert.deepEqual(graph.schools.map((school) => school.school_id), ["engineering"]);
  assert.deepEqual(graph.nodes[0].school_ids, ["engineering"]);
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
    cross_school_edge_count: 0,
  });
  assert.equal(graph.quality.missing_year_count, 1);
  graph.nodes.forEach((node) => {
    assert.equal(Number.isFinite(node.x), true);
    assert.equal(Number.isFinite(node.y), true);
  });
});

test("schema 8 includes selected pending coauthorship without calling it mapped", () => {
  const artifact = pendingArtifactFixture();
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const oldEdge = graph.edges.find((edge) => edge.source === "a" && edge.target === "b");
  const pendingEdge = graph.edges.find((edge) => edge.source === "a" && edge.target === "c");
  assert.deepEqual(oldEdge.works.map((work) => work.id), ["work-1"]);
  assert.equal(pendingEdge.works.length, 1);
  assert.equal(pendingEdge.works[0].id, "work-pending");
  assert.equal(pendingEdge.works[0].topic, "");
  assert.equal(pendingEdge.works[0].map_hold_reason, "pending_topic_review");
  assert.equal(pendingEdge.works[0].url, "https://publisher.example.edu/work-pending");
  assert.equal(graph.nodes.find((node) => node.id === "c").mapped_publication_count, 0);
  assert.equal(graph.nodes.find((node) => node.id === "c").pending_publication_count, 1);
  assert.equal(graph.counts.work_count, 2);
  assert.equal(graph.counts.pending_work_count, 1);
  assert.equal(graph.counts.pending_pair_work_count, 1);
  assert.equal(graph.counts.pending_only_faculty_count, 1);
  assert.equal(graph.counts.pair_work_count, 2);
  assert.equal(graph.counts.mapped_without_collaboration_count, 0);
  assert.equal(graph.source.artifact_schema_version, 8);
});

test("schema 8 keeps ineligible pending works as coverage without making a collaboration edge", () => {
  const artifact = pendingArtifactFixture();
  artifact.pending_publications[0].collaboration_eligible = false;
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  assert.deepEqual(graph.edges.map((edge) => [edge.source, edge.target]), [["a", "b"]]);
  assert.deepEqual(graph.edges[0].works.map((work) => work.id), ["work-1"]);
  assert.equal(graph.nodes.find((node) => node.id === "c").pending_publication_count, 1);
  assert.equal(graph.counts.pending_work_count, 1);
  assert.equal(graph.counts.pending_pair_work_count, 0);
});

test("pending graph rows fail closed on schema, selection, ownership, and source errors", () => {
  const cases = [
    [(artifact) => { artifact.schema_version = 7; }, /pending rows require schema 8/],
    [(artifact) => { delete artifact.pending_publication_count; }, /both pending fields/],
    [(artifact) => { artifact.pending_publication_count = 2; }, /pending_publication_count/],
    [(artifact) => { artifact.pending_publications[0].work_id = "work-1"; }, /duplicate pending work ID/],
    [(artifact) => { artifact.pending_publications[0].faculty_ids = ["a", "a"]; }, /invalid faculty IDs/],
    [(artifact) => { artifact.pending_publications[0].faculty_ids = ["missing"]; }, /invalid faculty IDs/],
    [(artifact) => { artifact.pending_publications[0].release_decision = "held"; }, /not selected/],
    [(artifact) => { artifact.pending_publications[0].map_hold_reason = "other"; }, /not selected/],
    [(artifact) => { delete artifact.pending_publications[0].collaboration_eligible; }, /unexpected fields/],
    [(artifact) => { artifact.pending_publications[0].collaboration_eligible = "true"; }, /invalid collaboration eligibility/],
    [(artifact) => { artifact.pending_publications[0].source_url = "http://example.com"; }, /invalid source URL/],
    [(artifact) => { artifact.pending_publications[0].source_url = "https://user:password@example.com"; }, /invalid source URL/],
    [(artifact) => { artifact.pending_publications[0].year = "2025"; }, /invalid year/],
    [(artifact) => { artifact.pending_publications[0].title = ""; }, /no title/],
    [(artifact) => { artifact.pending_publications[0].doi = "10.1234/extra"; }, /unexpected fields/],
    [(artifact) => { artifact.catalogs.faculty[0].primary_academic_home_source_url = ""; }, /evidenced typed home/],
    [(artifact) => { artifact.catalogs.faculty[0].primary_academic_home_type = "unresolved"; }, /incomplete primary academic home|evidenced typed home/],
  ];
  for (const [mutate, pattern] of cases) {
    const artifact = pendingArtifactFixture();
    mutate(artifact);
    assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)), pattern);
  }
});

test("reviewed one-sided coauthor evidence adds an edge without changing own-source publication coverage", () => {
  const artifact = artifactFixture();
  artifact.points[1].source_types = ["scholar"];
  artifact.points[1].collaboration_eligible = true;
  artifact.points[1].reported_faculty_coauthors = [{
    person_id: "c",
    source_person_id: "a",
    source_observation_id: "observation-a-work-2",
    source_url: "https://publisher.example/work-2",
    verified_at: "2026-10-30",
  }];
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const reported = graph.edges.find((edge) =>
    [edge.source, edge.target].includes("c"));
  assert.ok(reported);
  assert.equal(reported.works[0].id, "work-2");
  assert.deepEqual(reported.works[0].reported_faculty_coauthors,
    artifact.points[1].reported_faculty_coauthors);
  const target = graph.nodes.find((node) => node.id === "c");
  assert.equal(target.publication_count, 0);
  assert.equal(target.mapped_publication_count, 0);
  assert.equal(target.reported_coauthor_work_count, 1);
  assert.equal(graph.counts.mapped_faculty_count, 2);
  assert.equal(graph.counts.connected_faculty_count, 3);
  assert.equal(graph.counts.mapped_without_collaboration_count, 0);
  assert.equal(graph.counts.reported_coauthor_only_faculty_count, 1);
  assert.equal(graph.counts.reported_coauthor_work_count, 1);
  const parsed = core.parseGraph(graph);
  const csv = core.edgesToCsv(parsed, core.filterGraph(parsed, core.defaultState(parsed)));
  assert.match(csv, /reported_coauthor_works,reported_coauthor_evidence/);
  assert.match(csv, /Cora Gamma reported by Ada Alpha/);
  assert.match(csv, /observation-a-work-2/);
  assert.match(csv, /https:\/\/publisher\.example\/work-2/);
});

test("reported faculty coauthors fail closed on redundant, duplicated, or malformed provenance", () => {
  const evidence = {
    person_id: "c",
    source_person_id: "a",
    source_observation_id: "observation-a-work-2",
    source_url: "https://publisher.example/work-2",
    verified_at: "2026-10-30",
  };
  const candidate = () => {
    const artifact = artifactFixture();
    artifact.points[1].source_types = ["scholar"];
    artifact.points[1].collaboration_eligible = true;
    artifact.points[1].reported_faculty_coauthors = [{ ...evidence }];
    return artifact;
  };
  for (const mutate of [
    (point) => { point.reported_faculty_coauthors.push({ ...evidence }); },
    (point) => { point.reported_faculty_coauthors[0].person_id = "a"; },
    (point) => { point.reported_faculty_coauthors[0].source_person_id = "b"; },
    (point) => { point.reported_faculty_coauthors[0].source_observation_id = ""; },
    (point) => { point.reported_faculty_coauthors[0].source_url = "http://publisher.example/work-2"; },
    (point) => { point.reported_faculty_coauthors[0].verified_at = ""; },
    (point) => { point.collaboration_eligible = false; },
    (point) => { point.source_types = ["curated_verified"]; },
  ]) {
    const artifact = candidate();
    mutate(artifact.points[1]);
    assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)),
      /reported faculty coauthor/);
  }
});

test("deriveGraph carries a person-scoped publication hold without hiding other researchers' works", () => {
  const artifact = artifactFixture();
  artifact.catalogs.faculty[2].publication_hold_reason = "Publication history pending full capture";
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  assert.equal(graph.nodes.find((node) => node.id === "c").publication_hold_reason,
    "Publication history pending full capture");
  assert.equal(graph.nodes.find((node) => node.id === "a").publication_hold_reason, "");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.counts.work_count, 2);
});

test("deriveGraph preserves researcher bibliography provenance without changing Scholar-only works", () => {
  const authorArtifact = artifactFixture();
  authorArtifact.points[0].source_types = ["author_site"];
  authorArtifact.points[0].citation_count = 0;
  authorArtifact.points[0].source_url = "https://example.com/researcher/publications";
  authorArtifact.points[0].source_verified_at = "2026-10-25";
  authorArtifact.points[0].source_verification_urls = ["https://example.com/researcher/publications"];
  const authorWork = build.deriveGraph(authorArtifact, config, "a".repeat(40)).edges[0].works[0];
  assert.deepEqual(authorWork.source_types, ["author_site"]);
  assert.equal(authorWork.url, "https://example.com/researcher/publications");
  assert.equal(authorWork.source_verified_at, "2026-10-25");
  assert.deepEqual(authorWork.source_verification_urls,
    ["https://example.com/researcher/publications"]);
  assert.equal(authorWork.topic, "");

  const scholarArtifact = artifactFixture();
  scholarArtifact.points[0].source_types = ["scholar"];
  const scholarWork = build.deriveGraph(scholarArtifact, config, "a".repeat(40)).edges[0].works[0];
  assert.equal(Object.hasOwn(scholarWork, "source_types"), false);
  assert.equal(scholarWork.citations, 4);
  assert.equal(scholarWork.topic, "Design systems");

  scholarArtifact.points[0].source_types = ["scholar", "author_site"];
  const corroboratedWork = build.deriveGraph(scholarArtifact, config, "a".repeat(40)).edges[0].works[0];
  assert.deepEqual(corroboratedWork.source_types, ["scholar", "author_site"]);
  assert.equal(corroboratedWork.citations, 4);
  assert.equal(corroboratedWork.topic, "Design systems");
});

test("mapped patents, edited books, and panel transcripts do not create coauthor edges", () => {
  const artifact = artifactFixture();
  const original = artifact.points[0];
  for (const [index, publicationType] of ["patent", "edited_book", "panel_transcript"].entries()) {
    artifact.points.push({
      ...original,
      work_id: `context-${index}`,
      title: `${publicationType} with named contributors`,
      publication_type: publicationType,
      collaboration_eligible: false,
    });
  }
  artifact.point_count = artifact.points.length;
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  assert.equal(graph.counts.work_count, 5);
  assert.equal(graph.counts.multiple_faculty_work_count, 1);
  assert.equal(graph.counts.pair_work_count, 1);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].works.map((work) => work.id), ["work-1"]);
  assert.equal(graph.nodes.find((node) => node.id === "a").mapped_publication_count, 5);
  assert.equal(graph.nodes.find((node) => node.id === "b").mapped_publication_count, 4);

  artifact.points[2].collaboration_eligible = "false";
  assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)),
    /invalid collaboration eligibility/);
});

test("deriveGraph keeps cross-school coauthorship and cross-appointed faculty distinct", () => {
  const artifact = schoolArtifactFixture();
  artifact.catalogs.departments.push({
    department_id: "csd",
    school_id: "scs",
    title: "Computer Science Department",
  });
  artifact.catalogs.faculty[0].school_ids = ["engineering"];
  artifact.catalogs.faculty[1].school_ids = ["engineering", "scs"];
  artifact.catalogs.faculty[1].memberships.push({ department_id: "csd", role: "faculty" });
  artifact.catalogs.faculty[1].primary_department_id = "csd";
  artifact.catalogs.faculty[2].school_ids = ["scs"];
  artifact.catalogs.faculty[2].memberships = [{ department_id: "csd", role: "faculty" }];
  artifact.points[0].school_ids = ["engineering", "scs"];
  artifact.points[1].faculty_ids = ["a", "c"];
  artifact.points[1].school_ids = ["engineering", "scs"];

  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const edges = new Map(graph.edges.map((edge) => [`${edge.source}|${edge.target}`, edge]));
  assert.equal(edges.get("a|b").cross_department, true);
  assert.equal(edges.get("a|b").cross_school, false);
  assert.equal(edges.get("a|c").cross_school, true);
  assert.equal(graph.counts.cross_school_edge_count, 1);
  assert.deepEqual(graph.nodes.find((node) => node.id === "b").school_ids, ["engineering", "scs"]);
  assert.equal(graph.nodes.find((node) => node.id === "b").primary_department, "csd");
  assert.equal(graph.nodes.find((node) => node.id === "b").primary_school, "scs");
  assert.equal(graph.departments.find((department) => department.department_id === "csd").school_id, "scs");
  assert.equal(graph.departments.find((department) => department.department_id === "csd").short_title, "CSD");
  assert.equal(graph.schools.find((school) => school.school_id === "scs").faculty_count, 2);
});

test("deriveGraph carries source-backed primaries without inventing unresolved ones", () => {
  const artifact = schoolArtifactFixture();
  artifact.catalogs.faculty[0].memberships = [
    { department_id: "ece", role: "faculty" },
    { department_id: "mech", role: "faculty" },
  ];
  artifact.catalogs.faculty[0].primary_department_id = "mech";
  artifact.catalogs.faculty[0].primary_department_basis = "inferred_advisee_count";
  artifact.catalogs.faculty[0].primary_department_source_url = "https://example.com/advisees";
  artifact.catalogs.faculty[1].primary_department_id = "";
  artifact.catalogs.faculty[2].memberships.push({ department_id: "ece", role: "faculty" });

  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const ada = graph.nodes.find((node) => node.id === "a");
  assert.deepEqual(ada.departments, ["ece", "mech"]);
  assert.equal(ada.primary_department, "mech");
  assert.equal(ada.primary_academic_home_basis, "inferred_advisee_count");
  assert.equal(ada.primary_academic_home_source_url, "https://example.com/advisees");
  assert.equal(graph.nodes.find((node) => node.id === "b").primary_department, "");
  assert.equal(graph.nodes.find((node) => node.id === "c").primary_department, "");
  assert.equal(graph.departments.find((item) => item.department_id === "ece").faculty_count, 3);

  artifact.catalogs.faculty[0].primary_department_id = "missing";
  assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)),
    /invalid primary home school/);
});

test("legacy campus-only affiliation stays unresolved while CMU-Africa is eligible", () => {
  const artifact = schoolArtifactFixture();
  artifact.catalogs.departments.push(
    { department_id: "cmu-silicon-valley", school_id: "engineering", title: "CMU Silicon Valley" },
    { department_id: "cmu-africa", school_id: "engineering", title: "CMU-Africa" },
  );
  artifact.catalogs.faculty[2].memberships = [
    { department_id: "cmu-silicon-valley", role: "teaching" },
  ];
  let graph = build.deriveGraph(artifact, config, "a".repeat(40));
  assert.equal(graph.nodes.find((node) => node.id === "c").primary_department, "");
  artifact.catalogs.faculty[2].memberships = [
    { department_id: "cmu-africa", role: "teaching" },
  ];
  graph = build.deriveGraph(artifact, config, "a".repeat(40));
  assert.equal(graph.nodes.find((node) => node.id === "c").primary_department, "cmu-africa");
  artifact.catalogs.faculty[2].primary_department_id = "cmu-silicon-valley";
  artifact.catalogs.faculty[2].memberships.push(
    { department_id: "cmu-silicon-valley", role: "teaching" },
  );
  assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)),
    /legacy primary department inconsistent/);
});

test("typed Silicon Valley campus home survives graph generation and excludes adjunct membership", () => {
  const artifact = schoolArtifactFixture();
  artifact.catalogs.departments.push(
    { department_id: "cmu-silicon-valley", school_id: "engineering",
      title: "CMU Silicon Valley", unit_type: "campus" },
    { department_id: "iii", school_id: "engineering",
      title: "Integrated Innovation Institute", unit_type: "institute" },
  );
  const person = artifact.catalogs.faculty[2];
  person.memberships = [
    { department_id: "cmu-silicon-valley", role: "teaching" },
    { department_id: "iii", role: "adjunct", included: false },
  ];
  Object.assign(person, {
    primary_department_id: "",
    primary_academic_home_type: "campus",
    primary_academic_home_id: "cmu-silicon-valley",
    primary_academic_home_title: "CMU Silicon Valley",
    primary_academic_home_school_id: "engineering",
    primary_academic_home_basis: "reviewed",
    primary_academic_home_source_url: "https://www.cmu.edu/silicon-valley/",
    primary_academic_home_verified_at: "2026-10-24",
  });
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const node = graph.nodes.find((item) => item.id === "c");
  assert.deepEqual(node.departments, ["cmu-silicon-valley"]);
  assert.equal(node.primary_department, "");
  assert.equal(node.primary_home_group, "cmu-silicon-valley");
  assert.deepEqual(node.school_ids, ["engineering"]);
  assert.equal(graph.academic_homes.find((home) => home.home_group === "cmu-silicon-valley").home_type,
    "campus");
  const parsed = core.parseGraph(graph);
  assert.equal(parsed.nodeById.get("c").primary_academic_home_type, "campus");
  assert.deepEqual(parsed.nodeById.get("c").academic_departments, []);

  person.memberships[0].included = false;
  assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)), /no included department/);
});

test("typed academic homes separate school fallbacks, areas, institutes, and unresolved cases", () => {
  const artifact = artifactFixture();
  artifact.catalogs.schools = [
    { school_id: "engineering", title: "College of Engineering" },
    { school_id: "heinz", title: "Heinz College" },
    { school_id: "tepper", title: "Tepper School of Business" },
  ];
  artifact.catalogs.departments = [
    { department_id: "ece", school_id: "engineering", unit_type: "department",
      title: "Electrical and Computer Engineering" },
    { department_id: "cmu-africa", school_id: "engineering", unit_type: "department",
      title: "CMU-Africa" },
    { department_id: "iii", school_id: "engineering", unit_type: "institute",
      title: "Integrated Innovation Institute" },
    { department_id: "heinz-faculty", school_id: "heinz", unit_type: "roster_container",
      title: "Heinz faculty roster" },
    { department_id: "heinz-ism", school_id: "heinz", unit_type: "constituent_school",
      title: "School of Information Systems and Management" },
    { department_id: "heinz-ppm", school_id: "heinz", unit_type: "constituent_school",
      title: "School of Public Policy and Management" },
    { department_id: "tepper-faculty", school_id: "tepper", unit_type: "roster_container",
      title: "Tepper faculty roster" },
  ];
  const faculty = (id, memberships, schools, type, homeId, title, basis = "reviewed") => ({
    person_id: id,
    display_name: id.toUpperCase(),
    memberships: memberships.map((department_id) => ({ department_id, role: "faculty" })),
    school_ids: schools,
    primary_department_id: type === "department" ? homeId : "",
    primary_academic_home_type: type,
    primary_academic_home_id: homeId,
    primary_academic_home_title: title,
    primary_academic_home_school_id: type === "school" ? homeId
      : type === "academic_area" ? "tepper" : schools[0],
    primary_academic_home_basis: type === "unresolved" ? "unresolved" : basis,
    primary_academic_home_source_url: homeId ? `https://example.com/${id}` : "",
    primary_academic_home_verified_at: homeId ? "2026-10-24" : "",
  });
  artifact.catalogs.faculty = [
    faculty("a", ["tepper-faculty"], ["tepper"], "school", "tepper",
      "Tepper School of Business", "school_fallback"),
    faculty("b", ["tepper-faculty"], ["tepper"], "academic_area", "tepper:finance",
      "Finance"),
    faculty("c", ["heinz-faculty", "heinz-ism"], ["heinz"], "constituent_school",
      "heinz-ism", "School of Information Systems and Management"),
    faculty("d", ["heinz-faculty"], ["heinz"], "school", "heinz",
      "Heinz College", "school_fallback"),
    faculty("e", ["iii"], ["engineering"], "institute", "iii",
      "Integrated Innovation Institute"),
    faculty("f", ["cmu-africa", "ece"], ["engineering"], "department", "cmu-africa",
      "CMU-Africa", "display_tie_break_first_listed"),
    faculty("g", ["ece", "iii"], ["engineering"], "unresolved", "", ""),
    faculty("h", ["heinz-faculty", "heinz-ppm"], ["heinz"], "constituent_school",
      "heinz-ppm", "School of Public Policy and Management"),
  ];
  artifact.points = [
    ["a", "b"], ["c", "d"], ["c", "e"], ["f", "e"], ["g", "e"], ["a", "c"],
    ["c", "h"],
  ].map((faculty_ids, index) => ({
    work_id: `work-${index}`, title: `Shared work ${index}`, faculty_ids, year: 2024,
  }));
  artifact.point_count = artifact.points.length;

  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const parsed = core.parseGraph(graph);
  const node = (id) => parsed.nodeById.get(id);
  const edge = (left, right) => graph.edges.find((item) =>
    item.source === left && item.target === right);
  assert.equal(node("a").primary_academic_home_type, "school");
  assert.equal(node("a").primary_academic_home_basis, "school_fallback");
  assert.equal(core.academicHomeDisplayText(node("a"), "Tepper School of Business"),
    "Primary academic home: Tepper School of Business (school; school-level home; no narrower unit verified)");
  assert.equal(node("a").primary_department, "");
  assert.equal(node("a").primary_home_group, "school:tepper");
  assert.equal(node("b").primary_home_group, "academic_area:tepper:finance");
  assert.equal(node("c").primary_academic_home_type, "constituent_school");
  assert.equal(node("e").primary_academic_home_type, "institute");
  assert.equal(node("f").primary_department, "cmu-africa");
  assert.deepEqual(node("f").departments, ["cmu-africa", "ece"]);
  assert.equal(node("f").primary_academic_home_basis, "display_tie_break_first_listed");
  assert.equal(core.academicHomeDisplayText(node("f"), "CMU-Africa"),
    "Map display home: CMU-Africa (department; display tie-break: first-listed department)");
  assert.equal(node("g").primary_home_group, "");
  assert.deepEqual(node("g").departments, ["ece", "iii"]);
  assert.equal(core.layoutDepartmentId(node("a"), [], parsed, ["tepper"]), "school:tepper");
  assert.equal(core.layoutDepartmentId(node("g")), core.UNRESOLVED_LAYOUT_GROUP);
  assert.equal(core.facultyLabelEligible(node("a")), true);
  assert.equal(core.facultyMatches(parsed, "Heinz", 10).length, 3);
  assert.equal(edge("a", "b").cross_department, false);
  assert.equal(edge("c", "d").cross_department, false);
  assert.equal(edge("c", "h").cross_department, true);
  assert.equal(edge("c", "e").cross_department, true);
  assert.equal(edge("e", "f").cross_department, true);
  assert.equal(edge("e", "g").cross_department, false);
  assert.equal(edge("a", "c").cross_school, true);
  assert.equal(graph.academic_homes.some((home) => home.home_group === "tepper-faculty"), false);
  assert.equal(graph.academic_homes.some((home) => home.home_group === "school:tepper"), true);
  assert.equal(core.filterGraph(parsed, {
    ...core.defaultState(parsed), departments: ["tepper-faculty"], showUnconnected: true,
  }).nodes.filter((item) => item.kind === "faculty").length, 2);
  graph.nodes.find((item) => item.id === "b").primary_academic_home_title = "Wrong area";
  assert.throws(() => core.parseGraph(graph), /inconsistent primary academic home details/);
});

test("deriveGraph adds only verified external coauthor edges without changing CMU faculty counts", () => {
  const artifact = schoolArtifactFixture();
  artifact.catalogs.schools.push({ school_id: "mcs", title: "Mellon College of Science" });
  artifact.catalogs.departments.push({
    department_id: "math",
    school_id: "mcs",
    title: "Mathematical Sciences",
  });
  artifact.catalogs.faculty[0] = {
    ...artifact.catalogs.faculty[0],
    display_name: "Prasad Tetali",
    memberships: [{ department_id: "math", role: "faculty" }],
    school_ids: ["mcs"],
  };
  artifact.catalogs.external_coauthors = [{
    person_id: "external-paul-erdos",
    display_name: "Paul Erdős",
    source_url: "https://sites.google.com/oakland.edu/grossman/home/the-erdoes-number-project",
  }];
  artifact.points = [
    {
      work_id: "1990-paper",
      title: "Representations of integers as the sum of k terms",
      faculty_ids: ["a"],
      external_coauthor_ids: ["external-paul-erdos"],
      school_ids: ["mcs"],
      year: 1990,
      doi: "10.1002/rsa.3240010302",
      source_types: ["curated_verified"],
      source_verified_at: "2026-10-24",
      source_verification_urls: ["https://doi.org/10.1002/rsa.3240010302"],
      keyword_ids: ["topic-1"],
    },
    {
      work_id: "1995-paper",
      title: "Independence of solution sets and minimal asymptotic bases",
      faculty_ids: ["a"],
      external_coauthor_ids: ["external-paul-erdos"],
      school_ids: ["mcs"],
      year: 1995,
      doi: "10.4064/aa-69-3-243-258",
      source_types: ["curated_verified"],
      source_verified_at: "2026-10-24",
      source_verification_urls: ["https://www.impan.pl/en/publishing-house/journals-and-series/acta-arithmetica/all/69/3/108504/independence-of-solution-sets-and-minimal-asymptotic-bases"],
    },
  ];
  const graph = build.deriveGraph(artifact, config, "a".repeat(40));
  const erdos = graph.nodes.find((node) => node.id === "external-paul-erdos");
  assert.equal(erdos.kind, "external_coauthor");
  assert.deepEqual(erdos.departments, []);
  assert.deepEqual(erdos.school_ids, []);
  assert.equal(erdos.mapped_publication_count, 2);
  assert.equal(graph.counts.faculty_count, 3);
  assert.equal(graph.counts.external_coauthor_count, 1);
  assert.equal(graph.counts.mapped_faculty_count, 1);
  assert.equal(graph.counts.connected_faculty_count, 1);
  assert.equal(graph.schools.find((school) => school.school_id === "mcs").faculty_count, 1);
  assert.equal(graph.departments.find((department) => department.department_id === "math").short_title, "Math");
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].works.map((work) => work.year), [1995, 1990]);
  assert.equal(graph.edges[0].cross_department, false);
  assert.equal(graph.edges[0].cross_school, false);
  assert.equal(graph.edges[0].works[0].source_types[0], "curated_verified");
  assert.equal(graph.edges[0].works[0].source_verified_at, "2026-10-24");
  assert.equal(graph.edges[0].works[0].source_verification_urls.length, 1);
  assert.equal(graph.edges[0].works[1].topic, "");
});

test("deriveGraph rejects unverified external identities and broken paper joins", () => {
  const artifact = artifactFixture();
  artifact.catalogs.external_coauthors = [{
    person_id: "external-paul-erdos",
    display_name: "Paul Erdős",
    source_url: "https://example.com/erdos",
  }];
  artifact.points[0].external_coauthor_ids = ["external-paul-erdos"];
  artifact.points[0].source_types = ["curated_verified"];
  artifact.points[0].source_verification_urls = ["https://example.com/work"];
  assert.equal(build.deriveGraph(artifact, config, "a".repeat(40)).edges.length, 3);

  const duplicate = structuredClone(artifact);
  duplicate.points[0].external_coauthor_ids.push("external-paul-erdos");
  assert.throws(() => build.deriveGraph(duplicate, config, "a".repeat(40)), /duplicate external references/);
  const unknown = structuredClone(artifact);
  unknown.points[0].external_coauthor_ids = ["external-unknown"];
  assert.throws(() => build.deriveGraph(unknown, config, "a".repeat(40)), /unknown external coauthor/);
  const noSource = structuredClone(artifact);
  noSource.catalogs.external_coauthors[0].source_url = "";
  assert.throws(() => build.deriveGraph(noSource, config, "a".repeat(40)), /public source URL/);
  const facultyCollision = structuredClone(artifact);
  facultyCollision.catalogs.external_coauthors[0].person_id = "a";
  assert.throws(() => build.deriveGraph(facultyCollision, config, "a".repeat(40)), /external coauthor ID/);
  const noPaperEvidence = structuredClone(artifact);
  noPaperEvidence.points[0].source_verification_urls = [];
  assert.throws(() => build.deriveGraph(noPaperEvidence, config, "a".repeat(40)), /public verification URL/);
  const noVerifiedType = structuredClone(artifact);
  noVerifiedType.points[0].source_types = ["scholar"];
  assert.throws(() => build.deriveGraph(noVerifiedType, config, "a".repeat(40)), /verified source type/);
});

test("deriveGraph checks the additive school contract", () => {
  const cases = [
    [(artifact) => (artifact.catalogs.schools = []), /invalid schools/],
    [(artifact) => (artifact.catalogs.schools[0].title = ""), /invalid schools/],
    [(artifact) => (artifact.catalogs.schools[1].school_id = "engineering"), /duplicate school IDs/],
    [(artifact) => (artifact.catalogs.departments[0].school_id = "missing"), /invalid school/],
    [(artifact) => (artifact.catalogs.faculty[0].school_ids = []), /invalid school memberships/],
    [(artifact) => (artifact.catalogs.faculty[0].school_ids = ["missing"]), /invalid school memberships/],
    [(artifact) => (artifact.catalogs.faculty[0].school_ids = ["scs"]), /department outside their schools/],
    [(artifact) => (artifact.points[0].school_ids = ["missing"]), /invalid school references/],
  ];
  for (const [mutate, pattern] of cases) {
    const artifact = schoolArtifactFixture();
    mutate(artifact);
    assert.throws(() => build.deriveGraph(artifact, config, "a".repeat(40)), pattern);
  }
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
  assert.deepEqual(
    build.parseConfig({ dataset_id: "owner/dataset", artifact_path: "maps/publications.json" }),
    {
      title: "CMU Engineering Collaborations",
      heading: "Faculty Collaboration at CMU Engineering",
      dataset_id: "owner/dataset",
      dataset_revision: "main",
      artifact_path: "maps/publications.json",
    },
  );
  assert.throws(() => build.parseConfig(null), /must be an object/);
  assert.throws(
    () => build.parseConfig({ ...config, dataset_id: "invalid" }),
    /Invalid dataset_id/,
  );
  assert.throws(
    () => build.parseConfig({ dataset_id: "", artifact_path: "maps/publications.json" }),
    /Invalid dataset_id/,
  );
  assert.throws(
    () => build.parseConfig({ dataset_id: "owner/dataset", artifact_path: "" }),
    /Invalid artifact_path/,
  );
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
  assert.throws(() => build.stampAssetUrls("assets/theme.js", "abc"), /does not reference/);
});

test("dataset URLs are encoded and immutable revisions are validated", async () => {
  assert.equal(
    build.artifactUrl(
      {
        dataset_id: "owner/data set",
        artifact_path: "maps/a file.json",
      },
      "a/b",
    ),
    "https://huggingface.co/datasets/owner/data%20set/resolve/a%2Fb/maps/a%20file.json",
  );

  const revision = "a".repeat(40);
  let requestedUrl = "";
  assert.equal(
    await build.resolveDatasetRevision(config, async (url) => {
      requestedUrl = url;
      return response({ sha: revision.toUpperCase() });
    }),
    revision,
  );
  assert.equal(
    requestedUrl,
    "https://huggingface.co/api/datasets/owner/dataset/revision/main",
  );
  await assert.rejects(
    build.resolveDatasetRevision(config, async () => response({ sha: "main" })),
    /immutable revision/,
  );
  await assert.rejects(
    build.resolveDatasetRevision(config, async () => response({})),
    /immutable revision/,
  );
  assert.equal(build.canonicalEdgeKey("z", "a"), "a|z");
});

test("remote JSON limits and response failures are enforced", async () => {
  await assert.rejects(
    build.resolveDatasetRevision(config, async () => response("failure", { ok: false, status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    build.resolveDatasetRevision(
      config,
      async () => response({}, { contentLength: 1024 * 1024 + 1 }),
    ),
    /byte limit/,
  );
  await assert.rejects(
    build.resolveDatasetRevision(config, async () => response("x".repeat(1024 * 1024 + 1))),
    /byte limit/,
  );
  await assert.rejects(
    build.resolveDatasetRevision(config, async () => response("not json")),
    /valid JSON/,
  );
});

test("deriveGraph validates source contracts and normalizes optional fields", () => {
  assert.throws(
    () => build.deriveGraph(null, config, "b".repeat(40)),
    /must be an object/,
  );
  for (const [mutate, pattern] of [
    [(artifact) => (artifact.schema_version = 6), /Expected publication schema/],
    [(artifact) => (artifact.points = null), /missing points/],
    [(artifact) => (artifact.catalogs.faculty = null), /missing faculty/],
    [(artifact) => (artifact.catalogs.departments = null), /missing departments/],
    [(artifact) => (artifact.point_count = 99), /point_count/],
    [(artifact) => (artifact.catalogs.faculty[1].person_id = "a"), /faculty ID/],
    [(artifact) => (artifact.catalogs.faculty[0].person_id = ""), /faculty ID/],
    [(artifact) => (artifact.catalogs.faculty[0].memberships = []), /no included department/],
    [(artifact) => delete artifact.catalogs.faculty[0].memberships, /no included department/],
    [(artifact) => (artifact.points[0].title = ""), /has no title/],
    [(artifact) => (artifact.points[0].work_id = ""), /work ID/],
    [(artifact) => delete artifact.points[0].faculty_ids, /no valid faculty/],
    [(artifact) => (artifact.points[0].faculty_ids = ["a", "a"]), /duplicate faculty references/],
    [(artifact) => (artifact.points[0].faculty_ids = ["a", "missing"]), /invalid faculty references/],
  ]) {
    const artifact = artifactFixture();
    mutate(artifact);
    assert.throws(() => build.deriveGraph(artifact, config, "b".repeat(40)), pattern);
  }

  const artifact = artifactFixture();
  artifact.keywords = null;
  artifact.generated_at_utc = "";
  artifact.source_data_oldest_at_utc = "";
  artifact.source_data_newest_at_utc = "";
  artifact.quality_assessment_version = "";
  artifact.catalogs.departments.push({ department_id: "custom", title: "Custom Program" });
  artifact.catalogs.faculty.push({
    person_id: "d",
    display_name: "Dara Delta",
    scholar_id: " scholar/d ",
    orcid: "https://orcid.org/0000-0000-0000-0001",
    memberships: [{ department_id: "custom" }],
    publication_count: -4,
  });
  artifact.points.push({
    work_id: "work-3",
    title: "A custom solo paper",
    faculty_ids: ["d"],
    year: 2023,
    source_url: "javascript:alert(1)",
    doi: "10.1000/example",
    citation_count: -1,
  });
  artifact.point_count = artifact.points.length;
  const graph = build.deriveGraph(artifact, config, "b".repeat(40));
  const customDepartment = graph.departments.find((item) => item.department_id === "custom");
  const dara = graph.nodes.find((item) => item.id === "d");
  assert.equal(customDepartment.short_title, "Custom Program");
  assert.equal(dara.publication_count, 0);
  assert.equal(dara.roles[0], "faculty");
  assert.equal(dara.scholar_url, "https://scholar.google.com/citations?user=scholar%2Fd");
  assert.equal(dara.orcid_url, "https://orcid.org/0000-0000-0000-0001");
});

test("deriveGraph deterministically sorts tied works and edges", () => {
  const artifact = artifactFixture();
  artifact.points[0].faculty_ids = ["a", "b", "c"];
  artifact.points.push({
    work_id: "work-3",
    title: "An earlier alphabetical title",
    faculty_ids: ["a", "b", "c"],
    year: 2024,
    citation_count: 4,
  });
  artifact.point_count = artifact.points.length;

  const graph = build.deriveGraph(artifact, config, "e".repeat(40));
  assert.deepEqual(
    graph.edges.map((edge) => edge.source + edge.target),
    ["ab", "ac", "bc"],
  );
  assert.deepEqual(
    graph.edges[0].works.map((work) => work.title),
    ["A shared paper", "An earlier alphabetical title"],
  );
});

test("layoutGraph tolerates dangling layout edges and overlapping seed positions", () => {
  const nodes = [
    { id: "same", name: "First", primary_department: "missing", x: 0, y: 0 },
    { id: "same", name: "Second", primary_department: "missing", x: 0, y: 0 },
    { id: "loose-a", name: "Loose A", primary_department: "missing", x: 0, y: 0 },
    { id: "loose-b", name: "Loose B", primary_department: "missing", x: 0, y: 0 },
  ];
  build.layoutGraph(
    nodes,
    [
      { source: "same", target: "same", weight: 1 },
      { source: "missing", target: "same", weight: 1 },
    ],
    [],
  );
  nodes.forEach((node) => {
    assert.equal(Number.isFinite(node.x), true);
    assert.equal(Number.isFinite(node.y), true);
  });
});

test("buildSite stages a complete pinned site with mocked upstream data", async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(projectRoot, ".test-site-"));
  t.after(async () => fs.rm(outputDirectory, { recursive: true, force: true }));
  const revision = "c".repeat(40);
  const requestedUrls = [];
  const result = await build.buildSite({
    sourceDirectory: projectRoot,
    outputDirectory,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return requestedUrls.length === 1
        ? response({ sha: revision })
        : response(artifactFixture());
    },
  });

  assert.equal(result.revision, revision);
  assert.equal(result.artifactName, `collaborations.${revision}.json`);
  assert.match(result.graphDigest, /^[0-9a-f]{64}$/);
  assert.ok(result.graphBytes > 0);
  assert.equal(requestedUrls.length, 2);
  const outputConfig = JSON.parse(
    await fs.readFile(path.join(outputDirectory, "map-config.json"), "utf8"),
  );
  assert.equal(outputConfig.graph_artifact, `data/${result.artifactName}`);
  assert.equal(outputConfig.graph_sha256, result.graphDigest);
  assert.match(
    await fs.readFile(path.join(outputDirectory, "index.html"), "utf8"),
    new RegExp(`assets/collaboration\\.js\\?v=${revision.slice(0, 12)}`),
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(outputDirectory, "data", result.artifactName), "utf8")),
    result.graph,
  );
  await fs.access(path.join(outputDirectory, "assets", "collaboration-core.js"));
  await fs.access(path.join(outputDirectory, ".nojekyll"));
});

test("buildSite stages and parses schema 8 pending graph evidence", async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(projectRoot, ".test-site-"));
  t.after(async () => fs.rm(outputDirectory, { recursive: true, force: true }));
  const revision = "e".repeat(40);
  const result = await build.buildSite({
    sourceDirectory: projectRoot,
    outputDirectory,
    fetchImpl: async (url) => response(url.includes("/api/datasets/")
      ? { sha: revision } : pendingArtifactFixture()),
  });
  assert.equal(result.graph.source.artifact_schema_version, 8);
  assert.equal(result.graph.counts.pending_work_count, 1);
  const parsed = core.parseGraph(JSON.parse(await fs.readFile(
    path.join(outputDirectory, "data", result.artifactName), "utf8",
  )));
  assert.equal(parsed.edges.length, 2);
  assert.equal(parsed.edges.find((edge) => edge.source === "a" && edge.target === "c")
    .works[0].map_hold_reason, "pending_topic_review");
});

test("build entry points reject unsafe destinations and support revision-only checks", async () => {
  await assert.rejects(
    build.buildSite({ sourceDirectory: projectRoot, outputDirectory: projectRoot, fetchImpl: fetch }),
    /unsafe output directory/,
  );
  await assert.rejects(
    build.buildSite({
      sourceDirectory: projectRoot,
      outputDirectory: path.resolve(projectRoot, "..", "outside-project"),
      fetchImpl: fetch,
    }),
    /inside the project/,
  );
  await assert.rejects(
    build.buildSite({ sourceDirectory: projectRoot, fetchImpl: null }),
    /Fetch-compatible runtime/,
  );

  const revision = "d".repeat(40);
  assert.equal(
    await build.configuredDatasetRevision({
      sourceDirectory: projectRoot,
      fetchImpl: async () => response({ sha: revision }),
    }),
    revision,
  );
});
