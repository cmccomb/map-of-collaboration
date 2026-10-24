"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const build = require("../scripts/build-site.js");

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
  assert.equal(graph.departments.find((department) => department.department_id === "csd").school_id, "scs");
  assert.equal(graph.schools.find((school) => school.school_id === "scs").faculty_count, 2);
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
