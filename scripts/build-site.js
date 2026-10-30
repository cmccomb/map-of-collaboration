"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_OUTPUT_DIRECTORY = "_site";
const MAX_API_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const GRAPH_SCHEMA_VERSION = 1;
const EXPECTED_SOURCE_SCHEMAS = new Set([7, 8]);

const DEPARTMENT_PRESENTATION = Object.freeze({
  bio: { short_title: "Bio", color_dark: "#8edca4", color_light: "#2c8952" },
  bme: { short_title: "BME", color_dark: "#ff9f8b", color_light: "#b94331" },
  cbd: { short_title: "CBD", color_dark: "#b9df8a", color_light: "#648b2b" },
  chem: { short_title: "Chem", color_dark: "#e6d37d", color_light: "#806d18" },
  cheme: { short_title: "ChemE", color_dark: "#73c5df", color_light: "#14738e" },
  civil: { short_title: "CEE", color_dark: "#ffc36f", color_light: "#9b6217" },
  "cmu-africa": { short_title: "Africa", color_dark: "#91d4a5", color_light: "#30774a" },
  "cmu-silicon-valley": { short_title: "Silicon Valley", color_dark: "#b6a7ec", color_light: "#624ea2" },
  csd: { short_title: "CSD", color_dark: "#9db4ff", color_light: "#475faa" },
  ece: { short_title: "ECE", color_dark: "#f39dca", color_light: "#a63f76" },
  epp: { short_title: "EPP", color_dark: "#dcaa91", color_light: "#8d573d" },
  hcii: { short_title: "HCII", color_dark: "#ffb8d7", color_light: "#a24370" },
  "heinz-faculty": { short_title: "Heinz faculty", color_dark: "#edb98d", color_light: "#9c612f" },
  "heinz-ism": { short_title: "Heinz ISM", color_dark: "#94d2c5", color_light: "#2b8574" },
  "heinz-ppm": { short_title: "Heinz PPM", color_dark: "#f4c397", color_light: "#a36232" },
  iii: { short_title: "iii", color_dark: "#80d6cf", color_light: "#247c76" },
  ini: { short_title: "INI", color_dark: "#d5d279", color_light: "#777518" },
  lti: { short_title: "LTI", color_dark: "#b8a7ff", color_light: "#6954b3" },
  math: { short_title: "Math", color_dark: "#f6a7a0", color_light: "#a64742" },
  mech: { short_title: "MechE", color_dark: "#66b5ff", color_light: "#1769a8" },
  mld: { short_title: "MLD", color_dark: "#81d7f0", color_light: "#197d9d" },
  mse: { short_title: "MSE", color_dark: "#c4a0e8", color_light: "#75509b" },
  physics: { short_title: "Physics", color_dark: "#a8cbd0", color_light: "#437d84" },
  ri: { short_title: "RI", color_dark: "#f8b683", color_light: "#a95a22" },
  s3d: { short_title: "S3D", color_dark: "#e4a5ea", color_light: "#9b4e9f" },
  "tepper-faculty": { short_title: "Tepper faculty", color_dark: "#d5b4f5", color_light: "#794caa" },
});
const SCHOOL_PRESENTATION = Object.freeze({
  cfa: { color_dark: "#edb4da", color_light: "#99466f" },
  dietrich: { color_dark: "#b8d8a0", color_light: "#5a8138" },
  engineering: { color_dark: "#9acbfa", color_light: "#326da0" },
  heinz: { color_dark: "#edb98d", color_light: "#9c612f" },
  mcs: { color_dark: "#d4c0f1", color_light: "#765a9d" },
  scs: { color_dark: "#9fd7d4", color_light: "#317d78" },
  tepper: { color_dark: "#d5b4f5", color_light: "#794caa" },
});
const ACADEMIC_UNIT_TYPES = new Set(["department", "constituent_school", "institute"]);
const HOME_UNIT_TYPES = new Set([...ACADEMIC_UNIT_TYPES, "campus"]);
const ROSTER_CONTAINER_IDS = new Set(["heinz-faculty", "tepper-faculty"]);

function academicHomeGroup(type, id) {
  return type === "school" || type === "academic_area" ? `${type}:${id}` : id;
}

function academicHomePresentation(type, id, schoolId) {
  if (type === "school") {
    return { short_title: schoolId === "tepper" ? "Tepper" : schoolId === "heinz" ? "Heinz" : id,
      ...(SCHOOL_PRESENTATION[schoolId] || SCHOOL_PRESENTATION.engineering) };
  }
  if (type === "academic_area") {
    const hue = Math.floor(hashUnit(id, "academic-area-color") * 360);
    return { short_title: id.replace(/^tepper:/, ""),
      color_dark: `hsl(${hue} 62% 72%)`, color_light: `hsl(${hue} 63% 36%)` };
  }
  return DEPARTMENT_PRESENTATION[id] || {
    short_title: id,
    color_dark: "#73c5df",
    color_light: "#197b99",
  };
}

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

function layoutGraph(nodes, edges, academicHomes) {
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const connectedNodes = nodes.filter((node) => connected.has(node.id));
  const nodeIndex = new Map(connectedNodes.map((node, index) => [node.id, index]));
  const departmentIndex = new Map(
    academicHomes.map((home, index) => [home.home_group || home.department_id, index]),
  );
  const departmentCenters = new Map(
    academicHomes.map((home, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, academicHomes.length)) * Math.PI * 2;
      return [
        home.home_group || home.department_id,
        { x: Math.cos(angle) * 0.52, y: Math.sin(angle) * 0.42 },
      ];
    }),
  );

  const positions = connectedNodes.map((node) => {
    const center = departmentCenters.get(node.primary_home_group || node.primary_department) || { x: 0, y: 0 };
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
      const center = departmentCenters.get(node.primary_home_group || node.primary_department) || { x: 0, y: 0 };
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
        (departmentIndex.get(left.primary_home_group || left.primary_department) || 0) -
          (departmentIndex.get(right.primary_home_group || right.primary_department) || 0) ||
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
    EXPECTED_SOURCE_SCHEMAS.has(artifact.schema_version),
    `Expected publication schema 7 or 8, received ${artifact.schema_version}`,
  );
  assert(Array.isArray(artifact.points), "Publication artifact is missing points");
  assert(Array.isArray(artifact.catalogs?.faculty), "Publication artifact is missing faculty");
  assert(Array.isArray(artifact.catalogs?.departments), "Publication artifact is missing departments");
  assert(
    artifact.point_count === artifact.points.length,
    "Publication artifact point_count does not match its rows",
  );
  const hasPendingRows = Object.hasOwn(artifact, "pending_publications");
  const hasPendingCount = Object.hasOwn(artifact, "pending_publication_count");
  assert(artifact.schema_version === 8
    ? hasPendingRows && hasPendingCount
    : !hasPendingRows && !hasPendingCount,
  "Publication artifact pending rows require schema 8 and both pending fields");
  const pendingRows = artifact.schema_version === 8 ? artifact.pending_publications : [];
  assert(Array.isArray(pendingRows) && pendingRows.length <= 50000,
    "Publication artifact has invalid pending publications");
  if (artifact.schema_version === 8) {
    assert(artifact.pending_publication_count === pendingRows.length,
      "Publication artifact pending_publication_count does not match its rows");
  }

  const departments = artifact.catalogs.departments.map((department) => {
    const id = String(department.department_id);
    const unitType = String(department.unit_type || (ROSTER_CONTAINER_IDS.has(id)
      ? "roster_container" : id === "cmu-silicon-valley" ? "campus" : "department"));
    assert(HOME_UNIT_TYPES.has(unitType) || unitType === "roster_container",
      `Department ${id} has an invalid unit type`);
    const presentation = academicHomePresentation(unitType, id, department.school_id);
    return {
      department_id: id,
      title: String(department.title),
      short_title: DEPARTMENT_PRESENTATION[id]?.short_title || String(department.title),
      directory_url: String(department.directory_url || ""),
      color_dark: presentation.color_dark,
      color_light: presentation.color_light,
      unit_type: unitType,
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
  const academicHomeByGroup = new Map(departments
    .filter((department) => HOME_UNIT_TYPES.has(department.unit_type))
    .map((department) => [department.department_id, {
      home_group: department.department_id,
      home_type: department.unit_type,
      home_id: department.department_id,
      title: department.title,
      short_title: department.short_title,
      school_id: department.school_id,
      color_dark: department.color_dark,
      color_light: department.color_light,
    }]));
  for (const department of departments.filter((item) => item.unit_type === "roster_container")) {
    const school = schoolById.get(department.school_id);
    const group = academicHomeGroup("school", school.school_id);
    if (academicHomeByGroup.has(group)) continue;
    const presentation = academicHomePresentation("school", school.school_id, school.school_id);
    academicHomeByGroup.set(group, {
      home_group: group, home_type: "school", home_id: school.school_id,
      title: school.title, short_title: presentation.short_title,
      school_id: school.school_id,
      color_dark: presentation.color_dark, color_light: presentation.color_light,
    });
  }

  const facultyIds = new Set();
  const facultyNodes = artifact.catalogs.faculty.map((person) => {
    const id = String(person.person_id || "");
    assert(id && !facultyIds.has(id), `Duplicate or invalid faculty ID: ${id}`);
    facultyIds.add(id);
    const memberships = Array.isArray(person.memberships) ? person.memberships : [];
    const personDepartments = [
      ...new Set(
        memberships
          .filter((membership) => membership?.included !== false)
          .map((membership) => String(membership.department_id || ""))
          .filter((departmentId) => departmentIds.has(departmentId)),
      ),
    ];
    assert(personDepartments.length > 0, `Faculty ${id} has no included department`);
    const academicMemberships = personDepartments.filter((departmentId) =>
      ACADEMIC_UNIT_TYPES.has(departmentById.get(departmentId).unit_type));
    // An explicit unresolved typed home is an editorial decision. For older
    // artifacts, infer only a sole academic unit, never a roster container.
    const hasTypedHome = Object.hasOwn(person, "primary_academic_home_type");
    const hasPrimary = Object.hasOwn(person, "primary_department_id");
    const legacyPrimaryId = hasPrimary ? String(person.primary_department_id || "").trim() : "";
    const inferredId = !hasTypedHome && !hasPrimary && academicMemberships.length === 1
      ? academicMemberships[0] : "";
    const homeId = hasTypedHome ? String(person.primary_academic_home_id || "").trim()
      : legacyPrimaryId || inferredId;
    const homeType = hasTypedHome ? String(person.primary_academic_home_type || "unresolved").trim()
      : homeId ? departmentById.get(homeId)?.unit_type || "department" : "unresolved";
    assert(homeType === "unresolved" || HOME_UNIT_TYPES.has(homeType)
      || ["academic_area", "school"].includes(homeType),
    `Faculty ${id} has an invalid primary academic home type`);
    assert((homeType === "unresolved") === !homeId,
      `Faculty ${id} has an incomplete primary academic home`);
    const homeSchoolId = hasTypedHome ? String(person.primary_academic_home_school_id || "").trim()
      : homeId ? departmentById.get(homeId)?.school_id || "" : "";
    const homeTitle = hasTypedHome ? String(person.primary_academic_home_title || "").trim()
      : homeId ? departmentById.get(homeId)?.title || "" : "";
    if (homeId) {
      assert(schoolIds.has(homeSchoolId), `Faculty ${id} has an invalid primary home school`);
      if (HOME_UNIT_TYPES.has(homeType)) {
        assert(personDepartments.includes(homeId)
          && departmentById.get(homeId)?.unit_type === homeType,
        `Faculty ${id} has a primary home unit outside their memberships`);
        assert(homeTitle === departmentById.get(homeId).title
          && homeSchoolId === departmentById.get(homeId).school_id,
        `Faculty ${id} has an inconsistent primary academic unit`);
      } else if (homeType === "school") {
        assert(homeId === homeSchoolId && schoolById.get(homeId)?.title === homeTitle
          && personDepartments.some((departmentId) =>
            departmentById.get(departmentId).school_id === homeId
            && departmentById.get(departmentId).unit_type === "roster_container"),
        `Faculty ${id} has an invalid school-level primary home`);
      } else {
        assert(/^tepper:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(homeId)
          && homeSchoolId === "tepper" && homeTitle
          && personDepartments.includes("tepper-faculty"),
        `Faculty ${id} has an invalid academic-area primary home`);
      }
    }
    const primaryDepartment = homeType === "department" ? homeId : "";
    assert(!legacyPrimaryId || (homeType === "department" && legacyPrimaryId === homeId),
      `Faculty ${id} has a legacy primary department inconsistent with its typed home`);
    const homeGroup = homeId ? academicHomeGroup(homeType, homeId) : "";
    if (homeId && !academicHomeByGroup.has(homeGroup)) {
      const presentation = academicHomePresentation(homeType, homeId, homeSchoolId);
      academicHomeByGroup.set(homeGroup, {
        home_group: homeGroup, home_type: homeType, home_id: homeId,
        title: homeTitle, short_title: presentation.short_title,
        school_id: homeSchoolId,
        color_dark: presentation.color_dark, color_light: presentation.color_light,
      });
    }
    assert(!homeId || academicHomeByGroup.get(homeGroup)?.title === homeTitle,
      `Faculty ${id} has an inconsistent primary academic home title`);
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
    assert(!homeSchoolId || personSchools.includes(homeSchoolId),
      `Faculty ${id} has a primary home outside their schools`);
    personSchools.forEach((schoolId) => {
      schoolById.get(schoolId).faculty_count += 1;
    });
    return {
      id,
      name: String(person.display_name || id),
      departments: personDepartments,
      academic_departments: academicMemberships,
      primary_department: primaryDepartment,
      primary_academic_home_type: homeType,
      primary_academic_home_id: homeId,
      primary_academic_home_title: homeTitle,
      primary_academic_home_school_id: homeSchoolId,
      primary_academic_home_basis: homeId
        ? String(hasTypedHome ? person.primary_academic_home_basis || ""
          : person.primary_department_basis || (hasPrimary ? "" : "single_included_membership"))
        : "unresolved",
      primary_academic_home_source_url: homeId ? safeSourceUrl({
        source_url: hasTypedHome ? person.primary_academic_home_source_url
          : person.primary_department_source_url,
      }) : "",
      primary_academic_home_verified_at: homeId && hasTypedHome
        ? String(person.primary_academic_home_verified_at || "") : "",
      primary_home_group: homeGroup,
      school_ids: personSchools,
      primary_school: homeSchoolId
        ? homeSchoolId
        : personSchools.length === 1 ? personSchools[0] : "",
      roles: [...new Set(memberships.map((membership) => String(membership.role || "faculty")))],
      publication_count: Math.max(0, Number(person.publication_count) || 0),
      publication_hold_reason: typeof person.publication_hold_reason === "string"
        ? person.publication_hold_reason.trim() : "",
      mapped_publication_count: 0,
      ...(artifact.schema_version === 8 ? { pending_publication_count: 0 } : {}),
      reported_coauthor_work_count: 0,
      collaborator_count: 0,
      collaboration_count: 0,
      homepage_url: String(person.homepage_url || ""),
      scholar_url: scholarUrl(person.scholar_id),
      orcid_url: orcidUrl(person.orcid),
      x: 0,
      y: 0,
    };
  });
  const externalCatalog = artifact.catalogs.external_coauthors || [];
  assert(Array.isArray(externalCatalog), "Publication artifact has invalid external coauthors");
  const externalIds = new Set();
  const externalNodes = externalCatalog.map((person) => {
    const id = String(person.person_id || "");
    assert(id && !facultyIds.has(id) && !externalIds.has(id),
      `Duplicate or invalid external coauthor ID: ${id}`);
    externalIds.add(id);
    const name = String(person.display_name || "").trim();
    const sourceUrl = String(person.source_url || "");
    assert(name && safeSourceUrl({ source_url: sourceUrl }),
      `External coauthor ${id} needs a name and public source URL`);
    return {
      id,
      kind: "external_coauthor",
      name,
      departments: [],
      academic_departments: [],
      primary_department: "",
      primary_academic_home_type: "unresolved",
      primary_academic_home_id: "",
      primary_academic_home_title: "",
      primary_academic_home_school_id: "",
      primary_academic_home_basis: "unresolved",
      primary_academic_home_source_url: "",
      primary_academic_home_verified_at: "",
      primary_home_group: "",
      school_ids: [],
      primary_school: "",
      roles: [],
      publication_count: 0,
      mapped_publication_count: 0,
      ...(artifact.schema_version === 8 ? { pending_publication_count: 0 } : {}),
      reported_coauthor_work_count: 0,
      collaborator_count: 0,
      collaboration_count: 0,
      homepage_url: sourceUrl,
      scholar_url: "",
      orcid_url: "",
      x: 0,
      y: 0,
    };
  });
  const nodes = [...facultyNodes, ...externalNodes];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const facultyById = new Map(artifact.catalogs.faculty.map((person) => [person.person_id, person]));
  const keywordById = new Map(
    (artifact.keywords || []).map((keyword) => [keyword.keyword_id, keyword.label]),
  );
  const mappedWorkIds = new Set(artifact.points.map((point) => String(point.work_id || "")));
  const workIds = new Set();
  const edgeMap = new Map();
  let missingYearCount = 0;
  let multipleFacultyWorkCount = 0;
  let invalidFacultyReferenceCount = 0;
  let duplicateFacultyReferenceCount = 0;
  let duplicateExternalReferenceCount = 0;
  let reportedCoauthorWorkCount = 0;
  let pendingPairWorkCount = 0;
  const pendingWorkIds = new Set();

  for (const pending of pendingRows) {
    assert(pending && typeof pending === "object" && !Array.isArray(pending),
      "Publication artifact has an invalid pending work");
    const allowedKeys = [
      "work_id", "title", "year", "faculty_ids", "source_url", "release_decision",
      "map_hold_reason", "collaboration_eligible",
    ];
    assert(Object.keys(pending).length === allowedKeys.length
      && Object.keys(pending).every((key) => allowedKeys.includes(key)),
    "Publication artifact pending work has unexpected fields");
    assert(typeof pending.work_id === "string" && typeof pending.title === "string"
      && typeof pending.source_url === "string",
    "Publication artifact pending work has invalid text fields");
    const workId = pending.work_id;
    assert(workId && !pendingWorkIds.has(workId)
      && !mappedWorkIds.has(workId),
    `Publication artifact has duplicate pending work ID: ${workId}`);
    pendingWorkIds.add(workId);
    assert(String(pending.title || "").trim(), `Pending work ${workId} has no title`);
    assert(pending.year === null
      || (Number.isInteger(pending.year) && pending.year >= 1800 && pending.year <= 2200),
    `Pending work ${workId} has invalid year`);
    assert(Array.isArray(pending.faculty_ids) && pending.faculty_ids.length > 0
      && new Set(pending.faculty_ids).size === pending.faculty_ids.length
      && pending.faculty_ids.every((id) => typeof id === "string" && facultyIds.has(id)),
    `Pending work ${workId} has invalid faculty IDs`);
    for (const facultyId of pending.faculty_ids) {
      const person = facultyById.get(facultyId);
      assert(person && Object.hasOwn(person, "primary_academic_home_type")
        && person.primary_academic_home_type !== "unresolved"
        && String(person.primary_academic_home_id || "").trim()
        && String(person.primary_academic_home_source_url || "").trim()
        && String(person.primary_academic_home_verified_at || "").trim()
        && String(person.primary_academic_home_basis || "").trim(),
      `Pending work ${workId} has faculty without an evidenced typed home`);
    }
    let safePendingUrl = false;
    try {
      const url = new URL(pending.source_url);
      safePendingUrl = url.protocol === "https:" && !url.username && !url.password;
    } catch {
      // A pending work must have a reviewed public source link.
    }
    assert(safePendingUrl, `Pending work ${workId} has invalid source URL`);
    assert(pending.release_decision === "selected"
      && pending.map_hold_reason === "pending_topic_review",
    `Pending work ${workId} is not selected for topic review`);
    assert(typeof pending.collaboration_eligible === "boolean",
      `Pending work ${workId} has invalid collaboration eligibility`);
  }

  for (const point of [...artifact.points, ...pendingRows]) {
    const workId = String(point.work_id || "");
    const pending = pendingWorkIds.has(workId);
    assert(workId && !workIds.has(workId), `Duplicate or invalid work ID: ${workId}`);
    workIds.add(workId);
    assert(String(point.title || "").trim(), `Work ${workId} has no title`);
    assert(point.collaboration_eligible === undefined
      || typeof point.collaboration_eligible === "boolean",
    `Work ${workId} has invalid collaboration eligibility`);
    const collaborationEligible = point.collaboration_eligible !== false;
    const originalFaculty = Array.isArray(point.faculty_ids) ? point.faculty_ids.map(String) : [];
    const pointFaculty = [...new Set(originalFaculty)];
    duplicateFacultyReferenceCount += originalFaculty.length - pointFaculty.length;
    const validFaculty = pointFaculty.filter((facultyId) => {
      if (facultyIds.has(facultyId)) return true;
      invalidFacultyReferenceCount += 1;
      return false;
    });
    assert(validFaculty.length > 0, `Work ${workId} has no valid faculty relationship`);
    const originalReported = point.reported_faculty_coauthors === undefined
      ? [] : point.reported_faculty_coauthors;
    assert(Array.isArray(originalReported), `Work ${workId} has invalid reported faculty coauthors`);
    const reportedFaculty = originalReported.map((entry) => {
      assert(entry && typeof entry === "object" && !Array.isArray(entry),
        `Work ${workId} has invalid reported faculty coauthor evidence`);
      const personId = String(entry.person_id || "");
      const sourcePersonId = String(entry.source_person_id || "");
      const sourceObservationId = String(entry.source_observation_id || "");
      const sourceUrl = String(entry.source_url || "");
      const verifiedAt = String(entry.verified_at || "");
      let isHttps = false;
      try {
        isHttps = new URL(sourceUrl).protocol === "https:";
      } catch {
        // A publisher or institutional byline source must have a usable URL.
      }
      assert(facultyIds.has(personId) && !validFaculty.includes(personId)
        && validFaculty.includes(sourcePersonId) && personId !== sourcePersonId
        && sourceObservationId && isHttps && /^\d{4}-\d{2}-\d{2}$/.test(verifiedAt),
      `Work ${workId} has invalid reported faculty coauthor evidence`);
      return {
        person_id: personId,
        source_person_id: sourcePersonId,
        source_observation_id: sourceObservationId,
        source_url: sourceUrl,
        verified_at: verifiedAt,
      };
    });
    const reportedIds = reportedFaculty.map((entry) => entry.person_id);
    assert(new Set(reportedIds).size === reportedIds.length,
      `Work ${workId} repeats a reported faculty coauthor`);
    assert(!reportedFaculty.length || (point.collaboration_eligible === true
      && Array.isArray(point.source_types) && point.source_types.includes("scholar")),
    `Work ${workId} has reported faculty coauthors without an eligible Scholar source`);
    const originalExternal = Array.isArray(point.external_coauthor_ids)
      ? point.external_coauthor_ids.map(String)
      : [];
    const pointExternal = [...new Set(originalExternal)];
    duplicateExternalReferenceCount += originalExternal.length - pointExternal.length;
    assert(pointExternal.every((id) => externalIds.has(id)),
      `Work ${workId} has an unknown external coauthor`);
    if (pointExternal.length) {
      assert(Array.isArray(point.source_types) && point.source_types.includes("curated_verified"),
        `Work ${workId} has an external coauthor without verified source type`);
      assert(Array.isArray(point.source_verification_urls)
        && point.source_verification_urls.some((url) => safeSourceUrl({ source_url: url })),
      `Work ${workId} has an external coauthor without a public verification URL`);
    }
    if (Array.isArray(point.school_ids)) {
      assert(point.school_ids.every((schoolId) => schoolIds.has(String(schoolId))),
        `Work ${workId} has invalid school references`);
    }
    validFaculty.forEach((facultyId) => {
      nodeById.get(facultyId)[pending ? "pending_publication_count" : "mapped_publication_count"] += 1;
    });
    reportedIds.forEach((facultyId) => {
      nodeById.get(facultyId).reported_coauthor_work_count += 1;
    });
    if (reportedIds.length) reportedCoauthorWorkCount += 1;
    if (collaborationEligible) {
      pointExternal.forEach((id) => {
        nodeById.get(id).mapped_publication_count += 1;
      });
    }
    const year = Number.isInteger(point.year) ? point.year : null;
    if (year === null) missingYearCount += 1;
    if (!collaborationEligible) continue;
    const graphFaculty = [...validFaculty, ...reportedIds];
    if (graphFaculty.length > 1) multipleFacultyWorkCount += 1;
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
      ...(pending ? { map_hold_reason: "pending_topic_review" } : {}),
      ...(Array.isArray(point.source_types)
        && point.source_types.some((type) => type === "curated_verified" || type === "author_site")
        ? { source_types: [...new Set(point.source_types.map(String))] }
        : {}),
      ...(point.source_verified_at
        ? { source_verified_at: String(point.source_verified_at) }
        : {}),
      ...(Array.isArray(point.source_verification_urls) && point.source_verification_urls.length
        ? { source_verification_urls: [...new Set(point.source_verification_urls.map(String))] }
        : {}),
      topic: pending ? "" : (point.source_types?.includes("curated_verified")
        || point.source_types?.includes("author_site"))
        && !point.source_types.includes("scholar")
        ? ""
        : String(keywordById.get(detailedTopicId) || ""),
    };
    const includedAuthors = [...graphFaculty, ...pointExternal].sort();
    for (let left = 0; left < includedAuthors.length; left += 1) {
      for (let right = left + 1; right < includedAuthors.length; right += 1) {
        const source = includedAuthors[left];
        const target = includedAuthors[right];
        if (externalIds.has(source) && externalIds.has(target)) continue;
        const key = canonicalEdgeKey(source, target);
        if (!edgeMap.has(key)) {
          const bothFaculty = facultyIds.has(source) && facultyIds.has(target);
          edgeMap.set(key, {
            source,
            target,
            cross_department: bothFaculty
              && nodeById.get(source).academic_departments.length > 0
              && nodeById.get(target).academic_departments.length > 0
              && !intersections(
                nodeById.get(source).academic_departments,
                nodeById.get(target).academic_departments,
              ),
            cross_school: bothFaculty && !intersections(
              nodeById.get(source).school_ids,
              nodeById.get(target).school_ids,
            ),
            works: [],
          });
        }
        const edgeReported = reportedFaculty.filter((entry) =>
          entry.person_id === source || entry.person_id === target);
        edgeMap.get(key).works.push(edgeReported.length
          ? { ...work, reported_faculty_coauthors: edgeReported }
          : work);
        if (pending) pendingPairWorkCount += 1;
      }
    }
  }

  assert(invalidFacultyReferenceCount === 0, "Publication artifact has invalid faculty references");
  assert(duplicateFacultyReferenceCount === 0, "Publication artifact has duplicate faculty references");
  assert(duplicateExternalReferenceCount === 0, "Publication artifact has duplicate external references");
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
  const academicHomes = [...academicHomeByGroup.values()];
  layoutGraph(
    nodes,
    edges.map((edge) => ({ ...edge, weight: edge.works.length })),
    academicHomes,
  );

  const datedYears = [...artifact.points, ...pendingRows]
    .map((point) => point.year)
    .filter(Number.isInteger);
  const mappedFacultyCount = facultyNodes.filter((node) => node.mapped_publication_count > 0).length;
  const connectedFacultyCount = facultyNodes.filter((node) => node.collaborator_count > 0).length;
  const mappedWithoutCollaborationCount = facultyNodes.filter((node) =>
    node.mapped_publication_count > 0 && node.collaborator_count === 0).length;
  const reportedOnlyFacultyCount = facultyNodes.filter((node) =>
    node.mapped_publication_count === 0 && node.reported_coauthor_work_count > 0).length;
  const pendingOnlyFacultyCount = facultyNodes.filter((node) =>
    node.mapped_publication_count === 0 && node.pending_publication_count > 0).length;
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
      coverage_note: externalNodes.length
        ? "External coauthors are a selected, source-verified subset, not a comprehensive outside-collaborator graph. A missing edge means no shared work was observed among indexed people in this artifact; it does not establish that no collaboration exists."
        : "A missing edge means no shared work was observed between two cataloged faculty IDs in this artifact; it does not establish that no collaboration exists.",
    },
    counts: {
      work_count: artifact.points.length,
      ...(artifact.schema_version === 8 ? {
        pending_work_count: pendingRows.length,
        pending_pair_work_count: pendingPairWorkCount,
        pending_only_faculty_count: pendingOnlyFacultyCount,
      } : {}),
      faculty_count: facultyNodes.length,
      mapped_faculty_count: mappedFacultyCount,
      connected_faculty_count: connectedFacultyCount,
      mapped_without_collaboration_count: mappedWithoutCollaborationCount,
      unmapped_faculty_count: facultyNodes.length - mappedFacultyCount,
      ...(reportedCoauthorWorkCount ? {
        reported_coauthor_work_count: reportedCoauthorWorkCount,
        reported_coauthor_only_faculty_count: reportedOnlyFacultyCount,
      } : {}),
      ...(externalNodes.length ? { external_coauthor_count: externalNodes.length } : {}),
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
    academic_homes: academicHomes,
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
