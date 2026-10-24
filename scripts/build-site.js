"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_OUTPUT_DIRECTORY = "_site";
const MAX_API_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const GRAPH_SCHEMA_VERSION = 1;
const EXPECTED_SOURCE_SCHEMA = 7;

const DEPARTMENT_PRESENTATION = Object.freeze({
  bme: { short_title: "BME", color_dark: "#ff9f8b", color_light: "#b94331" },
  cheme: { short_title: "ChemE", color_dark: "#73c5df", color_light: "#14738e" },
  civil: { short_title: "CEE", color_dark: "#ffc36f", color_light: "#9b6217" },
  "cmu-africa": { short_title: "Africa", color_dark: "#91d4a5", color_light: "#30774a" },
  "cmu-silicon-valley": { short_title: "Silicon Valley", color_dark: "#b6a7ec", color_light: "#624ea2" },
  ece: { short_title: "ECE", color_dark: "#f39dca", color_light: "#a63f76" },
  epp: { short_title: "EPP", color_dark: "#dcaa91", color_light: "#8d573d" },
  iii: { short_title: "iii", color_dark: "#80d6cf", color_light: "#247c76" },
  ini: { short_title: "INI", color_dark: "#d5d279", color_light: "#777518" },
  mech: { short_title: "MechE", color_dark: "#66b5ff", color_light: "#1769a8" },
  mse: { short_title: "MSE", color_dark: "#c4a0e8", color_light: "#75509b" },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function datasetRevisionUrl(config) {
  const [owner, repository] = config.dataset_id.split("/");
  return `https://huggingface.co/api/datasets/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/revision/${encodeURIComponent(config.dataset_revision)}`;
}

function artifactUrl(config, revision) {
  const [owner, repository] = config.dataset_id.split("/");
  return `https://huggingface.co/datasets/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/resolve/${encodeURIComponent(revision)}/${config.artifact_path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function parseConfig(input) {
  assert(input && typeof input === "object", "Map configuration must be an object");
  const datasetId = String(input.dataset_id || "");
  const artifactPath = String(input.artifact_path || "");
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(datasetId), "Invalid dataset_id");
  assert(
    artifactPath && !artifactPath.startsWith("/") && !artifactPath.includes(".."),
    "Invalid artifact_path",
  );
  return {
    title: String(input.title || "CMU Engineering Collaborations"),
    heading: String(input.heading || "Faculty Collaboration at CMU Engineering"),
    dataset_id: datasetId,
    dataset_revision: String(input.dataset_revision || "main"),
    artifact_path: artifactPath,
  };
}

async function fetchJsonDocument(fetchImpl, url, label, maximumBytes) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${label} did not contain valid JSON`, { cause: error });
  }
}

async function resolveDatasetRevision(config, fetchImpl) {
  const { value } = await fetchJsonDocument(
    fetchImpl,
    datasetRevisionUrl(config),
    "Hugging Face dataset metadata",
    MAX_API_BYTES,
  );
  const revision = String(value.sha || "").toLowerCase();
  assert(REVISION_PATTERN.test(revision), "Hugging Face did not return an immutable revision");
  return revision;
}

function hashUnit(value, salt = "") {
  const digest = crypto.createHash("sha256").update(`${salt}:${value}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function canonicalEdgeKey(left, right) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function safeSourceUrl(point) {
  const candidates = [point.source_url, point.doi ? `https://doi.org/${point.doi}` : ""];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
    } catch {
      // Continue to the next candidate.
    }
  }
  return "";
}

function scholarUrl(scholarId) {
  const id = String(scholarId || "").trim();
  return id
    ? `https://scholar.google.com/citations?user=${encodeURIComponent(id)}`
    : "";
}

function orcidUrl(orcid) {
  const id = String(orcid || "").trim().replace(/^https?:\/\/orcid\.org\//i, "");
  return id ? `https://orcid.org/${encodeURIComponent(id)}` : "";
}

function intersections(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function layoutGraph(nodes, edges, departments) {
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const connectedNodes = nodes.filter((node) => connected.has(node.id));
  const nodeIndex = new Map(connectedNodes.map((node, index) => [node.id, index]));
  const departmentIndex = new Map(
    departments.map((department, index) => [department.department_id, index]),
  );
  const departmentCenters = new Map(
    departments.map((department, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, departments.length)) * Math.PI * 2;
      return [
        department.department_id,
        { x: Math.cos(angle) * 0.52, y: Math.sin(angle) * 0.42 },
      ];
    }),
  );

  const positions = connectedNodes.map((node) => {
    const center = departmentCenters.get(node.primary_department) || { x: 0, y: 0 };
    const angle = hashUnit(node.id, "angle") * Math.PI * 2;
    const radius = 0.035 + hashUnit(node.id, "radius") * 0.16;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });

  const iterations = 720;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const alpha = Math.pow(1 - iteration / iterations, 1.7);
    const fx = new Float64Array(connectedNodes.length);
    const fy = new Float64Array(connectedNodes.length);

    for (const edge of edges) {
      const sourceIndex = nodeIndex.get(edge.source);
      const targetIndex = nodeIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      const source = positions[sourceIndex];
      const target = positions[targetIndex];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const desired = Math.max(0.075, 0.16 - Math.log1p(edge.weight) * 0.012);
      const magnitude = (distance - desired) * (0.018 + Math.log1p(edge.weight) * 0.004) * alpha;
      const xForce = (dx / distance) * magnitude;
      const yForce = (dy / distance) * magnitude;
      fx[sourceIndex] += xForce;
      fy[sourceIndex] += yForce;
      fx[targetIndex] -= xForce;
      fy[targetIndex] -= yForce;
    }

    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        let dx = positions[right].x - positions[left].x;
        let dy = positions[right].y - positions[left].y;
        if (dx === 0 && dy === 0) {
          dx = (hashUnit(`${left}:${right}`, "x") - 0.5) * 0.001;
          dy = (hashUnit(`${left}:${right}`, "y") - 0.5) * 0.001;
        }
        const distanceSquared = dx * dx + dy * dy + 0.0015;
        if (distanceSquared > 0.25) continue;
        const distance = Math.sqrt(distanceSquared);
        const magnitude = (0.00015 * alpha) / distanceSquared;
        const xForce = (dx / distance) * magnitude;
        const yForce = (dy / distance) * magnitude;
        fx[left] -= xForce;
        fy[left] -= yForce;
        fx[right] += xForce;
        fy[right] += yForce;
      }
    }

    for (let index = 0; index < connectedNodes.length; index += 1) {
      const node = connectedNodes[index];
      const position = positions[index];
      const center = departmentCenters.get(node.primary_department) || { x: 0, y: 0 };
      const departmentPull = 0.0045 * alpha;
      const originPull = 0.0015 * alpha;
      fx[index] += (center.x - position.x) * departmentPull - position.x * originPull;
      fy[index] += (center.y - position.y) * departmentPull - position.y * originPull;
      position.vx = (position.vx + fx[index]) * 0.82;
      position.vy = (position.vy + fy[index]) * 0.82;
      position.x += position.vx;
      position.y += position.vy;
    }
  }

  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const minimumX = Math.min(...xs, -1);
  const maximumX = Math.max(...xs, 1);
  const minimumY = Math.min(...ys, -1);
  const maximumY = Math.max(...ys, 1);
  const centerX = (minimumX + maximumX) / 2;
  const centerY = (minimumY + maximumY) / 2;
  const scale = Math.min(1.65 / (maximumX - minimumX), 1.3 / (maximumY - minimumY));

  connectedNodes.forEach((node, index) => {
    node.x = Number(((positions[index].x - centerX) * scale).toFixed(6));
    node.y = Number(((positions[index].y - centerY) * scale).toFixed(6));
  });

  const unconnected = nodes
    .filter((node) => !connected.has(node.id))
    .sort(
      (left, right) =>
        (departmentIndex.get(left.primary_department) || 0) -
          (departmentIndex.get(right.primary_department) || 0) ||
        left.name.localeCompare(right.name),
    );
  unconnected.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, unconnected.length)) * Math.PI * 2;
    const radius = 1.02 + (index % 3) * 0.11;
    node.x = Number((Math.cos(angle) * radius).toFixed(6));
    node.y = Number((Math.sin(angle) * radius * 0.76).toFixed(6));
  });
}

function deriveGraph(artifact, config, revision) {
  assert(artifact && typeof artifact === "object", "Publication artifact must be an object");
  assert(
    artifact.schema_version === EXPECTED_SOURCE_SCHEMA,
    `Expected publication schema ${EXPECTED_SOURCE_SCHEMA}, received ${artifact.schema_version}`,
  );
  assert(Array.isArray(artifact.points), "Publication artifact is missing points");
  assert(Array.isArray(artifact.catalogs?.faculty), "Publication artifact is missing faculty");
  assert(Array.isArray(artifact.catalogs?.departments), "Publication artifact is missing departments");
  assert(
    artifact.point_count === artifact.points.length,
    "Publication artifact point_count does not match its rows",
  );

  const departments = artifact.catalogs.departments.map((department) => {
    const presentation = DEPARTMENT_PRESENTATION[department.department_id] || {
      short_title: department.title,
      color_dark: "#73c5df",
      color_light: "#197b99",
    };
    return {
      department_id: String(department.department_id),
      title: String(department.title),
      short_title: presentation.short_title,
      directory_url: String(department.directory_url || ""),
      color_dark: presentation.color_dark,
      color_light: presentation.color_light,
      faculty_count: 0,
    };
  });
  const departmentIds = new Set(departments.map((department) => department.department_id));
  const departmentById = new Map(departments.map((department) => [department.department_id, department]));
  const hasSchoolCatalog = Array.isArray(artifact.catalogs.schools);
  const schools = hasSchoolCatalog
    ? artifact.catalogs.schools.map((school) => ({
        school_id: String(school.school_id || ""),
        title: String(school.title || ""),
        directory_url: String(school.directory_url || ""),
        faculty_count: 0,
      }))
    : [{ school_id: "engineering", title: "College of Engineering", directory_url: "", faculty_count: 0 }];
  const schoolIds = new Set(schools.map((school) => school.school_id));
  assert(schools.length > 0 && schools.every((school) => school.school_id && school.title),
    "Publication artifact has invalid schools");
  assert(schoolIds.size === schools.length, "Publication artifact has duplicate school IDs");
  const schoolById = new Map(schools.map((school) => [school.school_id, school]));
  departments.forEach((department, index) => {
    const schoolId = hasSchoolCatalog
      ? String(artifact.catalogs.departments[index].school_id || "")
      : "engineering";
    assert(schoolIds.has(schoolId), `Department ${department.department_id} has an invalid school`);
    department.school_id = schoolId;
  });

  const facultyIds = new Set();
  const nodes = artifact.catalogs.faculty.map((person) => {
    const id = String(person.person_id || "");
    assert(id && !facultyIds.has(id), `Duplicate or invalid faculty ID: ${id}`);
    facultyIds.add(id);
    const memberships = Array.isArray(person.memberships) ? person.memberships : [];
    const personDepartments = [
      ...new Set(
        memberships
          .map((membership) => String(membership.department_id || ""))
          .filter((departmentId) => departmentIds.has(departmentId)),
      ),
    ];
    assert(personDepartments.length > 0, `Faculty ${id} has no included department`);
    personDepartments.forEach((departmentId) => {
      departmentById.get(departmentId).faculty_count += 1;
    });
    const personSchools = hasSchoolCatalog
      ? [...new Set((Array.isArray(person.school_ids) ? person.school_ids : []).map(String))]
      : ["engineering"];
    assert(personSchools.length > 0 && personSchools.every((schoolId) => schoolIds.has(schoolId)),
      `Faculty ${id} has invalid school memberships`);
    assert(personDepartments.every((departmentId) => personSchools.includes(departmentById.get(departmentId).school_id)),
      `Faculty ${id} has a department outside their schools`);
    personSchools.forEach((schoolId) => {
      schoolById.get(schoolId).faculty_count += 1;
    });
    return {
      id,
      name: String(person.display_name || id),
      departments: personDepartments,
      primary_department: personDepartments[0],
      school_ids: personSchools,
      primary_school: personSchools[0],
      roles: [...new Set(memberships.map((membership) => String(membership.role || "faculty")))],
      publication_count: Math.max(0, Number(person.publication_count) || 0),
      mapped_publication_count: 0,
      collaborator_count: 0,
      collaboration_count: 0,
      homepage_url: String(person.homepage_url || ""),
      scholar_url: scholarUrl(person.scholar_id),
      orcid_url: orcidUrl(person.orcid),
      x: 0,
      y: 0,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const keywordById = new Map(
    (artifact.keywords || []).map((keyword) => [keyword.keyword_id, keyword.label]),
  );
  const workIds = new Set();
  const edgeMap = new Map();
  let missingYearCount = 0;
  let multipleFacultyWorkCount = 0;
  let invalidFacultyReferenceCount = 0;
  let duplicateFacultyReferenceCount = 0;

  for (const point of artifact.points) {
    const workId = String(point.work_id || "");
    assert(workId && !workIds.has(workId), `Duplicate or invalid work ID: ${workId}`);
    workIds.add(workId);
    assert(String(point.title || "").trim(), `Work ${workId} has no title`);
    const originalFaculty = Array.isArray(point.faculty_ids) ? point.faculty_ids.map(String) : [];
    const pointFaculty = [...new Set(originalFaculty)];
    duplicateFacultyReferenceCount += originalFaculty.length - pointFaculty.length;
    const validFaculty = pointFaculty.filter((facultyId) => {
      if (facultyIds.has(facultyId)) return true;
      invalidFacultyReferenceCount += 1;
      return false;
    });
    assert(validFaculty.length > 0, `Work ${workId} has no valid faculty relationship`);
    if (Array.isArray(point.school_ids)) {
      assert(point.school_ids.every((schoolId) => schoolIds.has(String(schoolId))),
        `Work ${workId} has invalid school references`);
    }
    validFaculty.forEach((facultyId) => {
      nodeById.get(facultyId).mapped_publication_count += 1;
    });
    const year = Number.isInteger(point.year) ? point.year : null;
    if (year === null) missingYearCount += 1;
    if (validFaculty.length > 1) multipleFacultyWorkCount += 1;
    const detailedTopicId = Array.isArray(point.keyword_ids)
      ? point.keyword_ids.at(-1)
      : "";
    const work = {
      id: workId,
      title: String(point.title),
      year,
      venue: String(point.venue || ""),
      citations: Math.max(0, Number(point.citation_count) || 0),
      doi: String(point.doi || ""),
      url: safeSourceUrl(point),
      topic: String(keywordById.get(detailedTopicId) || ""),
    };
    validFaculty.sort();
    for (let left = 0; left < validFaculty.length; left += 1) {
      for (let right = left + 1; right < validFaculty.length; right += 1) {
        const source = validFaculty[left];
        const target = validFaculty[right];
        const key = canonicalEdgeKey(source, target);
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            source,
            target,
            cross_department: !intersections(
              nodeById.get(source).departments,
              nodeById.get(target).departments,
            ),
            cross_school: !intersections(
              nodeById.get(source).school_ids,
              nodeById.get(target).school_ids,
            ),
            works: [],
          });
        }
        edgeMap.get(key).works.push(work);
      }
    }
  }

  assert(invalidFacultyReferenceCount === 0, "Publication artifact has invalid faculty references");
  assert(duplicateFacultyReferenceCount === 0, "Publication artifact has duplicate faculty references");
  const edges = [...edgeMap.values()]
    .map((edge) => ({
      ...edge,
      works: edge.works.sort(
        (left, right) =>
          (right.year || 0) - (left.year || 0) ||
          right.citations - left.citations ||
          left.title.localeCompare(right.title),
      ),
    }))
    .sort(
      (left, right) =>
        right.works.length - left.works.length ||
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target),
    );

  const collaborators = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    collaborators.get(edge.source).add(edge.target);
    collaborators.get(edge.target).add(edge.source);
    nodeById.get(edge.source).collaboration_count += edge.works.length;
    nodeById.get(edge.target).collaboration_count += edge.works.length;
  }
  nodes.forEach((node) => {
    node.collaborator_count = collaborators.get(node.id).size;
  });
  layoutGraph(
    nodes,
    edges.map((edge) => ({ ...edge, weight: edge.works.length })),
    departments,
  );

  const datedYears = artifact.points
    .map((point) => point.year)
    .filter(Number.isInteger);
  const mappedFacultyCount = nodes.filter((node) => node.mapped_publication_count > 0).length;
  const connectedFacultyCount = nodes.filter((node) => node.collaborator_count > 0).length;
  const pairWorkCount = edges.reduce((sum, edge) => sum + edge.works.length, 0);

  return {
    schema_version: GRAPH_SCHEMA_VERSION,
    title: config.title,
    generated_at_utc: String(artifact.generated_at_utc || ""),
    source: {
      dataset_id: config.dataset_id,
      dataset_revision: revision,
      artifact_path: config.artifact_path,
      artifact_schema_version: artifact.schema_version,
      artifact_generated_at_utc: String(artifact.generated_at_utc || ""),
      source_data_oldest_at_utc: String(artifact.source_data_oldest_at_utc || ""),
      source_data_newest_at_utc: String(artifact.source_data_newest_at_utc || ""),
      quality_assessment_version: String(artifact.quality_assessment_version || ""),
    },
    quality: {
      duplicate_work_id_count: 0,
      invalid_faculty_reference_count: invalidFacultyReferenceCount,
      duplicate_faculty_reference_count: duplicateFacultyReferenceCount,
      missing_year_count: missingYearCount,
      coverage_note:
        "A missing edge means no shared work was observed between two cataloged faculty IDs in this artifact; it does not establish that no collaboration exists.",
    },
    counts: {
      work_count: artifact.points.length,
      faculty_count: nodes.length,
      mapped_faculty_count: mappedFacultyCount,
      connected_faculty_count: connectedFacultyCount,
      mapped_without_collaboration_count: mappedFacultyCount - connectedFacultyCount,
      unmapped_faculty_count: nodes.length - mappedFacultyCount,
      edge_count: edges.length,
      multiple_faculty_work_count: multipleFacultyWorkCount,
      pair_work_count: pairWorkCount,
      cross_department_edge_count: edges.filter((edge) => edge.cross_department).length,
      cross_school_edge_count: edges.filter((edge) => edge.cross_school).length,
    },
    years: {
      minimum: Math.min(...datedYears),
      maximum: Math.max(...datedYears),
      missing_count: missingYearCount,
    },
    departments,
    schools,
    nodes: nodes.sort((left, right) => left.name.localeCompare(right.name)),
    edges,
  };
}

function stampAssetUrls(html, version) {
  let stamped = html;
  for (const asset of [
    "assets/theme.js",
    "assets/collaboration.css",
    "assets/collaboration-core.js",
    "assets/collaboration.js",
  ]) {
    assert(stamped.includes(asset), `index.html does not reference ${asset}`);
    stamped = stamped.replace(asset, `${asset}?v=${version}`);
  }
  return stamped;
}

function assertSafeOutputDirectory(sourceDirectory, outputDirectory) {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  const root = path.parse(output).root;
  assert(output !== root && output !== source, "Refusing to replace an unsafe output directory");
  assert(output.startsWith(`${source}${path.sep}`), "Output directory must stay inside the project");
}

async function buildSite({
  sourceDirectory = path.resolve(__dirname, ".."),
  outputDirectory = path.resolve(sourceDirectory, DEFAULT_OUTPUT_DIRECTORY),
  fetchImpl = globalThis.fetch,
} = {}) {
  assert(typeof fetchImpl === "function", "This build requires a Fetch-compatible runtime");
  const sourceRoot = path.resolve(sourceDirectory);
  const outputRoot = path.resolve(outputDirectory);
  assertSafeOutputDirectory(sourceRoot, outputRoot);
  const config = parseConfig(
    JSON.parse(await fs.readFile(path.join(sourceRoot, "map-config.json"), "utf8")),
  );
  const revision = await resolveDatasetRevision(config, fetchImpl);
  const artifactDocument = await fetchJsonDocument(
    fetchImpl,
    artifactUrl(config, revision),
    "Pinned publication artifact",
    MAX_ARTIFACT_BYTES,
  );
  const graph = deriveGraph(artifactDocument.value, config, revision);
  const graphText = JSON.stringify(graph);
  const graphDigest = crypto.createHash("sha256").update(graphText).digest("hex");
  const artifactName = `collaborations.${revision}.json`;
  const outputConfig = {
    ...config,
    dataset_revision: revision,
    graph_artifact: `data/${artifactName}`,
    graph_sha256: graphDigest,
  };

  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(outputRoot, "assets"), { recursive: true });
  await fs.mkdir(path.join(outputRoot, "data"), { recursive: true });
  const html = await fs.readFile(path.join(sourceRoot, "index.html"), "utf8");
  await fs.writeFile(
    path.join(outputRoot, "index.html"),
    stampAssetUrls(html, revision.slice(0, 12)),
    "utf8",
  );
  for (const asset of [
    "theme.js",
    "collaboration.css",
    "collaboration-core.js",
    "collaboration.js",
    "favicon.svg",
  ]) {
    await fs.copyFile(
      path.join(sourceRoot, "assets", asset),
      path.join(outputRoot, "assets", asset),
    );
  }
  await fs.writeFile(
    path.join(outputRoot, "map-config.json"),
    `${JSON.stringify(outputConfig, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(outputRoot, "data", artifactName), graphText, "utf8");
  await fs.writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");

  return {
    revision,
    graph,
    artifactName,
    graphBytes: Buffer.byteLength(graphText),
    graphDigest,
  };
}

async function configuredDatasetRevision({
  sourceDirectory = path.resolve(__dirname, ".."),
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = parseConfig(
    JSON.parse(await fs.readFile(path.join(sourceDirectory, "map-config.json"), "utf8")),
  );
  return resolveDatasetRevision(config, fetchImpl);
}

if (require.main === module) {
  (async () => {
    if (process.argv.includes("--revision-only")) {
      process.stdout.write(`${await configuredDatasetRevision()}\n`);
      return;
    }
    const result = await buildSite();
    process.stdout.write(
      [
        `Staged ${result.graph.counts.faculty_count.toLocaleString()} faculty and ${result.graph.counts.edge_count.toLocaleString()} observed collaborations`,
        `Source: ${result.graph.counts.work_count.toLocaleString()} works at ${result.revision}`,
        `Artifact: data/${result.artifactName} (${result.graphBytes.toLocaleString()} bytes, sha256 ${result.graphDigest})`,
      ].join("\n") + "\n",
    );
  })().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  GRAPH_SCHEMA_VERSION,
  artifactUrl,
  buildSite,
  canonicalEdgeKey,
  configuredDatasetRevision,
  deriveGraph,
  layoutGraph,
  parseConfig,
  resolveDatasetRevision,
  stampAssetUrls,
};
