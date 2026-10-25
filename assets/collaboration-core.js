"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CollaborationCore = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const GRAPH_SCHEMA_VERSION = 1;
  const SAFE_PROTOCOLS = new Set(["https:", "http:"]);
  const EXTERNAL_LAYOUT_GROUP = "__external_coauthors__";
  const UNRESOLVED_LAYOUT_GROUP = "__primary_unresolved__";
  const ACADEMIC_UNIT_TYPES = new Set(["department", "constituent_school", "institute"]);
  const HOME_UNIT_TYPES = new Set([...ACADEMIC_UNIT_TYPES, "campus"]);

  function academicHomeGroup(type, id) {
    return type === "school" || type === "academic_area" ? `${type}:${id}` : id;
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function integer(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  }

  function uniqueStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(String))];
  }

  function edgeKey(left, right) {
    return String(left) < String(right)
      ? `${left}|${right}`
      : `${right}|${left}`;
  }

  function safeExternalUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value));
      return SAFE_PROTOCOLS.has(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function doiUrl(doi) {
    const cleaned = String(doi || "").trim().replace(/^https?:\/\/doi\.org\//i, "");
    return cleaned ? `https://doi.org/${encodeURI(cleaned)}` : "";
  }

  function academicHomeDisplayText(node, title) {
    const tieBreak = node.primary_academic_home_basis === "display_tie_break_first_listed";
    const basis = {
      display_tie_break_first_listed: "display tie-break: first-listed department",
      inferred_advisee_count: "inferred from PhD advisees",
      inferred_profile_title: "inferred from faculty title",
      reviewed: "reviewed",
      single_included_membership: "sole included academic unit",
      school_fallback: "school-level home; no narrower unit verified",
    }[node.primary_academic_home_basis] || "display choice";
    const typeLabel = {
      department: "department",
      campus: "campus",
      constituent_school: "constituent school",
      institute: "institute",
      academic_area: "academic area",
      school: "school",
    }[node.primary_academic_home_type] || "academic home";
    return `${tieBreak ? "Map display home" : "Primary academic home"}: ${title} (${typeLabel}; ${basis})`;
  }

  function parseGraph(input) {
    assert(input && typeof input === "object", "Graph artifact must be an object");
    assert(
      input.schema_version === GRAPH_SCHEMA_VERSION,
      `Unsupported graph schema ${input.schema_version}`,
    );
    assert(Array.isArray(input.nodes), "Graph artifact is missing nodes");
    assert(Array.isArray(input.edges), "Graph artifact is missing edges");
    assert(Array.isArray(input.departments), "Graph artifact is missing departments");

    const departmentIds = new Set();
    const departments = input.departments.map((department) => {
      const id = String(department.department_id || "");
      assert(id && !departmentIds.has(id), `Invalid or duplicate department ID: ${id}`);
      departmentIds.add(id);
      return {
        department_id: id,
        title: String(department.title || id),
        short_title: String(department.short_title || department.title || id),
        school_id: String(department.school_id || "engineering"),
        unit_type: String(department.unit_type || (["heinz-faculty", "tepper-faculty"].includes(id)
          ? "roster_container" : id === "cmu-silicon-valley" ? "campus" : "department")),
        directory_url: safeExternalUrl(department.directory_url),
        color_dark: String(department.color_dark || "#73c5df"),
        color_light: String(department.color_light || "#197b99"),
        faculty_count: Math.max(0, integer(department.faculty_count)),
      };
    });
    const hasSchools = Array.isArray(input.schools);
    const schoolIds = new Set();
    const schools = (hasSchools
      ? input.schools
      : [{ school_id: "engineering", title: "College of Engineering" }]
    ).map((school) => {
      const id = String(school.school_id || "");
      assert(id && !schoolIds.has(id), `Invalid or duplicate school ID: ${id}`);
      schoolIds.add(id);
      return {
        school_id: id,
        title: String(school.title || id),
        directory_url: safeExternalUrl(school.directory_url),
        faculty_count: Math.max(0, integer(school.faculty_count)),
      };
    });
    assert(schools.length > 0, "Graph artifact is missing schools");
    assert(departments.every((department) => schoolIds.has(department.school_id)),
      "Graph artifact has a department with an invalid school");
    const departmentById = new Map(departments.map((department) =>
      [department.department_id, department]));
    const sourceHomes = Array.isArray(input.academic_homes)
      ? input.academic_homes
      : departments.filter((department) => HOME_UNIT_TYPES.has(department.unit_type))
        .map((department) => ({
          home_group: department.department_id,
          home_type: department.unit_type,
          home_id: department.department_id,
          title: department.title,
          short_title: department.short_title,
          school_id: department.school_id,
          color_dark: department.color_dark,
          color_light: department.color_light,
        }));
    const academicHomes = sourceHomes.map((home) => {
      const type = String(home.home_type || "");
      const id = String(home.home_id || "");
      const group = academicHomeGroup(type, id);
      assert(id && group === String(home.home_group || ""),
        `Invalid primary academic home group: ${group}`);
      assert(HOME_UNIT_TYPES.has(type) || ["academic_area", "school"].includes(type),
        `Invalid primary academic home type: ${type}`);
      const schoolId = String(home.school_id || "");
      assert(schoolIds.has(schoolId), `Primary home ${group} has an invalid school`);
      if (HOME_UNIT_TYPES.has(type)) {
        assert(departmentById.get(id)?.unit_type === type
          && departmentById.get(id)?.school_id === schoolId,
        `Primary home ${group} is not a matching academic unit`);
      } else if (type === "school") {
        assert(id === schoolId, `Primary school home ${group} has a mismatched school`);
      } else {
        assert(/^tepper:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && schoolId === "tepper",
          `Invalid academic area ${group}`);
      }
      return {
        home_group: group, home_type: type, home_id: id,
        title: String(home.title || id),
        short_title: String(home.short_title || home.title || id),
        school_id: schoolId,
        color_dark: String(home.color_dark || "#73c5df"),
        color_light: String(home.color_light || "#197b99"),
      };
    });
    const academicHomeByGroup = new Map(academicHomes.map((home) =>
      [home.home_group, home]));
    assert(academicHomeByGroup.size === academicHomes.length,
      "Graph artifact has duplicate primary academic home groups");

    const nodeIds = new Set();
    const nodes = input.nodes.map((node) => {
      const id = String(node.id || "");
      assert(id && !nodeIds.has(id), `Invalid or duplicate faculty ID: ${id}`);
      nodeIds.add(id);
      assert(!node.kind || ["faculty", "external_coauthor"].includes(node.kind),
        `Node ${id} has an invalid kind`);
      const kind = node.kind === "external_coauthor" ? "external_coauthor" : "faculty";
      const departmentsForNode = uniqueStrings(node.departments).filter((item) =>
        departmentIds.has(item),
      );
      const academicDepartments = departmentsForNode.filter((item) =>
        ACADEMIC_UNIT_TYPES.has(departmentById.get(item).unit_type));
      assert(kind === "external_coauthor" ? uniqueStrings(node.departments).length === 0 : departmentsForNode.length > 0,
        kind === "external_coauthor"
          ? `External coauthor ${id} must not have a CMU department`
          : `Faculty ${id} has no valid department`);
      const schoolsForNode = hasSchools
        ? uniqueStrings(node.school_ids)
        : kind === "external_coauthor" ? [] : ["engineering"];
      assert(kind === "external_coauthor"
        ? schoolsForNode.length === 0
        : schoolsForNode.length > 0 && schoolsForNode.every((item) => schoolIds.has(item)),
      kind === "external_coauthor"
        ? `External coauthor ${id} must not have a CMU school`
        : `Faculty ${id} has invalid school memberships`);
      const hasTypedHome = Object.hasOwn(node, "primary_academic_home_type");
      const legacyPrimary = kind === "external_coauthor" ? ""
        : String(node.primary_department || "").trim();
      const homeType = kind === "external_coauthor" ? "unresolved"
        : hasTypedHome ? String(node.primary_academic_home_type || "unresolved")
          : legacyPrimary ? "department" : "unresolved";
      const homeId = kind === "external_coauthor" ? ""
        : hasTypedHome ? String(node.primary_academic_home_id || "").trim() : legacyPrimary;
      const homeGroup = homeId ? academicHomeGroup(homeType, homeId) : "";
      assert((homeType === "unresolved") === !homeId,
        `Faculty ${id} has an incomplete primary academic home`);
      const home = homeId ? academicHomeByGroup.get(homeGroup) : null;
      assert(!homeId || home?.home_type === homeType,
        `Faculty ${id} has an unknown primary academic home`);
      assert(!hasTypedHome || !home || (
        String(node.primary_academic_home_title || "") === home.title
        && String(node.primary_academic_home_school_id || "") === home.school_id
      ), `Faculty ${id} has inconsistent primary academic home details`);
      if (HOME_UNIT_TYPES.has(homeType)) {
        assert(departmentsForNode.includes(homeId),
          `Faculty ${id} has a primary home unit outside their memberships`);
      } else if (homeType === "school") {
        assert(departmentsForNode.some((departmentId) =>
          departmentById.get(departmentId).school_id === homeId
          && departmentById.get(departmentId).unit_type === "roster_container"),
        `Faculty ${id} has a school home without its roster membership`);
      } else if (homeType === "academic_area") {
        assert(departmentsForNode.includes("tepper-faculty"),
          `Faculty ${id} has an academic area without Tepper membership`);
      }
      const primaryDepartment = homeType === "department" ? homeId : "";
      assert(!legacyPrimary || legacyPrimary === primaryDepartment,
        `Faculty ${id} has a legacy primary department inconsistent with its typed home`);
      const primarySchool = home
        ? home.school_id
        : schoolsForNode.length === 1 ? schoolsForNode[0] : "";
      assert(!primarySchool || schoolsForNode.includes(primarySchool),
        `Faculty ${id} has a primary school outside their memberships`);
      assert(Number.isFinite(node.x) && Number.isFinite(node.y), `Faculty ${id} has no position`);
      return {
        id,
        kind,
        name: String(node.name || id),
        departments: departmentsForNode,
        academic_departments: academicDepartments,
        primary_department: primaryDepartment,
        primary_academic_home_type: homeType,
        primary_academic_home_id: homeId,
        primary_academic_home_title: home
          ? String(node.primary_academic_home_title || home.title) : "",
        primary_academic_home_school_id: home?.school_id || "",
        primary_academic_home_basis: home
          ? String(node.primary_academic_home_basis || node.primary_department_basis || "")
          : "unresolved",
        primary_academic_home_source_url: home
          ? safeExternalUrl(node.primary_academic_home_source_url || node.primary_department_source_url)
          : "",
        primary_academic_home_verified_at: home
          ? String(node.primary_academic_home_verified_at || "") : "",
        primary_home_group: homeGroup,
        school_ids: schoolsForNode,
        primary_school: primarySchool,
        roles: uniqueStrings(node.roles),
        publication_count: Math.max(0, integer(node.publication_count)),
        mapped_publication_count: Math.max(0, integer(node.mapped_publication_count)),
        collaborator_count: Math.max(0, integer(node.collaborator_count)),
        collaboration_count: Math.max(0, integer(node.collaboration_count)),
        homepage_url: safeExternalUrl(node.homepage_url),
        scholar_url: safeExternalUrl(node.scholar_url),
        orcid_url: safeExternalUrl(node.orcid_url),
        x: finiteNumber(node.x),
        y: finiteNumber(node.y),
      };
    });

    const seenEdges = new Set();
    const edges = input.edges.map((edge) => {
      const source = String(edge.source || "");
      const target = String(edge.target || "");
      const key = edgeKey(source, target);
      assert(source !== target, `Self-edge is not allowed: ${source}`);
      assert(nodeIds.has(source) && nodeIds.has(target), `Edge ${key} has an unknown faculty ID`);
      assert(!seenEdges.has(key), `Duplicate edge: ${key}`);
      seenEdges.add(key);
      assert(Array.isArray(edge.works) && edge.works.length > 0, `Edge ${key} has no works`);
      const seenWorks = new Set();
      const works = edge.works.map((work) => {
        const id = String(work.id || "");
        assert(id && !seenWorks.has(id), `Edge ${key} has a duplicate work`);
        seenWorks.add(id);
        const year = work.year === null ? null : integer(work.year, null);
        return {
          id,
          title: String(work.title || "Untitled work"),
          year,
          venue: String(work.venue || ""),
          citations: Math.max(0, integer(work.citations)),
          url: safeExternalUrl(work.url) || doiUrl(work.doi),
          source_types: uniqueStrings(work.source_types),
          source_verified_at: String(work.source_verified_at || ""),
          source_verification_urls: uniqueStrings(work.source_verification_urls)
            .map(safeExternalUrl)
            .filter(Boolean),
          topic: String(work.topic || ""),
        };
      });
      return {
        id: key,
        source,
        target,
        cross_department: Boolean(edge.cross_department),
        cross_school: Boolean(edge.cross_school),
        works,
      };
    });
    const externalIds = new Set(nodes
      .filter((node) => node.kind === "external_coauthor")
      .map((node) => node.id));
    assert(edges.every((edge) => {
      const external = [edge.source, edge.target]
        .some((id) => externalIds.has(id));
      return !external || (!edge.cross_department && !edge.cross_school);
    }), "External coauthor edges cannot be cross-department or cross-school");

    const years = input.years || {};
    const yearMinimum = integer(years.minimum, 0);
    const yearMaximum = integer(years.maximum, new Date().getFullYear());
    assert(yearMinimum <= yearMaximum, "Graph artifact has an invalid year domain");

    return {
      schema_version: GRAPH_SCHEMA_VERSION,
      title: String(input.title || "CMU Engineering Collaborations"),
      generated_at_utc: String(input.generated_at_utc || ""),
      source: input.source && typeof input.source === "object" ? { ...input.source } : {},
      quality: input.quality && typeof input.quality === "object" ? { ...input.quality } : {},
      counts: input.counts && typeof input.counts === "object" ? { ...input.counts } : {},
      years: {
        minimum: yearMinimum,
        maximum: yearMaximum,
        missing_count: Math.max(0, integer(years.missing_count)),
      },
      departments,
      academic_homes: academicHomes,
      schools,
      nodes,
      edges,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
      departmentById: new Map(
        departments.map((department) => [department.department_id, department]),
      ),
      academicHomeByGroup,
      schoolById: new Map(schools.map((school) => [school.school_id, school])),
      edgeById: new Map(edges.map((edge) => [edge.id, edge])),
    };
  }

  function defaultState(graph) {
    return {
      departments: [],
      schools: [],
      fromYear: graph.years.minimum,
      toYear: graph.years.maximum,
      minimum: 1,
      crossDepartment: false,
      crossSchool: false,
      showExternal: false,
      showUnconnected: false,
      layout: "collaboration",
      departmentSpacing: 3,
      schoolSpacing: graph.schools.length > 1 ? 8 : 0,
      selectedIds: [],
    };
  }

  function validFacultyIds(values, graph) {
    return uniqueStrings(Array.isArray(values) ? values : [values])
      .filter(Boolean)
      .filter((id) => graph.nodeById.has(id));
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function layoutGroup(node) {
    return node.kind === "external_coauthor" ? EXTERNAL_LAYOUT_GROUP
      : node.primary_home_group || node.primary_department || UNRESOLVED_LAYOUT_GROUP;
  }

  function hasSchoolFocus(state) {
    return Boolean(state.schools?.length);
  }

  function schoolEligible(graph, node, selectedSchoolIds) {
    const selectedSchools = new Set(selectedSchoolIds);
    if (node.kind !== "external_coauthor") {
      return node.school_ids.some((id) => selectedSchools.has(id));
    }
    return graph.edges.some((edge) => {
      if (edge.source !== node.id && edge.target !== node.id) return false;
      const other = graph.nodeById.get(edge.source === node.id ? edge.target : edge.source);
      return other?.school_ids.some((id) => selectedSchools.has(id));
    });
  }

  function scopeEligible(graph, node, selectedDepartmentIds = [], selectedSchoolIds = []) {
    const departments = new Set(selectedDepartmentIds);
    const schools = new Set(selectedSchoolIds);
    const facultyEligible = (person) =>
      (!departments.size || person.departments.some((id) => departments.has(id)))
      && (!schools.size || person.school_ids.some((id) => schools.has(id)));
    if (node.kind !== "external_coauthor") return facultyEligible(node);
    if (!departments.size && !schools.size) return true;
    return graph.edges.some((edge) => {
      if (edge.source !== node.id && edge.target !== node.id) return false;
      const other = graph.nodeById.get(edge.source === node.id ? edge.target : edge.source);
      return Boolean(other) && other.kind !== "external_coauthor" && facultyEligible(other);
    });
  }

  function normalizeView(state, graph) {
    const selectedSchools = new Set(state.schools || []);
    const departments = selectedSchools.size
      ? (state.departments || []).filter((id) =>
          selectedSchools.has(graph.departmentById.get(id)?.school_id))
      : state.departments || [];
    if (!selectedSchools.size && !departments.length) return state;
    return {
      ...state,
      departments,
      selectedIds: validFacultyIds(state.selectedIds || [], graph).filter((id) =>
        scopeEligible(graph, graph.nodeById.get(id), departments, selectedSchools)),
    };
  }

  function stateFromSearch(search, graph) {
    const defaults = defaultState(graph);
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const allowedDepartments = new Set(graph.departments.map((item) => item.department_id));
    const allowedSchools = new Set(graph.schools.map((item) => item.school_id));
    const departments = uniqueStrings((params.get("departments") || "").split(","))
      .filter(Boolean)
      .filter((id) => allowedDepartments.has(id));
    const schools = uniqueStrings((params.get("schools") || "").split(","))
      .filter(Boolean)
      .filter((id) => allowedSchools.has(id));
    let fromYear = clamp(
      integer(params.get("from"), defaults.fromYear),
      graph.years.minimum,
      graph.years.maximum,
    );
    let toYear = clamp(
      integer(params.get("to"), defaults.toYear),
      graph.years.minimum,
      graph.years.maximum,
    );
    if (fromYear > toYear) [fromYear, toYear] = [toYear, fromYear];
    const selectedIds = validFacultyIds(
      params.getAll("faculty").flatMap((value) => value.split(",")),
      graph,
    );
    const layout = ["departments", "department-force"].includes(params.get("layout"))
      ? params.get("layout")
      : "collaboration";
    const view = normalizeView({
      departments,
      schools,
      fromYear,
      toYear,
      minimum: clamp(integer(params.get("minimum"), 1), 1, 20),
      crossDepartment: params.get("cross") === "1",
      crossSchool: graph.schools.length > 1 && params.get("cross_school") === "1",
      showExternal: params.get("external") === "1",
      showUnconnected: params.get("unconnected") === "1",
      layout,
      departmentSpacing: clamp(integer(params.get("spacing"), 3), 1, 10),
      schoolSpacing: graph.schools.length > 1
        ? clamp(integer(params.get("school_spacing"), defaults.schoolSpacing), 0, 10)
        : 0,
      selectedIds,
    }, graph);
    view.showExternal ||= view.selectedIds.some((id) =>
      graph.nodeById.get(id)?.kind === "external_coauthor");
    return view;
  }

  function stateToSearch(state, graph) {
    state = normalizeView(state, graph);
    const defaults = defaultState(graph);
    const params = new URLSearchParams();
    if (state.departments?.length) params.set("departments", [...state.departments].sort().join(","));
    if (state.schools?.length) params.set("schools", [...state.schools].sort().join(","));
    if (state.fromYear !== defaults.fromYear) params.set("from", String(state.fromYear));
    if (state.toYear !== defaults.toYear) params.set("to", String(state.toYear));
    if (state.minimum !== 1) params.set("minimum", String(state.minimum));
    if (state.crossDepartment) params.set("cross", "1");
    if (state.crossSchool && graph.schools.length > 1) params.set("cross_school", "1");
    if (state.showExternal && graph.nodes.some((node) => node.kind === "external_coauthor")) {
      params.set("external", "1");
    }
    if (state.showUnconnected) params.set("unconnected", "1");
    if (["departments", "department-force"].includes(state.layout)) {
      params.set("layout", state.layout);
    }
    const departmentSpacing = clamp(integer(state.departmentSpacing, 3), 1, 10);
    if (departmentSpacing !== 3) params.set("spacing", String(departmentSpacing));
    const schoolSpacing = clamp(integer(state.schoolSpacing, defaults.schoolSpacing), 0, 10);
    if (schoolSpacing !== defaults.schoolSpacing && graph.schools.length > 1) {
      params.set("school_spacing", String(schoolSpacing));
    }
    const selectedIds = validFacultyIds(state.selectedIds || [], graph);
    if (selectedIds.length) {
      params.set("faculty", selectedIds.join(","));
    }
    const value = params.toString();
    return value ? `?${value}` : "";
  }

  function includesYear(work, state, graph) {
    if (work.year === null) {
      return (
        state.fromYear === graph.years.minimum && state.toYear === graph.years.maximum
      );
    }
    return work.year >= state.fromYear && work.year <= state.toYear;
  }

  function nodeMatchesDepartments(node, selectedDepartments) {
    if (!selectedDepartments.size) return true;
    return node.departments.some((id) => selectedDepartments.has(id));
  }

  function filterGraph(graph, state) {
    state = normalizeView(state, graph);
    const selectedDepartments = new Set(state.departments || []);
    const selectedSchools = new Set(state.schools || []);
    const departmentCandidateIds = new Set(
      graph.nodes
        .filter((node) => nodeMatchesDepartments(node, selectedDepartments))
        .map((node) => node.id),
    );
    const schoolCandidateIds = new Set(
      graph.nodes
        .filter((node) => !selectedSchools.size || node.school_ids.some((id) => selectedSchools.has(id)))
        .map((node) => node.id),
    );
    const filteredEdges = [];
    const visibleIds = new Set();
    const hiddenExternalIds = new Set();
    const visibleWorkIds = new Set();
    const metrics = new Map(
      graph.nodes.map((node) => [node.id, { degree: 0, strength: 0 }]),
    );

    for (const edge of graph.edges) {
      if (selectedDepartments.size) {
        const source = graph.nodeById.get(edge.source);
        const target = graph.nodeById.get(edge.target);
        const sourceMatches = departmentCandidateIds.has(edge.source);
        const targetMatches = departmentCandidateIds.has(edge.target);
        if (source.kind === "external_coauthor" ? !targetMatches
          : target.kind === "external_coauthor" ? !sourceMatches
            : !sourceMatches || !targetMatches) continue;
      }
      if (selectedSchools.size) {
        const sourceMatches = schoolCandidateIds.has(edge.source);
        const targetMatches = schoolCandidateIds.has(edge.target);
        const external = graph.nodeById.get(edge.source).kind === "external_coauthor"
          || graph.nodeById.get(edge.target).kind === "external_coauthor";
        if (external ? !sourceMatches && !targetMatches : !sourceMatches || !targetMatches) continue;
      }
      if (state.crossDepartment && !edge.cross_department) continue;
      if (state.crossSchool && !edge.cross_school) continue;
      const works = edge.works.filter((work) => includesYear(work, state, graph));
      if (works.length < state.minimum) continue;
      const source = graph.nodeById.get(edge.source);
      const target = graph.nodeById.get(edge.target);
      if (!state.showExternal && (source.kind === "external_coauthor" || target.kind === "external_coauthor")) {
        if (source.kind !== "external_coauthor") {
          visibleIds.add(source.id);
          hiddenExternalIds.add(source.id);
        }
        if (target.kind !== "external_coauthor") {
          visibleIds.add(target.id);
          hiddenExternalIds.add(target.id);
        }
        continue;
      }
      filteredEdges.push({ ...edge, count: works.length, works });
      visibleIds.add(edge.source);
      visibleIds.add(edge.target);
      works.forEach((work) => visibleWorkIds.add(work.id));
      for (const nodeId of [edge.source, edge.target]) {
        const metric = metrics.get(nodeId);
        metric.degree += 1;
        metric.strength += works.length;
      }
    }

    if (state.showUnconnected) {
      departmentCandidateIds.forEach((id) => {
        if (schoolCandidateIds.has(id)
          && (state.showExternal || graph.nodeById.get(id).kind !== "external_coauthor")) visibleIds.add(id);
      });
    }
    validFacultyIds(state.selectedIds || [], graph).forEach((id) => {
      const node = graph.nodeById.get(id);
      if (hasSchoolFocus(state) && node.kind === "external_coauthor" && !visibleIds.has(id)) return;
      if (state.showExternal || node.kind !== "external_coauthor") visibleIds.add(id);
    });

    const nodes = graph.nodes
      .filter((node) => visibleIds.has(node.id))
      .map((node) => ({
        ...node,
        ...metrics.get(node.id),
        hidden_external_connection: hiddenExternalIds.has(node.id),
      }));
    filteredEdges.sort(
      (left, right) =>
        right.count - left.count ||
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target),
    );

    return {
      nodes,
      edges: filteredEdges,
      nodeIds: visibleIds,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
      edgeById: new Map(filteredEdges.map((edge) => [edge.id, edge])),
      visibleWorkCount: visibleWorkIds.size,
      maximumEdgeCount: Math.max(1, ...filteredEdges.map((edge) => edge.count)),
    };
  }

  function facultyMatches(graph, query, limit = 10, excludedIds = []) {
    const normalized = String(query || "").trim().toLocaleLowerCase();
    if (!normalized) return [];
    const terms = normalized.split(/\s+/).filter(Boolean);
    const excluded = new Set(validFacultyIds(excludedIds, graph));
    return graph.nodes
      .map((node) => {
        if (excluded.has(node.id)) return null;
        const departmentText = node.departments
          .map((id) => graph.departmentById.get(id)?.title || id)
          .join(" ")
          .toLocaleLowerCase();
        const name = node.name.toLocaleLowerCase();
        if (!terms.every((term) => name.includes(term) || departmentText.includes(term))) {
          return null;
        }
        const score = name.startsWith(normalized)
          ? 0
          : name.split(/\s+/).some((part) => part.startsWith(normalized))
            ? 1
            : name.includes(normalized)
              ? 2
              : 3;
        return { node, score };
      })
      .filter(Boolean)
      .sort((left, right) => left.score - right.score || left.node.name.localeCompare(right.node.name))
      .slice(0, limit)
      .map(({ node }) => node);
  }

  function facultyLabelEligible(node, selectedDepartmentIds = []) {
    if (node?.kind === "external_coauthor") return true;
    const selectedDepartments = new Set(uniqueStrings(selectedDepartmentIds));
    const primaryGroup = String(node?.primary_home_group || node?.primary_department || "").trim();
    if (!selectedDepartments.size) return Boolean(primaryGroup);
    if (selectedDepartments.has(primaryGroup)) return true;
    return ["school", "academic_area"].includes(node?.primary_academic_home_type)
      && uniqueStrings(node?.departments).some((id) => selectedDepartments.has(id));
  }

  function departmentLabelEligible(departmentId, selectedDepartmentIds = []) {
    const selectedDepartments = new Set(uniqueStrings(selectedDepartmentIds));
    return (
      !selectedDepartments.size ||
      selectedDepartments.has(String(departmentId || "").trim())
    );
  }

  function layoutDepartmentId(node, selectedDepartmentIds = [], graph = null, selectedSchoolIds = []) {
    if (node?.kind === "external_coauthor") return layoutGroup(node);
    const primaryGroup = String(node?.primary_home_group || node?.primary_department || "").trim();
    if (!primaryGroup) return UNRESOLVED_LAYOUT_GROUP;
    const departments = uniqueStrings(node?.departments);
    const selectedSchools = new Set(selectedSchoolIds);
    const inSelectedSchools = selectedSchools.size && graph
      ? departments.filter((id) => selectedSchools.has(graph.departmentById.get(id)?.school_id))
      : departments;
    const choices = inSelectedSchools.length ? inSelectedSchools : departments;
    const selectedDepartments = new Set(uniqueStrings(selectedDepartmentIds));
    const primarySchool = node.primary_academic_home_school_id || node.primary_school;
    if ((!selectedSchools.size || selectedSchools.has(primarySchool))
      && (!selectedDepartments.size || selectedDepartments.has(primaryGroup)
        || (node.primary_academic_home_type === "school" || node.primary_academic_home_type === "academic_area")
          && choices.some((id) => selectedDepartments.has(id)
            && graph?.departmentById.get(id)?.school_id === primarySchool))) {
      return primaryGroup;
    }
    return (
      choices.find((departmentId) => selectedDepartments.has(departmentId)
        && graph?.departmentById.get(departmentId)?.unit_type !== "roster_container") ||
      choices.find((departmentId) => graph?.departmentById.get(departmentId)?.unit_type !== "roster_container") ||
      (selectedSchools.size && choices.length === 1
        ? academicHomeGroup("school", graph?.departmentById.get(choices[0])?.school_id || "") : "") ||
      primaryGroup
    );
  }

  function forceDepartmentAssignments(
    filtered, graph, _schoolSpacing = 0, selectedDepartmentIds = [], selectedSchoolIds = [],
  ) {
    return new Map(filtered.nodes.map((node) => [
      node.id,
      layoutDepartmentId(node, selectedDepartmentIds, graph, selectedSchoolIds),
    ]));
  }

  function connectionsForNode(filtered, nodeId) {
    return filtered.edges
      .filter((edge) => edge.source === nodeId || edge.target === nodeId)
      .map((edge) => ({
        ...edge,
        collaboratorId: edge.source === nodeId ? edge.target : edge.source,
      }))
      .sort(
        (left, right) =>
          right.count - left.count || left.collaboratorId.localeCompare(right.collaboratorId),
      );
  }

  function subgraphForSelection(filtered, nodeIds) {
    const selectedIds = uniqueStrings(Array.isArray(nodeIds) ? nodeIds : [nodeIds])
      .filter(Boolean)
      .filter((id) => filtered.nodeById.has(id));
    const selected = new Set(selectedIds);
    const edges = filtered.edges.filter(
      (edge) => selected.has(edge.source) || selected.has(edge.target),
    );
    const includedIds = new Set(selectedIds);
    const visibleWorkIds = new Set();
    edges.forEach((edge) => {
      includedIds.add(edge.source);
      includedIds.add(edge.target);
      edge.works.forEach((work) => visibleWorkIds.add(work.id));
    });
    const nodes = filtered.nodes.filter((node) => includedIds.has(node.id));
    return {
      selectedIds,
      selectedIdSet: selected,
      nodes,
      edges,
      nodeIds: includedIds,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
      edgeById: new Map(edges.map((edge) => [edge.id, edge])),
      visibleWorkCount: visibleWorkIds.size,
      maximumEdgeCount: Math.max(1, ...edges.map((edge) => edge.count)),
    };
  }

  function layoutHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  function departmentSeparation(level) {
    return [0, 1, 2, 3, 6, 12, 20, 30, 43, 59, 78][clamp(integer(level, 3), 0, 10)];
  }

  function layoutSeed(nodes, variant) {
    const positions = new Map();
    if (variant !== "source") {
      const seedNumber = Number(String(variant).replace("radial-", "")) || 0;
      const ordered = [...nodes].sort((left, right) => {
        if (seedNumber === 0) {
          return (
            right.degree - left.degree ||
            right.strength - left.strength ||
            left.id.localeCompare(right.id)
          );
        }
        return (
          layoutHash(`${seedNumber}|${left.id}`) - layoutHash(`${seedNumber}|${right.id}`) ||
          left.id.localeCompare(right.id)
        );
      });
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      ordered.forEach((node, index) => {
        const radius = Math.sqrt((index + 0.35) / Math.max(1, ordered.length));
        const angle =
          index * goldenAngle + layoutHash(`${seedNumber + 17}|${node.id}`) * 0.08;
        positions.set(node.id, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      });
      return positions;
    }

    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxY = Math.max(...nodes.map((node) => node.y));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const span = Math.max(0.01, maxX - minX, maxY - minY);
    nodes.forEach((node) => {
      const angle = layoutHash(node.id) * Math.PI * 2;
      positions.set(node.id, {
        x: ((node.x - centerX) / span) * 1.7 + Math.cos(angle) * 0.006,
        y: ((node.y - centerY) / span) * 1.7 + Math.sin(angle) * 0.006,
      });
    });
    return positions;
  }

  function simulateLayout(
    filtered,
    seed,
    {
      departmentSpacing = 0,
      schoolSpacing = 0,
      departmentAnchors = new Map(),
      departmentByNode = new Map(),
      schoolByNode = new Map(),
    } = {},
  ) {
    const nodes = filtered.nodes;
    const departmental = departmentSpacing > 0;
    const openness = departmentSeparation(departmentSpacing);
    const schoolOpenness = departmentSeparation(schoolSpacing);
    const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
    const nodeDepartments = nodes.map(
      (node) => departmentByNode.get(node.id) || node.primary_home_group || node.primary_department,
    );
    const crossSchoolPairs = schoolOpenness > 0
      ? new Uint8Array(nodes.length * nodes.length)
      : null;
    if (crossSchoolPairs) {
      const layoutSchools = nodes.map((node) => schoolByNode.get(node.id) || "");
      for (let left = 0; left < nodes.length; left += 1) {
        if (!layoutSchools[left]) continue;
        for (let right = left + 1; right < nodes.length; right += 1) {
          if (!layoutSchools[right] || layoutSchools[left] === layoutSchools[right]) continue;
          crossSchoolPairs[left * nodes.length + right] = 1;
          crossSchoolPairs[right * nodes.length + left] = 1;
        }
      }
    }
    const x = nodes.map((node) => seed.get(node.id).x);
    const y = nodes.map((node) => seed.get(node.id).y);
    const dx = new Float64Array(nodes.length);
    const dy = new Float64Array(nodes.length);
    const edgePairs = filtered.edges
      .map((edge) => {
        const source = nodeIndex.get(edge.source);
        const target = nodeIndex.get(edge.target);
        return {
          source,
          target,
          weight: 0.82 + Math.log1p(edge.count || 1) * 0.16,
          crossDepartment:
            departmental && source !== undefined && target !== undefined
              ? nodeDepartments[source] !== nodeDepartments[target]
              : Boolean(edge.cross_department),
          crossSchool: Boolean(crossSchoolPairs?.[source * nodes.length + target]),
        };
      })
      .filter((edge) => edge.source !== undefined && edge.target !== undefined);
    const spacing = Math.max(0.12, 2.25 / Math.sqrt(Math.max(1, nodes.length)));
    const baseIterations = nodes.length <= 55 ? 220 : nodes.length <= 140 ? 165 : 115;
    const iterations = baseIterations + (departmental ? 45 : 0);

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      dx.fill(0);
      dy.fill(0);

      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          let deltaX = x[left] - x[right];
          let deltaY = y[left] - y[right];
          let distance = Math.hypot(deltaX, deltaY);
          if (distance < 0.0001) {
            const angle = layoutHash(`${nodes[left].id}|${nodes[right].id}`) * Math.PI * 2;
            deltaX = Math.cos(angle) * 0.0001;
            deltaY = Math.sin(angle) * 0.0001;
            distance = 0.0001;
          }
          const differentDepartments = nodeDepartments[left] !== nodeDepartments[right];
          const repulsionMultiplier = 1
            + (departmental && differentDepartments ? openness * 0.22 : 0)
            + (crossSchoolPairs?.[left * nodes.length + right] ? schoolOpenness * 0.22 : 0);
          const force = ((spacing * spacing) / distance) * repulsionMultiplier;
          const forceX = (deltaX / distance) * force;
          const forceY = (deltaY / distance) * force;
          dx[left] += forceX;
          dy[left] += forceY;
          dx[right] -= forceX;
          dy[right] -= forceY;
        }
      }

      for (const edge of edgePairs) {
        const deltaX = x[edge.source] - x[edge.target];
        const deltaY = y[edge.source] - y[edge.target];
        const distance = Math.max(0.0001, Math.hypot(deltaX, deltaY));
        const targetDistance = (edge.crossDepartment
          ? spacing * (2.2 + openness * 0.9)
          : spacing * 0.9)
          + (edge.crossSchool ? spacing * schoolOpenness * 0.9 : 0);
        const force = departmental
          ? (distance - targetDistance) * edge.weight * (edge.crossDepartment ? 0.22 : 0.34)
          : ((distance * distance) / spacing) * edge.weight;
        const forceX = (deltaX / distance) * force;
        const forceY = (deltaY / distance) * force;
        dx[edge.source] -= forceX;
        dy[edge.source] -= forceY;
        dx[edge.target] += forceX;
        dy[edge.target] += forceY;
      }

      const progress = iteration / Math.max(1, iterations - 1);
      const temperature =
        (departmental ? 0.2 : 0.17) * Math.pow(1 - progress, 1.55) + 0.002;
      for (let index = 0; index < nodes.length; index += 1) {
        if (departmental) {
          const anchor = departmentAnchors.get(nodeDepartments[index]);
          if (anchor) {
            const anchorStrength = 0.3 + openness * 0.035;
            dx[index] += (anchor.x - x[index]) * anchorStrength;
            dy[index] += (anchor.y - y[index]) * anchorStrength;
          }
          dx[index] -= x[index] * 0.025;
          dy[index] -= y[index] * 0.025;
        } else {
          dx[index] -= x[index] * 0.12;
          dy[index] -= y[index] * 0.12;
        }
        const displacement = Math.max(0.0001, Math.hypot(dx[index], dy[index]));
        x[index] += (dx[index] / displacement) * Math.min(displacement, temperature);
        y[index] += (dy[index] / displacement) * Math.min(displacement, temperature);
      }
    }

    const positions = new Map();
    const centerX = x.reduce((sum, value) => sum + value, 0) / Math.max(1, x.length);
    const centerY = y.reduce((sum, value) => sum + value, 0) / Math.max(1, y.length);
    nodes.forEach((node, index) => {
      positions.set(node.id, { x: x[index] - centerX, y: y[index] - centerY });
    });
    return positions;
  }

  function edgeCrossingCount(edges, positions) {
    const orientation = (a, b, c) =>
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    let count = 0;
    for (let left = 0; left < edges.length; left += 1) {
      const first = edges[left];
      const firstSource = positions.get(first.source);
      const firstTarget = positions.get(first.target);
      if (!firstSource || !firstTarget) continue;
      for (let right = left + 1; right < edges.length; right += 1) {
        const second = edges[right];
        if (
          first.source === second.source ||
          first.source === second.target ||
          first.target === second.source ||
          first.target === second.target
        ) {
          continue;
        }
        const secondSource = positions.get(second.source);
        const secondTarget = positions.get(second.target);
        if (!secondSource || !secondTarget) continue;
        const one = orientation(firstSource, firstTarget, secondSource);
        const two = orientation(firstSource, firstTarget, secondTarget);
        const three = orientation(secondSource, secondTarget, firstSource);
        const four = orientation(secondSource, secondTarget, firstTarget);
        if (one * two < -1e-10 && three * four < -1e-10) count += 1;
      }
    }
    return count;
  }

  function collaborationLayout(filtered) {
    if (!filtered?.nodes?.length) return new Map();
    if (filtered.nodes.length === 1) {
      return new Map([[filtered.nodes[0].id, { x: 0, y: 0 }]]);
    }

    const variants =
      filtered.nodes.length <= 90
        ? ["radial-0", "radial-1", "radial-2", "radial-3", "radial-4", "radial-5", "source"]
        : ["radial-0"];
    const candidates = variants
      .map((variant) => {
        const positions = simulateLayout(filtered, layoutSeed(filtered.nodes, variant));
        return {
          positions,
          crossings: edgeCrossingCount(filtered.edges, positions),
        };
      })
      .sort((left, right) => left.crossings - right.crossings);
    return candidates[0].positions;
  }

  function departmentGridLayout(
    filtered,
    graph,
    selectedDepartmentIds = [],
    selectedSchoolIds = [],
    assignedDepartments = null,
  ) {
    if (!filtered?.nodes?.length) return new Map();

    const departmentByNode = new Map(
      assignedDepartments || filtered.nodes.map((node) => [
        node.id, layoutDepartmentId(node, selectedDepartmentIds, graph, selectedSchoolIds),
      ]),
    );
    const groups = new Map();
    for (const node of filtered.nodes) {
      const departmentId = departmentByNode.get(node.id);
      if (!groups.has(departmentId)) groups.set(departmentId, []);
      groups.get(departmentId).push(node);
    }
    const activeDepartmentIds = [
      ...graph.academic_homes
        .map((home) => home.home_group)
        .filter((id) => groups.has(id)),
      ...[...groups.keys()]
        .filter((id) => !graph.academicHomeByGroup.has(id))
        .sort((left, right) => left.localeCompare(right)),
    ];
    const departmentRank = new Map(activeDepartmentIds.map((id, index) => [id, index]));
    const crossStrengthByNode = new Map(filtered.nodes.map((node) => [node.id, 0]));
    const crossStrengthByDepartment = new Map(activeDepartmentIds.map((id) => [id, 0]));
    const adjacency = new Map(activeDepartmentIds.map((id) => [id, new Map()]));

    for (const edge of filtered.edges) {
      const source = filtered.nodeById.get(edge.source);
      const target = filtered.nodeById.get(edge.target);
      if (!source || !target) continue;
      const sourceDepartment = departmentByNode.get(source.id);
      const targetDepartment = departmentByNode.get(target.id);
      if (sourceDepartment === targetDepartment) continue;
      const weight = Math.max(1, edge.count || 1);
      crossStrengthByNode.set(source.id, crossStrengthByNode.get(source.id) + weight);
      crossStrengthByNode.set(target.id, crossStrengthByNode.get(target.id) + weight);
      for (const [left, right] of [
        [sourceDepartment, targetDepartment],
        [targetDepartment, sourceDepartment],
      ]) {
        crossStrengthByDepartment.set(left, crossStrengthByDepartment.get(left) + weight);
        adjacency.get(left).set(right, (adjacency.get(left).get(right) || 0) + weight);
      }
    }

    const compareDepartments = (left, right, anchor = "") =>
      (adjacency.get(anchor)?.get(right) || 0) - (adjacency.get(anchor)?.get(left) || 0) ||
      crossStrengthByDepartment.get(right) - crossStrengthByDepartment.get(left) ||
      departmentRank.get(left) - departmentRank.get(right) ||
      left.localeCompare(right);
    const remaining = new Set(activeDepartmentIds);
    const orderedDepartmentIds = [];
    let current = [...remaining].sort((left, right) => compareDepartments(left, right))[0];
    while (current) {
      orderedDepartmentIds.push(current);
      remaining.delete(current);
      current = [...remaining].sort((left, right) => compareDepartments(left, right, current))[0];
    }

    const positions = new Map();
    const departmentCount = orderedDepartmentIds.length;
    orderedDepartmentIds.forEach((departmentId, departmentIndex) => {
      const angle =
        departmentCount === 1
          ? -Math.PI / 2
          : departmentCount === 2
            ? departmentIndex === 0
              ? Math.PI
              : 0
            : -Math.PI / 2 + (departmentIndex / departmentCount) * Math.PI * 2;
      const center =
        departmentCount === 1
          ? { x: 0, y: 0 }
          : { x: Math.cos(angle) * 1.3, y: Math.sin(angle) * 0.98 };
      const inward = { x: -Math.cos(angle), y: -Math.sin(angle) };
      const tangent = { x: -inward.y, y: inward.x };
      const nodes = [...groups.get(departmentId)].sort(
        (left, right) =>
          crossStrengthByNode.get(right.id) - crossStrengthByNode.get(left.id) ||
          right.strength - left.strength ||
          right.degree - left.degree ||
          left.id.localeCompare(right.id),
      );
      const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
      const rows = Math.max(1, Math.ceil(nodes.length / columns));
      const spacing = Math.min(0.075, 0.42 / Math.max(1, columns - 1, rows - 1));

      nodes.forEach((node, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const itemsInRow = Math.min(columns, nodes.length - row * columns);
        const inwardOffset = ((rows - 1) / 2 - row) * spacing;
        const tangentOffset = (column - (itemsInRow - 1) / 2) * spacing;
        positions.set(node.id, {
          x: center.x + inward.x * inwardOffset + tangent.x * tangentOffset,
          y: center.y + inward.y * inwardOffset + tangent.y * tangentOffset,
        });
      });
    });
    return positions;
  }

  function departmentForceLayout(
    filtered,
    graph,
    requestedSpacing = 3,
    selectedDepartmentIds = [],
    requestedSchoolSpacing = 0,
    selectedSchoolIds = [],
  ) {
    if (!filtered?.nodes?.length) return new Map();
    if (filtered.nodes.length === 1) {
      return new Map([[filtered.nodes[0].id, { x: 0, y: 0 }]]);
    }

    const spacingLevel = clamp(integer(requestedSpacing, 3), 1, 10);
    const schoolSpacingLevel = clamp(integer(requestedSchoolSpacing, 0), 0, 10);
    const openness = departmentSeparation(spacingLevel);
    const departmentByNode = forceDepartmentAssignments(
      filtered, graph, schoolSpacingLevel, selectedDepartmentIds, selectedSchoolIds,
    );
    const gridSeed = departmentGridLayout(
      filtered, graph, selectedDepartmentIds, selectedSchoolIds, departmentByNode,
    );
    const schoolByNode = new Map(
      filtered.nodes.map((node) => [
        node.id, graph.academicHomeByGroup.get(departmentByNode.get(node.id))?.school_id
          || graph.departmentById.get(departmentByNode.get(node.id))?.school_id || "",
      ]),
    );
    const nodesByDepartment = new Map();
    for (const node of filtered.nodes) {
      const departmentId = departmentByNode.get(node.id);
      if (!nodesByDepartment.has(departmentId)) {
        nodesByDepartment.set(departmentId, []);
      }
      nodesByDepartment.get(departmentId).push(node);
    }

    const gridCenters = new Map();
    for (const [departmentId, nodes] of nodesByDepartment) {
      const points = nodes.map((node) => gridSeed.get(node.id));
      gridCenters.set(departmentId, {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      });
    }

    const anchorScale = nodesByDepartment.size === 1
      ? 0
      : Math.max(1.45, 0.55 + openness * 0.18);
    const activeSchools = graph.schools
      .map((school) => school.school_id)
      .filter((schoolId) => [...schoolByNode.values()].includes(schoolId));
    const schoolRadius = activeSchools.length > 1
      ? Math.sqrt(departmentSeparation(schoolSpacingLevel)) * 1.1
      : 0;
    const schoolAnchors = new Map(activeSchools.map((schoolId, index) => {
      const angle = -Math.PI / 2 + (index / activeSchools.length) * Math.PI * 2;
      return [schoolId, {
        x: Math.cos(angle) * schoolRadius,
        y: Math.sin(angle) * schoolRadius,
      }];
    }));
    const departmentAnchors = new Map(
      [...gridCenters].map(([departmentId, center]) => {
        const schoolId = graph.academicHomeByGroup.get(departmentId)?.school_id
          || graph.departmentById.get(departmentId)?.school_id;
        const schoolAnchor = schoolAnchors.get(schoolId) || { x: 0, y: 0 };
        return [departmentId, {
          x: schoolAnchor.x + center.x * anchorScale,
          y: schoolAnchor.y + center.y * anchorScale,
        }];
      }),
    );
    const seed = new Map();
    for (const node of filtered.nodes) {
      const departmentId = departmentByNode.get(node.id);
      const point = gridSeed.get(node.id);
      const center = gridCenters.get(departmentId);
      const anchor = departmentAnchors.get(departmentId);
      const angle = layoutHash(`department-force|${node.id}`) * Math.PI * 2;
      const jitter = 0.01 + layoutHash(`department-jitter|${node.id}`) * 0.014;
      seed.set(node.id, {
        x: anchor.x + (point.x - center.x) * 0.9 + Math.cos(angle) * jitter,
        y: anchor.y + (point.y - center.y) * 0.9 + Math.sin(angle) * jitter,
      });
    }

    return simulateLayout(filtered, seed, {
      departmentSpacing: spacingLevel,
      schoolSpacing: schoolSpacingLevel,
      departmentAnchors,
      departmentByNode,
      schoolByNode,
    });
  }

  function selectionLayout(filtered, nodeIds) {
    const selection = subgraphForSelection(filtered, nodeIds);
    if (selection.selectedIds.length > 1) return collaborationLayout(selection);
    const nodeId = selection.selectedIds[0];
    const selected = filtered.nodeById.get(nodeId);
    if (!selected) return new Map();

    const connections = connectionsForNode(filtered, nodeId);
    const positions = new Map([[nodeId, { x: selected.x, y: selected.y }]]);
    if (!connections.length) return positions;

    const collaborators = connections
      .map((connection) => ({
        connection,
        node: filtered.nodeById.get(connection.collaboratorId),
      }))
      .filter(({ node }) => node);
    const byOriginalAngle = (left, right) => {
      const leftAngle = Math.atan2(left.node.y - selected.y, left.node.x - selected.x);
      const rightAngle = Math.atan2(right.node.y - selected.y, right.node.x - selected.x);
      return leftAngle - rightAngle || left.node.id.localeCompare(right.node.id);
    };
    const placeRing = (items, radius, rotation = -Math.PI / 2) => {
      const ordered = [...items].sort(byOriginalAngle);
      const step = (Math.PI * 2) / Math.max(1, ordered.length);
      ordered.forEach(({ node }, index) => {
        const angle = rotation + step * index;
        positions.set(node.id, {
          x: selected.x + Math.cos(angle) * radius,
          y: selected.y + Math.sin(angle) * radius,
        });
      });
    };

    if (collaborators.length <= 10) {
      placeRing(collaborators, 0.22 + Math.min(0.2, collaborators.length * 0.02));
      return positions;
    }

    const innerCount = Math.min(7, Math.ceil(collaborators.length * 0.4));
    const strongestIds = new Set(
      [...collaborators]
        .sort(
          (left, right) =>
            right.connection.count - left.connection.count ||
            left.node.id.localeCompare(right.node.id),
        )
        .slice(0, innerCount)
        .map(({ node }) => node.id),
    );
    const inner = collaborators.filter(({ node }) => strongestIds.has(node.id));
    const outer = collaborators.filter(({ node }) => !strongestIds.has(node.id));
    placeRing(inner, 0.29);
    placeRing(outer, 0.52, -Math.PI / 2 + Math.PI / Math.max(1, outer.length));
    return positions;
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function edgesToCsv(graph, filtered) {
    const hasExternal = graph.nodes.some((node) => node.kind === "external_coauthor");
    const rows = [
      hasExternal ? [
        "person_1",
        "person_1_kind",
        "person_2",
        "person_2_kind",
        "shared_works",
        "earliest_year",
        "latest_year",
        "cross_department",
        "cross_school",
      ] : [
        "faculty_1",
        "faculty_2",
        "shared_works",
        "earliest_year",
        "latest_year",
        "cross_department",
        "cross_school",
      ],
    ];
    for (const edge of filtered.edges) {
      const years = edge.works.map((work) => work.year).filter(Number.isInteger);
      const values = [
        graph.nodeById.get(edge.source)?.name || edge.source,
        graph.nodeById.get(edge.target)?.name || edge.target,
        edge.count,
        years.length ? Math.min(...years) : "",
        years.length ? Math.max(...years) : "",
        edge.cross_department ? "yes" : "no",
        edge.cross_school ? "yes" : "no",
      ];
      if (hasExternal) {
        values.splice(1, 0, graph.nodeById.get(edge.source)?.kind || "faculty");
        values.splice(3, 0, graph.nodeById.get(edge.target)?.kind || "faculty");
      }
      rows.push(values);
    }
    return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  }

  return Object.freeze({
    GRAPH_SCHEMA_VERSION,
    UNRESOLVED_LAYOUT_GROUP,
    academicHomeDisplayText,
    collaborationLayout,
    connectionsForNode,
    defaultState,
    departmentForceLayout,
    departmentGridLayout,
    departmentLabelEligible,
    doiUrl,
    edgeKey,
    edgeCrossingCount,
    edgesToCsv,
    facultyLabelEligible,
    forceDepartmentAssignments,
    facultyMatches,
    filterGraph,
    schoolEligible,
    hasSchoolFocus,
    layoutDepartmentId,
    normalizeView,
    parseGraph,
    safeExternalUrl,
    scopeEligible,
    selectionLayout,
    stateFromSearch,
    stateToSearch,
    subgraphForSelection,
    validFacultyIds,
  });
});
