"use strict";

(() => {
  const core = globalThis.CollaborationCore;
  if (!core) return;

  const elements = {
    canvas: document.querySelector("#graph-canvas"),
    mapColumn: document.querySelector("#map-column"),
    loading: document.querySelector("#loading-state"),
    status: document.querySelector("#graph-status"),
    stats: document.querySelector("#graph-stats"),
    tooltip: document.querySelector("#graph-tooltip"),
    toast: document.querySelector("#toast"),
    filterPanel: document.querySelector("#filter-panel"),
    filterControls: document.querySelector("#filter-controls"),
    legendPanel: document.querySelector("#legend-panel"),
    detailPanel: document.querySelector("#detail-panel"),
    detailContent: document.querySelector("#detail-content"),
    detailEmpty: document.querySelector(".detail-empty"),
    schoolFieldset: document.querySelector("#school-fieldset"),
    schoolOptions: document.querySelector("#school-options"),
    departmentOptions: document.querySelector("#department-options"),
    departmentLegend: document.querySelector("#department-legend"),
    facultySearch: document.querySelector("#faculty-search"),
    facultySearchNote: document.querySelector("#faculty-search-note"),
    facultySuggestions: document.querySelector("#faculty-suggestions"),
    selectedFaculty: document.querySelector("#selected-faculty"),
    yearMin: document.querySelector("#year-min"),
    yearMax: document.querySelector("#year-max"),
    undatedNote: document.querySelector("#undated-note"),
    strength: document.querySelector("#strength-min"),
    strengthOutput: document.querySelector("#strength-output"),
    crossDepartment: document.querySelector("#cross-department"),
    crossSchoolRow: document.querySelector("#cross-school-row"),
    crossSchool: document.querySelector("#cross-school"),
    showUnconnected: document.querySelector("#show-unconnected"),
    showExternalRow: document.querySelector("#show-external-row"),
    showExternal: document.querySelector("#show-external"),
    layoutOptions: document.querySelector("#layout-options"),
    departmentSpacingControl: document.querySelector("#department-spacing-control"),
    departmentSpacing: document.querySelector("#department-spacing"),
    departmentSpacingOutput: document.querySelector("#department-spacing-output"),
    schoolSpacingControl: document.querySelector("#school-spacing-control"),
    schoolSpacing: document.querySelector("#school-spacing"),
    schoolSpacingOutput: document.querySelector("#school-spacing-output"),
    coverageNote: document.querySelector("#coverage-note"),
    retry: document.querySelector("#retry-load"),
    clear: document.querySelector("#clear-filters"),
    fit: document.querySelector("#fit-graph"),
    reset: document.querySelector("#reset-view"),
    copy: document.querySelector("#copy-view"),
    download: document.querySelector("#download-csv"),
    zoomIn: document.querySelector("#zoom-in"),
    zoomOut: document.querySelector("#zoom-out"),
    zoomFit: document.querySelector("#zoom-fit"),
    toggleFilters: document.querySelector("#toggle-filters"),
    toggleLegend: document.querySelector("#toggle-legend"),
    toggleDetails: document.querySelector("#toggle-details"),
  };

  const context = elements.canvas.getContext("2d", { alpha: false });
  const numberFormat = new Intl.NumberFormat("en-US");
  const state = {
    graph: null,
    filtered: null,
    view: null,
    transform: { k: 300, x: 0, y: 0 },
    width: 0,
    height: 0,
    dpr: 1,
    hoveredId: "",
    expandedEdgeId: "",
    activeSuggestion: -1,
    suggestionNodes: [],
    drag: null,
    layoutPositions: new Map(),
    layoutDepartments: new Map(),
    transition: null,
    renderQueued: false,
    toastTimer: 0,
  };

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function formatNumber(value) {
    return numberFormat.format(Number(value) || 0);
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? "an unknown date"
      : new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(date);
  }

  function plural(value, singular, pluralForm = `${singular}s`) {
    return `${formatNumber(value)} ${value === 1 ? singular : pluralForm}`;
  }

  function departmentSpacingLabel(value) {
    const level = Number(value);
    const labels = [
      "", "Close", "Compact", "Balanced", "Open", "Far",
      "Very far", "Wide", "Wider", "Farther", "Maximum",
    ];
    const label = labels[level];
    return `${label || "Balanced"} · ${level}/10`;
  }

  function schoolSpacingLabel(value) {
    const level = Number(value);
    return level === 0 ? "Neutral · 0/10" : `${level}/10`;
  }

  function isDepartmentLayout(layout = state.view?.layout) {
    return layout === "department-force" || layout === "departments";
  }

  function departmentColor(departmentId) {
    const department = state.graph?.departmentById.get(departmentId);
    if (!department) return css("--accent");
    return document.documentElement.dataset.resolvedTheme === "light"
      ? department.color_light
      : department.color_dark;
  }

  function academicHomeColor(homeGroup) {
    const home = state.graph?.academicHomeByGroup.get(homeGroup);
    if (!home) return css("--primary-unresolved");
    return document.documentElement.dataset.resolvedTheme === "light"
      ? home.color_light : home.color_dark;
  }

  function nodeColor(node) {
    return node?.kind === "external_coauthor"
      ? css("--warm")
      : node?.primary_home_group
        ? academicHomeColor(node.primary_home_group)
        : css("--primary-unresolved");
  }

  function nodeAffiliation(node) {
    return node.kind === "external_coauthor"
      ? "Historical coauthor outside CMU"
      : node.departments
          .map((id) => state.graph.departmentById.get(id)?.short_title || id)
          .join(" · ");
  }

  function hasExternalCoauthors() {
    return Boolean(state.graph?.nodes.some((node) => node.kind === "external_coauthor"));
  }

  async function fetchJson(url, label) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "default",
        });
        if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw lastError;
  }

  async function load() {
    setLoading(true);
    elements.retry.hidden = true;
    elements.status.className = "status";
    elements.status.textContent = "Loading the collaboration graph…";
    try {
      const config = await fetchJson("map-config.json", "Map configuration");
      if (!/^data\/collaborations\.[0-9a-f]{40}\.json$/.test(config.graph_artifact || "")) {
        throw new Error("Map configuration points to an invalid graph artifact");
      }
      const rawGraph = await fetchJson(config.graph_artifact, "Collaboration artifact");
      state.graph = core.parseGraph(rawGraph);
      state.view = core.stateFromSearch(window.location.search, state.graph);
      if (hasExternalCoauthors()) {
        document.querySelector('label[for="faculty-search"] span').textContent = "Add people";
        elements.selectedFaculty.setAttribute("aria-label", "Selected people");
        document.querySelector("#canvas-instructions").textContent =
          "Drag to pan, use the mouse wheel or zoom buttons to zoom, and select nodes to compare observed collaborators. Select a node again to remove it. Search to reach every person.";
        document.querySelector("#detail-panel").setAttribute("aria-label", "Selected person details");
        document.querySelector(".detail-empty .eyebrow").textContent = "Person details";
        document.querySelector(".detail-empty h2").textContent = "Select a person";
        document.querySelector(".detail-empty p:last-child").textContent =
          "Choose CMU faculty or verified external coauthors to inspect shared works.";
        document.querySelector(".department-fieldset .field-note").textContent =
          "Faculty pairs must both match; a verified outside coauthor stays visible when the CMU faculty endpoint matches.";
        document.querySelector("#cross-department + span small").textContent =
          "Show faculty pairs with different documented academic units";
        document.querySelector("#cross-school + span small").textContent =
          "Show CMU faculty pairs with no school in common";
        document.querySelector(".method-note").append(element(
          "p",
          "",
          "Only selected historical coauthors outside CMU are cataloged. They appear when a publication has an explicit, source-verified coauthor association; other outside collaborators are not indexed here. They do not count as CMU faculty or members of a school.",
        ));
      }
      elements.showExternalRow.hidden = !hasExternalCoauthors();
      if (state.graph.schools.length > 1 || hasExternalCoauthors()) {
        document.querySelector(".eyebrow").textContent = "Carnegie Mellon University";
        document.title = state.graph.title;
        document.querySelector('meta[name="description"]').content =
          hasExternalCoauthors()
            ? "Explore observed publication collaborations among cataloged CMU faculty and verified external coauthors."
            : "Explore observed publication collaborations among cataloged CMU faculty.";
        elements.canvas.setAttribute("aria-label", hasExternalCoauthors()
          ? "Interactive CMU faculty and external coauthor collaboration graph"
          : "Interactive CMU faculty collaboration graph");
      }
      const datasetLink = document.querySelector('.intro-links a[href*="huggingface.co/datasets/"]');
      if (datasetLink && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.dataset_id || "")) {
        datasetLink.href = `https://huggingface.co/datasets/${config.dataset_id}`;
        datasetLink.setAttribute("aria-label", "Open the publication dataset");
      }
      renderControls();
      syncControls();
      applyView({
        fit: true,
        updateUrl: core.hasSchoolFocus(state.view) || Boolean(state.view.departments.length),
      });
      const counts = state.graph.counts;
      elements.status.textContent = `${plural(counts.faculty_count, "faculty member")}${
        counts.external_coauthor_count
          ? ` · ${plural(counts.external_coauthor_count, "external coauthor")}`
          : ""
      } · ${plural(
        counts.edge_count,
        "observed connection",
      )} · latest Scholar refresh ${formatDate(state.graph.source.source_data_newest_at_utc)}`;
      elements.coverageNote.textContent = `${plural(
        counts.mapped_faculty_count,
        "faculty member",
      )} have mapped publications; ${plural(
        counts.unmapped_faculty_count,
        "cataloged faculty member",
      )} do not. ${state.graph.quality.coverage_note || ""}`;
      setLoading(false);
      if (state.view.selectedIds.length) focusSelection();
    } catch (error) {
      console.error(error);
      elements.status.className = "status error";
      elements.status.textContent = "The collaboration graph is unavailable right now.";
      elements.retry.hidden = false;
      setLoading(false, { failed: true });
    }
  }

  function setLoading(loading, { failed = false } = {}) {
    elements.loading.hidden = !loading;
    elements.mapColumn.setAttribute("aria-busy", String(loading));
    elements.filterPanel.setAttribute("aria-busy", String(loading));
    elements.filterControls.inert = loading || failed;
    for (const toggle of [elements.toggleFilters, elements.toggleLegend, elements.toggleDetails]) {
      toggle.disabled = loading || failed;
    }
  }

  function renderDepartmentControls() {
    const schoolFocused = core.hasSchoolFocus(state.view);
    const scopedFaculty = state.graph.nodes.filter((node) =>
      node.kind !== "external_coauthor" &&
      (!schoolFocused || core.schoolEligible(state.graph, node, state.view.schools)));
    const primaryGroups = new Set(scopedFaculty.map((node) => node.primary_home_group));
    elements.departmentOptions.replaceChildren();
    elements.departmentLegend.replaceChildren();
    updateLegendAffiliation();
    for (const department of state.graph.departments) {
      if (schoolFocused && !state.view.schools.includes(department.school_id)) continue;
      const label = element("label", "department-option");
      const input = element("input");
      input.type = "checkbox";
      input.value = department.department_id;
      input.name = "department";
      const content = element("span");
      content.style.setProperty("--dot", departmentColor(department.department_id));
      const dot = element("i");
      dot.setAttribute("aria-hidden", "true");
      content.append(dot, document.createTextNode(department.short_title));
      label.append(input, content);
      elements.departmentOptions.append(label);

    }
    for (const home of state.graph.academic_homes) {
      if (!primaryGroups.has(home.home_group)) continue;
      const otherSchool = schoolFocused && !state.view.schools.includes(home.school_id);
      const label = otherSchool
        ? `${home.short_title} · other school primary`
        : `${home.short_title}${home.home_type === "school" ? " · school-level" :
          home.home_type === "academic_area" ? " · academic area" : ""}`;
      const dot = element("span", "legend-dot");
      dot.style.setProperty("--dot", academicHomeColor(home.home_group));
      dot.setAttribute("aria-hidden", "true");
      if (otherSchool || ["school", "academic_area"].includes(home.home_type)) {
        const key = element("div", "affiliation-legend");
        key.append(dot, element("span", "", label));
        elements.departmentLegend.append(key);
        continue;
      }
      const legendButton = element("button");
      legendButton.type = "button";
      legendButton.dataset.departmentId = home.home_id;
      legendButton.title = `Filter to ${home.title}`;
      legendButton.append(dot, element("span", "", label));
      elements.departmentLegend.append(legendButton);
    }
    if (scopedFaculty.some((node) => !node.primary_home_group)) {
      const key = element("div", "affiliation-legend");
      const dot = element("span", "legend-dot");
      dot.style.setProperty("--dot", css("--primary-unresolved"));
      key.append(dot, element("span", "", "Primary unresolved"));
      elements.departmentLegend.append(key);
    }
  }

  function updateLegendAffiliation() {
    document.querySelector(".legend-heading h2").textContent = "Academic home color";
    document.querySelector(".legend-heading p").textContent = "Reviewed or inferred primary display home";
  }

  function renderExternalLegend() {
    elements.departmentLegend.querySelector(".external-legend")?.remove();
    if (state.view.showExternal && state.filtered?.nodes.some(
      (node) => node.kind === "external_coauthor")) {
      const key = element("div", "external-legend");
      const dot = element("span", "legend-dot");
      dot.style.setProperty("--dot", css("--warm"));
      key.append(dot, element("span", "", "Historical coauthor outside CMU"));
      elements.departmentLegend.append(key);
    }
  }

  function renderScopeCopy() {
    const schoolFocused = core.hasSchoolFocus(state.view);
    const departmentFocused = Boolean(state.view.departments.length);
    const scopeLabel = schoolFocused && departmentFocused
      ? "selected schools and units"
      : schoolFocused ? "selected schools" : "selected units";
    elements.facultySearchNote.textContent = schoolFocused || departmentFocused
      ? `Search faculty in the ${scopeLabel}, plus linked historical coauthors. Connected faculty appear by default.`
      : `Search all ${plural(
          state.graph.counts.faculty_count,
          "cataloged faculty member",
        )} across CMU schools and academic units, including people without mapped works. Connected faculty appear on the graph by default.`;
    document.querySelector("#canvas-instructions").textContent = schoolFocused || departmentFocused
      ? `Drag to pan, use the mouse wheel or zoom buttons to zoom, and select nodes to inspect shared works. Search faculty in the ${scopeLabel}.`
      : "Drag to pan, use the mouse wheel or zoom buttons to zoom, and select nodes to compare observed collaborators. Select a node again to remove it. Search to reach every person.";
  }

  function renderControls() {
    elements.schoolOptions.replaceChildren();
    elements.schoolFieldset.hidden = state.graph.schools.length <= 1;
    elements.crossSchoolRow.hidden = state.graph.schools.length <= 1;
    for (const school of state.graph.schools) {
      const label = element("label", "department-option");
      const input = element("input");
      input.type = "checkbox";
      input.value = school.school_id;
      input.name = "school";
      const content = element("span");
      content.style.setProperty("--dot", css("--accent-strong"));
      const dot = element("i");
      dot.setAttribute("aria-hidden", "true");
      content.append(dot, document.createTextNode(school.title));
      label.append(input, content);
      elements.schoolOptions.append(label);
    }
    renderDepartmentControls();
    renderScopeCopy();
    elements.yearMin.min = String(state.graph.years.minimum);
    elements.yearMin.max = String(state.graph.years.maximum);
    elements.yearMax.min = String(state.graph.years.minimum);
    elements.yearMax.max = String(state.graph.years.maximum);
    elements.undatedNote.textContent = `${formatNumber(
      state.graph.years.missing_count,
    )} undated works are included only in the all-years view.`;
  }

  function syncControls() {
    const view = state.view;
    const selectedSchools = new Set(view.schools);
    elements.schoolOptions.querySelectorAll("input").forEach((input) => {
      input.checked = selectedSchools.has(input.value);
    });
    const selectedDepartments = new Set(view.departments);
    elements.departmentOptions.querySelectorAll("input").forEach((input) => {
      input.checked = selectedDepartments.has(input.value);
    });
    elements.departmentLegend.querySelectorAll("button[data-department-id]").forEach((button) => {
      if (selectedDepartments.has(button.dataset.departmentId)) {
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }
    });
    elements.yearMin.value = String(view.fromYear);
    elements.yearMax.value = String(view.toYear);
    elements.strength.value = String(view.minimum);
    elements.strengthOutput.textContent = `${view.minimum}+ shared ${
      view.minimum === 1 ? "work" : "works"
    }`;
    elements.crossDepartment.checked = view.crossDepartment;
    elements.crossSchool.checked = view.crossSchool;
    elements.showUnconnected.checked = view.showUnconnected;
    elements.showExternal.checked = view.showExternal;
    elements.layoutOptions.querySelectorAll("input").forEach((input) => {
      input.checked = input.value === view.layout;
    });
    elements.departmentSpacing.value = String(view.departmentSpacing);
    elements.departmentSpacingOutput.textContent = departmentSpacingLabel(view.departmentSpacing);
    elements.departmentSpacing.setAttribute(
      "aria-valuetext", departmentSpacingLabel(view.departmentSpacing),
    );
    elements.departmentSpacingControl.hidden = view.layout !== "department-force";
    elements.schoolSpacing.value = String(view.schoolSpacing);
    elements.schoolSpacingOutput.textContent = schoolSpacingLabel(view.schoolSpacing);
    elements.schoolSpacing.setAttribute("aria-valuetext", schoolSpacingLabel(view.schoolSpacing));
    elements.schoolSpacingControl.hidden =
      view.layout !== "department-force" || state.graph.schools.length <= 1;
    renderSelectedFaculty();
  }

  function applyView({ fit = false, updateUrl = true, animate = false } = {}) {
    state.view = core.normalizeView(state.view, state.graph);
    state.filtered = core.filterGraph(state.graph, state.view);
    state.layoutDepartments = state.view.layout === "department-force"
      ? core.forceDepartmentAssignments(
          state.filtered, state.graph, state.view.schoolSpacing,
          state.view.departments, state.view.schools,
        )
      : new Map();
    updateLegendAffiliation();
    if (core.hasSchoolFocus(state.view) || state.view.departments.length) {
      state.view.selectedIds = state.view.selectedIds.filter((id) => state.filtered.nodeIds.has(id));
    }
    renderExternalLegend();
    renderSelectedFaculty();
    state.expandedEdgeId = state.filtered.edgeById.has(state.expandedEdgeId)
      ? state.expandedEdgeId
      : "";
    if (updateUrl) {
      const next = `${window.location.pathname}${core.stateToSearch(state.view, state.graph)}${
        window.location.hash
      }`;
      window.history.replaceState(null, "", next);
    }
    updateStats();
    renderDetails();
    if (fit) refitCurrent({ animate });
    requestRender();
  }

  function updateStats() {
    const filtered = state.filtered;
    if (!filtered) {
      elements.stats.textContent = "";
      return;
    }
    const suffix = [
      state.view.crossDepartment ? "cross-department" : "",
      state.view.crossSchool ? "cross-school" : "",
      state.view.layout === "department-force"
        ? "organic department clusters"
        : state.view.layout === "departments"
          ? "department grid"
          : "",
      state.view.selectedIds.length
        ? `${plural(state.view.selectedIds.length, hasExternalCoauthors() ? "person" : "faculty member")} selected`
        : "",
    ]
      .filter(Boolean)
      .map((value) => ` · ${value}`)
      .join("");
    const visibleFacultyCount = filtered.nodes.filter((node) => node.kind !== "external_coauthor").length;
    const visibleExternalCount = filtered.nodes.length - visibleFacultyCount;
    elements.stats.textContent = `${plural(visibleFacultyCount, "faculty member")}${
      visibleExternalCount ? ` + ${plural(visibleExternalCount, "external coauthor")}` : ""
    } · ${plural(
      filtered.edges.length,
      "connection",
    )} · ${plural(filtered.visibleWorkCount, "shared work")}${suffix}`;
  }

  function effectiveViewport() {
    const compact = window.matchMedia("(max-width: 820px)").matches;
    if (compact) {
      return { left: 28, right: state.width - 28, top: 76, bottom: state.height - 72 };
    }
    return {
      left: Math.min(338, state.width * 0.3),
      right: Math.max(state.width - 320, state.width * 0.7),
      top: 28,
      bottom: state.height - 70,
    };
  }

  function easeOutCubic(value) {
    return 1 - Math.pow(1 - value, 3);
  }

  function transitionProgress(now = performance.now()) {
    if (!state.transition) return 1;
    return Math.min(1, Math.max(0, (now - state.transition.startedAt) / state.transition.duration));
  }

  function displayPosition(node, now = performance.now()) {
    if (!state.transition) return state.layoutPositions.get(node.id) || node;
    const progress = easeOutCubic(transitionProgress(now));
    const from = state.transition.fromPositions.get(node.id) || node;
    const to = state.transition.toPositions.get(node.id) || node;
    return {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
  }

  function displayTransform(now = performance.now()) {
    if (!state.transition) return state.transform;
    const progress = easeOutCubic(transitionProgress(now));
    const from = state.transition.fromTransform;
    const to = state.transition.toTransform;
    return {
      k: from.k + (to.k - from.k) * progress,
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
  }

  function settleTransition(now = performance.now()) {
    if (!state.transition) return;
    state.layoutPositions = new Map(
      (state.filtered?.nodes || []).map((node) => [node.id, displayPosition(node, now)]),
    );
    state.transform = displayTransform(now);
    state.transition = null;
  }

  function beginTransition(toPositions, toTransform, { animate = true } = {}) {
    const now = performance.now();
    const fromPositions = new Map(
      (state.filtered?.nodes || []).map((node) => [node.id, displayPosition(node, now)]),
    );
    const fromTransform = displayTransform(now);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reducedMotion) {
      state.layoutPositions = toPositions;
      state.transform = toTransform;
      state.transition = null;
      requestRender();
      return;
    }
    state.transition = {
      fromPositions,
      toPositions,
      fromTransform,
      toTransform,
      startedAt: now,
      duration: 480,
    };
    requestRender();
  }

  function fittedTransform(nodes, { maximumScale = 720, positions = state.layoutPositions } = {}) {
    if (!nodes?.length || !state.width || !state.height) return null;
    const viewport = effectiveViewport();
    const coordinates = nodes.map((node) => positions.get(node.id) || node);
    const minX = Math.min(...coordinates.map((node) => node.x));
    const maxX = Math.max(...coordinates.map((node) => node.x));
    const minY = Math.min(...coordinates.map((node) => node.y));
    const maxY = Math.max(...coordinates.map((node) => node.y));
    const spanX = Math.max(0.18, maxX - minX);
    const spanY = Math.max(0.14, maxY - minY);
    const availableWidth = Math.max(120, viewport.right - viewport.left);
    const availableHeight = Math.max(120, viewport.bottom - viewport.top);
    const scale = Math.min(
      maximumScale,
      Math.max(1, Math.min(availableWidth / spanX, availableHeight / spanY) * 0.82),
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
      k: scale,
      x: viewport.left + availableWidth / 2 - centerX * scale,
      y: viewport.top + availableHeight / 2 - centerY * scale,
    };
  }

  function fitNodes(
    nodes,
    { maximumScale = 720, positions = state.layoutPositions, animate = false } = {},
  ) {
    const transform = fittedTransform(nodes, { maximumScale, positions });
    if (!transform) return;
    beginTransition(positions, transform, { animate });
  }

  function fitVisible({ animate = false } = {}) {
    fitNodes(state.filtered?.nodes || [], { animate });
  }

  function focusSelection({ animate = false } = {}) {
    const selectedIds = state.view.selectedIds;
    if (!selectedIds.length) return;
    const selection = core.subgraphForSelection(state.filtered, selectedIds);
    const positions =
      state.view.layout === "department-force"
        ? core.departmentForceLayout(
            selection,
            state.graph,
            state.view.departmentSpacing,
            state.view.departments,
            state.view.schoolSpacing,
            state.view.schools,
          )
        : state.view.layout === "departments"
          ? core.departmentGridLayout(
              selection, state.graph, state.view.departments, state.view.schools,
            )
          : core.selectionLayout(state.filtered, selectedIds);
    fitNodes(selection.nodes, {
      maximumScale: selection.edges.length ? 560 : 420,
      positions,
      animate,
    });
  }

  function spreadOverviewLayout(positions) {
    if (positions.size < 2) return positions;
    const coordinates = [...positions.values()];
    const minX = Math.min(...coordinates.map((point) => point.x));
    const maxX = Math.max(...coordinates.map((point) => point.x));
    const minY = Math.min(...coordinates.map((point) => point.y));
    const maxY = Math.max(...coordinates.map((point) => point.y));
    const graphAspect = Math.max(0.01, maxX - minX) / Math.max(0.01, maxY - minY);
    const viewport = effectiveViewport();
    const viewportAspect =
      Math.max(1, viewport.right - viewport.left) /
      Math.max(1, viewport.bottom - viewport.top);
    const horizontalStretch = Math.min(
      1.7,
      Math.max(1, (viewportAspect * 0.88) / graphAspect),
    );
    if (horizontalStretch === 1) return positions;
    const centerX = (minX + maxX) / 2;
    return new Map(
      [...positions].map(([id, point]) => [
        id,
        { x: centerX + (point.x - centerX) * horizontalStretch, y: point.y },
      ]),
    );
  }

  function refitCurrent({ animate = false } = {}) {
    if (state.view?.selectedIds.length) focusSelection({ animate });
    else {
      const positions =
        state.view.layout === "department-force"
          ? core.departmentForceLayout(
              state.filtered,
              state.graph,
              state.view.departmentSpacing,
              state.view.departments,
              state.view.schoolSpacing,
              state.view.schools,
            )
          : state.view.layout === "departments"
            ? core.departmentGridLayout(
                state.filtered, state.graph, state.view.departments, state.view.schools,
              )
            : spreadOverviewLayout(core.collaborationLayout(state.filtered));
      fitNodes(state.filtered?.nodes || [], {
        positions,
        animate,
      });
    }
  }

  function zoomAt(factor, x = state.width / 2, y = state.height / 2) {
    settleTransition();
    const oldScale = state.transform.k;
    const nextScale = Math.min(1400, Math.max(1, oldScale * factor));
    const actualFactor = nextScale / oldScale;
    state.transform.x = x - (x - state.transform.x) * actualFactor;
    state.transform.y = y - (y - state.transform.y) * actualFactor;
    state.transform.k = nextScale;
    requestRender();
  }

  function worldToScreen(node, now = performance.now(), transform = displayTransform(now)) {
    const position = displayPosition(node, now);
    return {
      x: transform.x + position.x * transform.k,
      y: transform.y + position.y * transform.k,
    };
  }

  function nodeRadius(node) {
    return Math.min(9, 3.1 + Math.sqrt(Math.max(0, node.strength || 0)) * 0.42);
  }

  function requestRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderGraph();
    });
  }

  function resizeCanvas() {
    const rect = elements.canvas.getBoundingClientRect();
    state.width = Math.max(1, rect.width);
    state.height = Math.max(1, rect.height);
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    elements.canvas.width = Math.round(state.width * state.dpr);
    elements.canvas.height = Math.round(state.height * state.dpr);
    context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    if (state.filtered) {
      settleTransition();
      refitCurrent();
    }
    else requestRender();
  }

  function drawGrid(transform) {
    context.fillStyle = css("--canvas");
    context.fillRect(0, 0, state.width, state.height);
    context.fillStyle = css("--canvas-grid");
    const spacing = Math.max(34, Math.min(58, transform.k / 5));
    const startX = ((transform.x % spacing) + spacing) % spacing;
    const startY = ((transform.y % spacing) + spacing) % spacing;
    for (let x = startX; x < state.width; x += spacing) {
      for (let y = startY; y < state.height; y += spacing) {
        context.beginPath();
        context.arc(x, y, 1, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function renderGraph() {
    const now = performance.now();
    if (state.transition && transitionProgress(now) >= 1) {
      state.layoutPositions = state.transition.toPositions;
      state.transform = state.transition.toTransform;
      state.transition = null;
    }
    const transform = displayTransform(now);
    drawGrid(transform);
    if (!state.filtered) return;
    const selectedIds = new Set(state.view.selectedIds);
    const emphasisIds = selectedIds.size
      ? selectedIds
      : new Set(state.hoveredId ? [state.hoveredId] : []);
    const neighborIds = new Set(emphasisIds);
    if (emphasisIds.size) {
      for (const edge of state.filtered.edges) {
        if (emphasisIds.has(edge.source)) neighborIds.add(edge.target);
        if (emphasisIds.has(edge.target)) neighborIds.add(edge.source);
      }
    }
    context.lineCap = "round";
    for (const edge of [...state.filtered.edges].reverse()) {
      const source = state.filtered.nodeById.get(edge.source);
      const target = state.filtered.nodeById.get(edge.target);
      if (!source || !target) continue;
      const sourcePoint = worldToScreen(source, now, transform);
      const targetPoint = worldToScreen(target, now, transform);
      const highlighted =
        !emphasisIds.size || emphasisIds.has(edge.source) || emphasisIds.has(edge.target);
      const ratio = Math.log1p(edge.count) / Math.log1p(state.filtered.maximumEdgeCount);
      context.globalAlpha = emphasisIds.size ? (highlighted ? 0.9 : 0.075) : 0.35 + ratio * 0.28;
      context.strokeStyle =
        highlighted && emphasisIds.size ? css("--accent") : css("--canvas-edge-strong");
      context.lineWidth = 0.65 + Math.pow(ratio, 1.65) * 7;
      context.beginPath();
      context.moveTo(sourcePoint.x, sourcePoint.y);
      context.lineTo(targetPoint.x, targetPoint.y);
      context.stroke();
    }

    const ranked = [...state.filtered.nodes]
      .filter((node) => node.degree > 0 || node.hidden_external_connection)
      .sort((left, right) => right.strength - left.strength || right.degree - left.degree);
    let labelIds;
    if (selectedIds.size) {
      const compact = window.matchMedia("(max-width: 820px)").matches;
      const selection = core.subgraphForSelection(state.filtered, [...selectedIds]);
      const neighborLimit = Math.max(0, (compact ? 8 : 20) - selectedIds.size);
      const neighbors = selection.nodes
        .filter((node) => !selectedIds.has(node.id))
        .filter((node) => core.facultyLabelEligible(node, state.view.departments))
        .sort((left, right) => right.strength - left.strength || right.degree - left.degree)
        .slice(0, neighborLimit)
        .map((node) => node.id);
      labelIds = new Set([...selectedIds, ...neighbors]);
    } else {
      const viewport = effectiveViewport();
      const viewportArea =
        Math.max(1, viewport.right - viewport.left) *
        Math.max(1, viewport.bottom - viewport.top);
      const labelLimit = Math.max(
        8,
        Math.floor(
          viewportArea /
            (window.matchMedia("(max-width: 820px)").matches ? 52000 : 30000),
        ),
      );
      const visibleRanked = ranked.filter((node) => {
        if (!node.hidden_external_connection
          && !core.facultyLabelEligible(node, state.view.departments)) return false;
        const point = worldToScreen(node, now, transform);
        return (
          point.x >= viewport.left - 12 &&
          point.x <= viewport.right + 12 &&
          point.y >= viewport.top - 12 &&
          point.y <= viewport.bottom + 12
        );
      });
      labelIds = new Set(
        visibleRanked.slice(0, labelLimit).map((node) => node.id),
      );
      for (const node of visibleRanked) {
        if (node.kind === "external_coauthor" || node.hidden_external_connection) labelIds.add(node.id);
      }
    }
    if (state.hoveredId) labelIds.add(state.hoveredId);

    for (const node of state.filtered.nodes) {
      const point = worldToScreen(node, now, transform);
      if (point.x < -20 || point.x > state.width + 20 || point.y < -20 || point.y > state.height + 20) {
        continue;
      }
      const radius = nodeRadius(node);
      const related = !emphasisIds.size || neighborIds.has(node.id);
      const mappedConnection = node.degree || node.hidden_external_connection;
      context.globalAlpha = related ? (mappedConnection ? 0.94 : 0.42) : 0.13;
      context.fillStyle = mappedConnection
        ? nodeColor(node)
        : css("--canvas-unconnected");
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.lineWidth = selectedIds.has(node.id) ? 2.4 : node.id === state.hoveredId ? 1.7 : 0.8;
      context.strokeStyle =
        selectedIds.has(node.id) || node.id === state.hoveredId
          ? css("--canvas-selected")
          : colorWithAlpha(css("--canvas-selected"), 0.45);
      context.stroke();
    }
    context.globalAlpha = 1;

    const occupied = [];
    if (isDepartmentLayout() && !selectedIds.size) {
      drawDepartmentLabels(occupied, now, transform);
    }
    const labelPriority = (node) =>
      selectedIds.has(node.id) ? 3
        : node.id === state.hoveredId ? 2
          : node.kind === "external_coauthor" ? 1 : 0;
    const nodesForLabels = state.filtered.nodes
      .filter((node) => labelIds.has(node.id))
      .sort((left, right) =>
        labelPriority(right) - labelPriority(left) || right.strength - left.strength);
    for (const node of nodesForLabels) {
      drawNodeLabel(
        node,
        occupied,
        selectedIds.has(node.id) || node.id === state.hoveredId,
        now,
        transform,
      );
    }
    if (state.transition) requestRender();
  }

  function drawDepartmentLabels(occupied, now, transform) {
    const groups = new Map();
    const schoolFocused = core.hasSchoolFocus(state.view);
    for (const node of state.filtered.nodes) {
      const departmentId = state.layoutDepartments.get(node.id)
        || core.layoutDepartmentId(node, state.view.departments, state.graph, state.view.schools);
      if (!groups.has(departmentId)) groups.set(departmentId, []);
      groups.get(departmentId).push(node);
    }
    const viewport = effectiveViewport();
    const origin = { x: transform.x, y: transform.y };
    context.font = "700 11px Inter, ui-sans-serif, system-ui, sans-serif";

    const layoutGroups = [
      ...state.graph.academic_homes,
      { home_group: core.UNRESOLVED_LAYOUT_GROUP, short_title: "Primary unresolved" },
    ];
    for (const home of layoutGroups) {
      const unresolved = home.home_group === core.UNRESOLVED_LAYOUT_GROUP;
      if (!unresolved && schoolFocused && !state.view.schools.includes(home.school_id)) continue;
      if (!unresolved && ["department", "constituent_school", "institute"].includes(home.home_type)
        && !core.departmentLabelEligible(home.home_group, state.view.departments)) {
        continue;
      }
      const nodes = groups.get(home.home_group);
      if (!nodes?.length) continue;
      const points = nodes.map((node) => worldToScreen(node, now, transform));
      const center = {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
      const length = Math.hypot(center.x - origin.x, center.y - origin.y);
      const direction =
        length > 1
          ? { x: (center.x - origin.x) / length, y: (center.y - origin.y) / length }
          : { x: 0, y: -1 };
      const extent = Math.max(
        0,
        ...points.map(
          (point) =>
            (point.x - center.x) * direction.x + (point.y - center.y) * direction.y,
        ),
      );
      const text = home.short_title;
      const width = Math.min(
        Math.ceil(context.measureText(text).width) + 18,
        Math.max(72, viewport.right - viewport.left - 12),
      );
      const height = 23;
      const anchor = {
        x: center.x + direction.x * (extent + 24),
        y: center.y + direction.y * (extent + 24),
      };
      const rect = {
        x: Math.max(viewport.left + 6, Math.min(viewport.right - width - 6, anchor.x - width / 2)),
        y: Math.max(viewport.top + 6, Math.min(viewport.bottom - height - 6, anchor.y - height / 2)),
        width,
        height,
      };
      const overlaps = occupied.some(
        (other) =>
          rect.x < other.x + other.width + 4 &&
          rect.x + rect.width + 4 > other.x &&
          rect.y < other.y + other.height + 4 &&
          rect.y + rect.height + 4 > other.y,
      );
      if (overlaps) continue;
      occupied.push(rect);
      context.globalAlpha = 0.94;
      context.fillStyle = css("--tooltip");
      roundedRect(context, rect.x, rect.y, rect.width, rect.height, 999);
      context.fill();
      context.strokeStyle = unresolved
        ? css("--primary-unresolved") : academicHomeColor(home.home_group);
      context.lineWidth = 1.4;
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = css("--text");
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 0.5, rect.width - 12);
      context.textAlign = "start";
    }
  }

  function colorWithAlpha(color, alpha) {
    if (/^#[0-9a-f]{6}$/i.test(color)) {
      return `${color}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, "0")}`;
    }
    return color;
  }

  function drawNodeLabel(node, occupied, force, now, transform) {
    const point = worldToScreen(node, now, transform);
    context.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
    const width = Math.ceil(context.measureText(node.name).width) + 13;
    const height = 22;
    const radius = nodeRadius(node);
    const selectedPoints = state.view.selectedIds
      .map((id) => state.filtered.nodeById.get(id))
      .filter(Boolean)
      .map((selected) => worldToScreen(selected, now, transform));
    const selectedCenter = selectedPoints.length
      ? {
          x: selectedPoints.reduce((sum, selected) => sum + selected.x, 0) / selectedPoints.length,
          y: selectedPoints.reduce((sum, selected) => sum + selected.y, 0) / selectedPoints.length,
        }
      : null;
    const placeLeft =
      selectedCenter && !state.view.selectedIds.includes(node.id) && point.x < selectedCenter.x;
    const viewport = effectiveViewport();
    const minimumX = Math.max(8, viewport.left + 6);
    const maximumX = Math.max(
      minimumX,
      Math.min(state.width - width - 8, viewport.right - width - 6),
    );
    const minimumY = Math.max(8, viewport.top + 6);
    const maximumY = Math.max(
      minimumY,
      Math.min(state.height - height - 8, viewport.bottom - height - 6),
    );
    const clampRect = ({ x, y }) => ({
      x: Math.max(minimumX, Math.min(maximumX, x)),
      y: Math.max(minimumY, Math.min(maximumY, y)),
      width,
      height,
    });
    const overlaps = (rect) =>
      occupied.some(
        (other) =>
          rect.x < other.x + other.width + 3 &&
          rect.x + rect.width + 3 > other.x &&
          rect.y < other.y + other.height + 3 &&
          rect.y + rect.height + 3 > other.y,
      );
    const right = { x: point.x + radius + 5, y: point.y - height / 2 };
    const left = { x: point.x - radius - width - 5, y: point.y - height / 2 };
    const candidates = [
      placeLeft ? left : right,
      placeLeft ? right : left,
      { x: point.x - width / 2, y: point.y - radius - height - 5 },
      { x: point.x - width / 2, y: point.y + radius + 5 },
    ].map(clampRect);
    const rect = force ? candidates[0] : candidates.find((candidate) => !overlaps(candidate));
    if (!rect) return;
    occupied.push(rect);
    context.globalAlpha = force ? 0.98 : 0.86;
    context.fillStyle = css("--tooltip");
    roundedRect(context, rect.x, rect.y, rect.width, rect.height, 6);
    context.fill();
    context.strokeStyle = css("--line");
    context.lineWidth = 1;
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = css("--text");
    context.textBaseline = "middle";
    context.fillText(node.name, rect.x + 6.5, rect.y + height / 2 + 0.5);
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function hitTest(x, y) {
    let closest = null;
    let closestDistance = Infinity;
    const now = performance.now();
    const transform = displayTransform(now);
    for (const node of state.filtered?.nodes || []) {
      const point = worldToScreen(node, now, transform);
      const distance = Math.hypot(point.x - x, point.y - y);
      const hitRadius = Math.max(10, nodeRadius(node) + 4);
      if (distance <= hitRadius && distance < closestDistance) {
        closest = node;
        closestDistance = distance;
      }
    }
    return closest;
  }

  function canvasPoint(event) {
    const rect = elements.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function updateHover(event) {
    if (state.drag?.moved) return;
    const point = canvasPoint(event);
    const node = hitTest(point.x, point.y);
    const nextId = node?.id || "";
    if (nextId !== state.hoveredId) {
      state.hoveredId = nextId;
      requestRender();
    }
    if (!node) {
      elements.tooltip.hidden = true;
      elements.canvas.style.cursor = state.drag ? "grabbing" : "grab";
      return;
    }
    elements.canvas.style.cursor = "pointer";
    const departmentNames = nodeAffiliation(node);
    elements.tooltip.replaceChildren(
      element("strong", "", node.name),
      element(
        "span",
        "",
        `${departmentNames} · ${plural(node.degree, "visible collaborator")} · ${plural(
          node.strength,
          "shared work",
        )}`,
      ),
    );
    elements.tooltip.hidden = false;
    positionTooltip(event.clientX, event.clientY);
  }

  function positionTooltip(clientX, clientY) {
    const width = elements.tooltip.offsetWidth;
    const height = elements.tooltip.offsetHeight;
    const left = Math.min(window.innerWidth - width - 12, clientX + 14);
    const top = Math.min(window.innerHeight - height - 12, clientY + 14);
    elements.tooltip.style.left = `${Math.max(8, left)}px`;
    elements.tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function selectFaculty(nodeId, { openDetails = true, ensureSelected = false } = {}) {
    if (!state.graph.nodeById.has(nodeId)) return;
    if (state.graph.nodeById.get(nodeId).kind === "external_coauthor") {
      state.view.showExternal = true;
      elements.showExternal.checked = true;
      renderControls();
      syncControls();
    }
    const selectedIds = [...state.view.selectedIds];
    const selectedIndex = selectedIds.indexOf(nodeId);
    if (selectedIndex >= 0 && !ensureSelected) selectedIds.splice(selectedIndex, 1);
    else if (selectedIndex < 0) selectedIds.push(nodeId);
    state.view.selectedIds = selectedIds;
    state.expandedEdgeId = "";
    renderSelectedFaculty();
    applyView({ fit: true, animate: true });
    if (state.view.selectedIds.length) {
      if (openDetails && window.matchMedia("(max-width: 820px)").matches) {
        openMobilePanel("detail");
      }
    }
  }

  function renderDetails() {
    const selectedIds = state.view?.selectedIds || [];
    if (!selectedIds.length) {
      elements.detailContent.hidden = true;
      elements.detailEmpty.hidden = false;
      elements.toggleDetails.disabled = !state.graph;
      return;
    }
    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.detailContent.replaceChildren();
    if (selectedIds.length === 1) renderSingleFacultyDetails(selectedIds[0]);
    else renderMultiFacultyDetails(selectedIds);
  }

  function appendDetailMetrics(entries) {
    const metrics = element("div", "detail-metrics");
    for (const [value, label] of entries) {
      const metric = element("div", "detail-metric");
      metric.append(element("strong", "", formatNumber(value)), element("span", "", label));
      metrics.append(metric);
    }
    elements.detailContent.append(metrics);
  }

  function renderSingleFacultyDetails(nodeId) {
    const node = state.graph.nodeById.get(nodeId);
    if (!node) return;
    const filteredNode = state.filtered.nodeById.get(nodeId) || { ...node, degree: 0, strength: 0 };
    const connections = core.connectionsForNode(state.filtered, nodeId);

    const header = element("header", "detail-header");
    header.append(
      element("p", "eyebrow", node.kind === "external_coauthor" ? "External historical coauthor" : "Selected faculty"),
      element("h2", "detail-name", node.name),
    );
    const departmentList = element("div", "detail-departments");
    for (const departmentId of node.departments) {
      const department = state.graph.departmentById.get(departmentId);
      const chip = element("span", "department-chip");
      chip.style.setProperty("--dot", departmentColor(departmentId));
      chip.append(element("i"), document.createTextNode(department?.short_title || departmentId));
      departmentList.append(chip);
    }
    if (node.kind === "external_coauthor") {
      const chip = element("span", "department-chip");
      chip.style.setProperty("--dot", nodeColor(node));
      chip.append(element("i"), document.createTextNode("Outside CMU"));
      departmentList.append(chip);
    }
    header.append(departmentList);
    if (node.kind !== "external_coauthor") {
      const primary = element("p", "detail-primary");
      if (node.primary_home_group) {
        const title = node.primary_academic_home_title
          || state.graph.academicHomeByGroup.get(node.primary_home_group)?.title
          || node.primary_academic_home_id;
        const basis = {
          inferred_advisee_count: "inferred from PhD advisees",
          inferred_profile_title: "inferred from faculty title",
          reviewed: "reviewed",
          single_included_membership: "sole included academic unit",
          school_fallback: "school-level home; no narrower unit verified",
        }[node.primary_academic_home_basis] || "display choice";
        const typeLabel = {
          department: "department",
          constituent_school: "constituent school",
          institute: "institute",
          academic_area: "academic area",
          school: "school",
        }[node.primary_academic_home_type] || "academic home";
        primary.append(document.createTextNode(`Primary academic home: ${title} (${typeLabel}; ${basis})`));
        if (node.primary_academic_home_source_url) {
          const source = element("a", "", "Evidence ↗");
          source.href = node.primary_academic_home_source_url;
          source.target = "_blank";
          source.rel = "noopener noreferrer";
          primary.append(document.createTextNode(" · "), source);
        }
      } else {
        primary.textContent = "Primary academic home unresolved";
      }
      header.append(primary);
    }
    const links = element("div", "detail-links");
    for (const [label, url] of [
      [node.kind === "external_coauthor" ? "Coauthor source ↗" : "Homepage ↗", node.homepage_url],
      ["Scholar ↗", node.scholar_url],
      ["ORCID ↗", node.orcid_url],
    ]) {
      if (!url) continue;
      const link = element("a", "", label);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    if (links.children.length) header.append(links);
    elements.detailContent.append(header);

    appendDetailMetrics([
      [filteredNode.degree, "visible collaborators"],
      [filteredNode.strength, "pair–work records"],
      [node.mapped_publication_count, "mapped works"],
    ]);

    const heading = element("div", "collaborator-heading");
    heading.append(
      element("h3", "", "Observed collaborators"),
      element("span", "", connections.length ? "Select a row for evidence" : "Current view"),
    );
    elements.detailContent.append(heading);
    if (!connections.length) {
      const hiddenExternalConnection = !state.view.showExternal
        && filteredNode.hidden_external_connection;
      elements.detailContent.append(
        element(
          "p",
          "detail-no-links",
          hiddenExternalConnection
            ? "A verified historical coauthor connection is hidden. Turn on Show Erdős to inspect the shared works."
            : node.mapped_publication_count
            ? "No connections meet the current year, department, and strength filters."
            : node.kind === "external_coauthor"
              ? "No verified shared works are available for this external coauthor in the source artifact."
              : "No mapped publications are available for this faculty member in the source artifact.",
        ),
      );
      return;
    }

    elements.detailContent.append(
      renderConnectionCards(connections, (connection) => ({
        label: state.graph.nodeById.get(connection.collaboratorId).name,
        colorNode: state.graph.nodeById.get(connection.collaboratorId),
      })),
    );
  }

  function renderMultiFacultyDetails(selectedIds) {
    const selectedNodes = selectedIds.map((id) => state.graph.nodeById.get(id)).filter(Boolean);
    const selection = core.subgraphForSelection(state.filtered, selectedIds);
    const header = element("header", "detail-header");
    header.append(
      element("p", "eyebrow", hasExternalCoauthors() ? "Selected people" : "Selected faculty"),
      element("h2", "detail-name", `${plural(selectedNodes.length, hasExternalCoauthors() ? "person" : "faculty member")} selected`),
    );
    const roster = element("ul", "detail-selection-list");
    for (const node of selectedNodes) {
      const item = element("li");
      const dot = element("span", "legend-dot");
      dot.style.setProperty("--dot", nodeColor(node));
      dot.setAttribute("aria-hidden", "true");
      const departmentNames = nodeAffiliation(node);
      item.append(dot, element("strong", "", node.name), element("small", "", departmentNames));
      roster.append(item);
    }
    header.append(roster);
    elements.detailContent.append(header);

    appendDetailMetrics([
      [selectedNodes.length, hasExternalCoauthors() ? "selected people" : "selected faculty"],
      [selection.edges.length, "visible connections"],
      [selection.visibleWorkCount, "unique shared works"],
    ]);

    const heading = element("div", "collaborator-heading");
    heading.append(
      element("h3", "", "Connections involving selection"),
      element("span", "", selection.edges.length ? "Select a row for evidence" : "Current view"),
    );
    elements.detailContent.append(heading);
    if (!selection.edges.length) {
      elements.detailContent.append(
        element(
          "p",
          "detail-no-links",
          hasExternalCoauthors()
            ? "No connections involving the selected people meet the current year, department, and strength filters."
            : "No connections involving the selected faculty meet the current year, department, and strength filters.",
        ),
      );
      return;
    }

    elements.detailContent.append(
      renderConnectionCards(selection.edges, (connection) => {
        const source = state.graph.nodeById.get(connection.source);
        const target = state.graph.nodeById.get(connection.target);
        return { label: `${source.name} ↔ ${target.name}`, colorNode: source };
      }),
    );
  }

  function renderConnectionCards(connections, describeConnection) {
    const list = element("div", "collaborator-list");
    for (const connection of connections) {
      const { label, colorNode } = describeConnection(connection);
      const card = element("article", "collaborator-card");
      const button = element("button", "collaborator-button");
      button.type = "button";
      button.dataset.edgeId = connection.id;
      button.setAttribute("aria-expanded", String(state.expandedEdgeId === connection.id));
      const dot = element("span", "legend-dot");
      dot.style.setProperty("--dot", nodeColor(colorNode));
      dot.setAttribute("aria-hidden", "true");
      button.append(
        dot,
        element("strong", "", label),
        element("span", "", `${connection.count} ${connection.count === 1 ? "work" : "works"}`),
      );
      card.append(button);
      if (state.expandedEdgeId === connection.id) {
        card.append(renderPublications(connection));
      }
      list.append(card);
    }
    return list;
  }

  function renderPublications(connection) {
    const list = element("ol", "publication-list");
    for (const work of connection.works) {
      const item = element("li");
      if (work.url) {
        const link = element("a", "", work.title);
        link.href = work.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(link);
      } else {
        item.append(document.createTextNode(work.title));
      }
      const details = [
        Number.isInteger(work.year) ? work.year : "Undated",
        work.topic,
        work.citations ? plural(work.citations, "citation") : "",
        work.source_types?.includes("curated_verified")
          && !work.source_types.includes("scholar")
          ? "Citation count unavailable"
          : "",
        work.source_types?.includes("curated_verified")
          ? work.source_types.includes("scholar")
            ? "Scholar record and source verified"
            : "Source verified; not collected from Google Scholar"
          : "",
        work.source_verified_at ? `verified ${work.source_verified_at}` : "",
      ].filter(Boolean);
      item.append(element("span", "publication-meta", details.join(" · ")));
      for (const [index, sourceUrl] of (work.source_verification_urls || []).entries()) {
        if (sourceUrl === work.url) continue;
        const sourceLink = element("a", "publication-source", `Verification source ${index + 1} ↗`);
        sourceLink.href = sourceUrl;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer";
        item.append(sourceLink);
      }
      list.append(item);
    }
    return list;
  }

  function renderSelectedFaculty() {
    const selectedNodes = (state.view?.selectedIds || [])
      .map((id) => state.graph?.nodeById.get(id))
      .filter(Boolean);
    elements.selectedFaculty.replaceChildren();
    elements.selectedFaculty.hidden = selectedNodes.length === 0;
    const searchScope = core.hasSchoolFocus(state.view) || state.view.departments.length
      ? "selected faculty and linked coauthors"
      : `${formatNumber(state.graph?.nodes.length)} ${hasExternalCoauthors() ? "people" : "faculty"}`;
    elements.facultySearch.placeholder = selectedNodes.length
      ? hasExternalCoauthors() ? "Add another person" : "Add another faculty member"
      : `Search ${searchScope}`;
    for (const node of selectedNodes) {
      const item = element("li");
      const name = element("span", "", node.name);
      const remove = element("button", "", "×");
      remove.type = "button";
      remove.dataset.removeFacultyId = node.id;
      remove.setAttribute("aria-label", `Remove ${node.name} from selection`);
      item.append(name, remove);
      elements.selectedFaculty.append(item);
    }
  }

  function renderSuggestions() {
    const query = elements.facultySearch.value;
    state.suggestionNodes = core.facultyMatches(
      state.graph,
      query,
      state.graph.nodes.length,
      state.view.selectedIds,
    ).filter((node) => core.scopeEligible(
      state.graph, node, state.view.departments, state.view.schools)).slice(0, 9);
    state.activeSuggestion = state.suggestionNodes.length ? 0 : -1;
    elements.facultySuggestions.replaceChildren();
    if (!query.trim()) {
      closeSuggestions();
      return;
    }
    if (!state.suggestionNodes.length) {
      const empty = element(
        "li",
        "suggestion-empty",
        hasExternalCoauthors()
          ? "No additional people match this search."
          : "No additional faculty match this search.",
      );
      elements.facultySuggestions.append(empty);
    } else {
      state.suggestionNodes.forEach((node, index) => {
        const item = element("li");
        item.setAttribute("role", "option");
        const button = element("button");
        button.type = "button";
        button.dataset.facultyId = node.id;
        button.setAttribute("aria-selected", String(index === state.activeSuggestion));
        const department = nodeAffiliation(node);
        button.append(
          element("span", "", node.name),
          element(
            "small",
            "",
            node.mapped_publication_count
              ? `${department} · ${formatNumber(node.mapped_publication_count)} works`
              : `${department} · no mapped works`,
          ),
        );
        item.append(button);
        elements.facultySuggestions.append(item);
      });
    }
    elements.facultySuggestions.hidden = false;
    elements.facultySearch.setAttribute("aria-expanded", "true");
  }

  function syncSuggestionSelection() {
    elements.facultySuggestions.querySelectorAll("button").forEach((button, index) => {
      button.setAttribute("aria-selected", String(index === state.activeSuggestion));
      if (index === state.activeSuggestion) button.scrollIntoView({ block: "nearest" });
    });
  }

  function closeSuggestions() {
    elements.facultySuggestions.hidden = true;
    elements.facultySearch.setAttribute("aria-expanded", "false");
    state.suggestionNodes = [];
    state.activeSuggestion = -1;
  }

  function commitSuggestion(index = state.activeSuggestion) {
    const node = state.suggestionNodes[index];
    if (!node) return;
    elements.facultySearch.value = "";
    closeSuggestions();
    selectFaculty(node.id, { openDetails: true, ensureSelected: true });
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 2200);
  }

  function resetFilters() {
    state.view = core.defaultState(state.graph);
    elements.facultySearch.value = "";
    closeSuggestions();
    syncControls();
    renderScopeCopy();
    applyView({ fit: true });
  }

  function readYears() {
    const minimum = state.graph.years.minimum;
    const maximum = state.graph.years.maximum;
    let fromYear = Math.min(maximum, Math.max(minimum, Number(elements.yearMin.value) || minimum));
    let toYear = Math.min(maximum, Math.max(minimum, Number(elements.yearMax.value) || maximum));
    if (fromYear > toYear) [fromYear, toYear] = [toYear, fromYear];
    state.view.fromYear = fromYear;
    state.view.toYear = toYear;
    syncControls();
    applyView({ fit: true });
  }

  function downloadCsv() {
    const csv = core.edgesToCsv(state.graph, state.filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = state.graph.schools.length > 1
      ? "cmu-collaborations.csv"
      : "cmu-engineering-collaborations.csv";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function panelConfig(name) {
    return {
      filters: [elements.filterPanel, elements.toggleFilters],
      legend: [elements.legendPanel, elements.toggleLegend],
      detail: [elements.detailPanel, elements.toggleDetails],
    }[name];
  }

  function openMobilePanel(name) {
    if (!window.matchMedia("(max-width: 820px)").matches) return;
    for (const candidate of ["filters", "legend", "detail"]) {
      const [panel, button] = panelConfig(candidate);
      const open = candidate === name && !panel.classList.contains("mobile-open");
      panel.classList.toggle("mobile-open", open);
      button.setAttribute("aria-expanded", String(open));
    }
  }

  function bindEvents() {
    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(elements.canvas);
    window.addEventListener("collaboration-theme-change", () => {
      renderControls();
      renderExternalLegend();
      syncControls();
      requestRender();
    });
    window.addEventListener("popstate", () => {
      if (!state.graph) return;
      state.view = core.stateFromSearch(window.location.search, state.graph);
      renderControls();
      syncControls();
      if (elements.facultySearch.value) renderSuggestions();
      applyView({
        fit: true,
        updateUrl: core.hasSchoolFocus(state.view) || Boolean(state.view.departments.length),
        animate: true,
      });
    });

    elements.canvas.addEventListener("pointerdown", (event) => {
      settleTransition();
      const point = canvasPoint(event);
      state.drag = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        originX: state.transform.x,
        originY: state.transform.y,
        moved: false,
      };
      elements.canvas.setPointerCapture(event.pointerId);
      elements.canvas.classList.add("dragging");
    });
    elements.canvas.addEventListener("pointermove", (event) => {
      if (state.drag?.pointerId === event.pointerId) {
        const point = canvasPoint(event);
        const dx = point.x - state.drag.startX;
        const dy = point.y - state.drag.startY;
        if (Math.hypot(dx, dy) > 4) state.drag.moved = true;
        state.transform.x = state.drag.originX + dx;
        state.transform.y = state.drag.originY + dy;
        elements.tooltip.hidden = true;
        requestRender();
      } else {
        updateHover(event);
      }
    });
    elements.canvas.addEventListener("pointerup", (event) => {
      if (state.drag?.pointerId !== event.pointerId) return;
      const point = canvasPoint(event);
      const moved = state.drag.moved;
      state.drag = null;
      elements.canvas.classList.remove("dragging");
      if (!moved) {
        const node = hitTest(point.x, point.y);
        if (node) selectFaculty(node.id);
      }
    });
    elements.canvas.addEventListener("pointercancel", () => {
      state.drag = null;
      elements.canvas.classList.remove("dragging");
    });
    elements.canvas.addEventListener("pointerleave", () => {
      if (!state.drag) {
        state.hoveredId = "";
        elements.tooltip.hidden = true;
        requestRender();
      }
    });
    elements.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const point = canvasPoint(event);
        zoomAt(Math.exp(-event.deltaY * 0.0012), point.x, point.y);
      },
      { passive: false },
    );
    elements.canvas.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 80 : 32;
      if (event.key === "+" || event.key === "=") zoomAt(1.22);
      else if (event.key === "-") zoomAt(1 / 1.22);
      else if (event.key === "0" || event.key === "Home") refitCurrent({ animate: true });
      else if (event.key === "ArrowLeft") state.transform.x += step;
      else if (event.key === "ArrowRight") state.transform.x -= step;
      else if (event.key === "ArrowUp") state.transform.y += step;
      else if (event.key === "ArrowDown") state.transform.y -= step;
      else return;
      event.preventDefault();
      requestRender();
    });

    elements.facultySearch.addEventListener("input", renderSuggestions);
    elements.facultySearch.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && state.suggestionNodes.length) {
        event.preventDefault();
        state.activeSuggestion = (state.activeSuggestion + 1) % state.suggestionNodes.length;
        syncSuggestionSelection();
      } else if (event.key === "ArrowUp" && state.suggestionNodes.length) {
        event.preventDefault();
        state.activeSuggestion =
          (state.activeSuggestion - 1 + state.suggestionNodes.length) % state.suggestionNodes.length;
        syncSuggestionSelection();
      } else if (event.key === "Enter") {
        event.preventDefault();
        commitSuggestion();
      } else if (event.key === "Escape") {
        closeSuggestions();
      }
    });
    elements.facultySuggestions.addEventListener("pointerdown", (event) => {
      const button = event.target.closest("button[data-faculty-id]");
      if (!button) return;
      event.preventDefault();
      const index = state.suggestionNodes.findIndex((node) => node.id === button.dataset.facultyId);
      commitSuggestion(index);
    });
    elements.selectedFaculty.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-remove-faculty-id]");
      if (!button) return;
      selectFaculty(button.dataset.removeFacultyId, { openDetails: false });
      elements.facultySearch.focus();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".faculty-field")) closeSuggestions();
    });

    elements.schoolOptions.addEventListener("change", () => {
      state.view.schools = [...elements.schoolOptions.querySelectorAll("input:checked")].map(
        (input) => input.value,
      );
      state.view = core.normalizeView(state.view, state.graph);
      renderDepartmentControls();
      renderScopeCopy();
      syncControls();
      if (elements.facultySearch.value) renderSuggestions();
      applyView({ fit: true, animate: true });
    });
    elements.departmentOptions.addEventListener("change", () => {
      state.view.departments = [...elements.departmentOptions.querySelectorAll("input:checked")].map(
        (input) => input.value,
      );
      renderScopeCopy();
      if (elements.facultySearch.value) renderSuggestions();
      applyView({ fit: true, animate: true });
    });
    elements.departmentLegend.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-department-id]");
      if (!button) return;
      state.view.departments = [button.dataset.departmentId];
      syncControls();
      renderScopeCopy();
      if (elements.facultySearch.value) renderSuggestions();
      applyView({ fit: true, animate: true });
      if (window.matchMedia("(max-width: 820px)").matches) openMobilePanel("legend");
    });
    elements.yearMin.addEventListener("change", readYears);
    elements.yearMax.addEventListener("change", readYears);
    document.querySelectorAll("[data-year-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        const preset = button.dataset.yearPreset;
        state.view.fromYear =
          preset === "all"
            ? state.graph.years.minimum
            : Math.max(state.graph.years.minimum, state.graph.years.maximum - Number(preset) + 1);
        state.view.toYear = state.graph.years.maximum;
        syncControls();
        applyView({ fit: true, animate: true });
      });
    });
    elements.strength.addEventListener("input", () => {
      state.view.minimum = Number(elements.strength.value);
      elements.strengthOutput.textContent = `${state.view.minimum}+ shared ${
        state.view.minimum === 1 ? "work" : "works"
      }`;
      applyView({ fit: true, animate: true });
    });
    elements.crossDepartment.addEventListener("change", () => {
      state.view.crossDepartment = elements.crossDepartment.checked;
      applyView({ fit: true, animate: true });
    });
    elements.crossSchool.addEventListener("change", () => {
      state.view.crossSchool = elements.crossSchool.checked;
      applyView({ fit: true, animate: true });
    });
    elements.showUnconnected.addEventListener("change", () => {
      state.view.showUnconnected = elements.showUnconnected.checked;
      applyView({ fit: true, animate: true });
    });
    elements.showExternal.addEventListener("change", () => {
      state.view.showExternal = elements.showExternal.checked;
      if (!state.view.showExternal) {
        state.view.selectedIds = state.view.selectedIds.filter((id) =>
          state.graph.nodeById.get(id)?.kind !== "external_coauthor");
      }
      renderControls();
      syncControls();
      applyView({ fit: true, animate: true });
    });
    elements.layoutOptions.addEventListener("change", (event) => {
      if (!event.target.matches('input[name="graph-layout"]')) return;
      state.view.layout = event.target.value;
      state.view = core.normalizeView(state.view, state.graph);
      renderDepartmentControls();
      renderScopeCopy();
      syncControls();
      if (elements.facultySearch.value) renderSuggestions();
      applyView({ fit: true, animate: true });
    });
    elements.departmentSpacing.addEventListener("input", () => {
      const label = departmentSpacingLabel(elements.departmentSpacing.value);
      elements.departmentSpacingOutput.textContent = label;
      elements.departmentSpacing.setAttribute("aria-valuetext", label);
    });
    elements.departmentSpacing.addEventListener("change", () => {
      state.view.departmentSpacing = Number(elements.departmentSpacing.value);
      applyView({ fit: true, animate: true });
    });
    elements.schoolSpacing.addEventListener("input", () => {
      const label = schoolSpacingLabel(elements.schoolSpacing.value);
      elements.schoolSpacingOutput.textContent = label;
      elements.schoolSpacing.setAttribute("aria-valuetext", label);
    });
    elements.schoolSpacing.addEventListener("change", () => {
      state.view.schoolSpacing = Number(elements.schoolSpacing.value);
      applyView({ fit: true, animate: true });
    });
    elements.detailContent.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edge-id]");
      if (!button) return;
      state.expandedEdgeId =
        state.expandedEdgeId === button.dataset.edgeId ? "" : button.dataset.edgeId;
      renderDetails();
    });

    elements.clear.addEventListener("click", resetFilters);
    elements.fit.addEventListener("click", () => fitVisible({ animate: true }));
    elements.reset.addEventListener("click", () => refitCurrent({ animate: true }));
    elements.zoomFit.addEventListener("click", () => fitVisible({ animate: true }));
    elements.zoomIn.addEventListener("click", () => zoomAt(1.24));
    elements.zoomOut.addEventListener("click", () => zoomAt(1 / 1.24));
    elements.copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        showToast("View link copied");
      } catch {
        showToast("Copy unavailable; use the browser address bar");
      }
    });
    elements.download.addEventListener("click", downloadCsv);
    elements.retry.addEventListener("click", load);
    elements.toggleFilters.addEventListener("click", () => openMobilePanel("filters"));
    elements.toggleLegend.addEventListener("click", () => openMobilePanel("legend"));
    elements.toggleDetails.addEventListener("click", () => openMobilePanel("detail"));
  }

  bindEvents();
  load();
})();
