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
    departmentOptions: document.querySelector("#department-options"),
    departmentLegend: document.querySelector("#department-legend"),
    facultySearch: document.querySelector("#faculty-search"),
    facultySuggestions: document.querySelector("#faculty-suggestions"),
    yearMin: document.querySelector("#year-min"),
    yearMax: document.querySelector("#year-max"),
    undatedNote: document.querySelector("#undated-note"),
    strength: document.querySelector("#strength-min"),
    strengthOutput: document.querySelector("#strength-output"),
    crossDepartment: document.querySelector("#cross-department"),
    showUnconnected: document.querySelector("#show-unconnected"),
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

  function departmentColor(departmentId) {
    const department = state.graph?.departmentById.get(departmentId);
    if (!department) return css("--accent");
    return document.documentElement.dataset.resolvedTheme === "light"
      ? department.color_light
      : department.color_dark;
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
      renderControls();
      syncControls();
      applyView({ fit: true, updateUrl: false });
      const counts = state.graph.counts;
      elements.status.textContent = `${plural(counts.faculty_count, "faculty member")} · ${plural(
        counts.edge_count,
        "observed connection",
      )} · source updated ${formatDate(state.graph.source.source_data_newest_at_utc)}`;
      elements.coverageNote.textContent = `${plural(
        counts.mapped_faculty_count,
        "faculty member",
      )} have mapped publications; ${plural(
        counts.unmapped_faculty_count,
        "cataloged faculty member",
      )} do not. ${state.graph.quality.coverage_note || ""}`;
      setLoading(false);
      if (state.view.selectedId) focusSelected();
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

  function renderControls() {
    elements.departmentOptions.replaceChildren();
    elements.departmentLegend.replaceChildren();
    for (const department of state.graph.departments) {
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

      const legendButton = element("button");
      legendButton.type = "button";
      legendButton.dataset.departmentId = department.department_id;
      legendButton.title = `Filter to ${department.title}`;
      const legendDot = element("span", "legend-dot");
      legendDot.style.setProperty("--dot", departmentColor(department.department_id));
      legendDot.setAttribute("aria-hidden", "true");
      legendButton.append(legendDot, element("span", "", department.short_title));
      elements.departmentLegend.append(legendButton);
    }
    elements.facultySearch.placeholder = `Search ${formatNumber(state.graph.nodes.length)} faculty`;
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
    const selectedDepartments = new Set(view.departments);
    elements.departmentOptions.querySelectorAll("input").forEach((input) => {
      input.checked = selectedDepartments.has(input.value);
    });
    elements.yearMin.value = String(view.fromYear);
    elements.yearMax.value = String(view.toYear);
    elements.strength.value = String(view.minimum);
    elements.strengthOutput.textContent = `${view.minimum}+ shared ${
      view.minimum === 1 ? "work" : "works"
    }`;
    elements.crossDepartment.checked = view.crossDepartment;
    elements.showUnconnected.checked = view.showUnconnected;
  }

  function applyView({ fit = false, updateUrl = true } = {}) {
    state.filtered = core.filterGraph(state.graph, state.view);
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
    if (fit) fitVisible();
    requestRender();
  }

  function updateStats() {
    const filtered = state.filtered;
    if (!filtered) {
      elements.stats.textContent = "";
      return;
    }
    const suffix = state.view.crossDepartment ? " · cross-department" : "";
    elements.stats.textContent = `${plural(filtered.nodes.length, "faculty member")} · ${plural(
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

  function fitNodes(nodes, { maximumScale = 720 } = {}) {
    if (!nodes?.length || !state.width || !state.height) return;
    const viewport = effectiveViewport();
    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxY = Math.max(...nodes.map((node) => node.y));
    const spanX = Math.max(0.18, maxX - minX);
    const spanY = Math.max(0.14, maxY - minY);
    const availableWidth = Math.max(120, viewport.right - viewport.left);
    const availableHeight = Math.max(120, viewport.bottom - viewport.top);
    const scale = Math.min(
      maximumScale,
      Math.max(45, Math.min(availableWidth / spanX, availableHeight / spanY) * 0.82),
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    state.transform = {
      k: scale,
      x: viewport.left + availableWidth / 2 - centerX * scale,
      y: viewport.top + availableHeight / 2 - centerY * scale,
    };
    requestRender();
  }

  function fitVisible() {
    fitNodes(state.filtered?.nodes || []);
  }

  function focusSelected() {
    const selectedId = state.view.selectedId;
    if (!selectedId) return;
    const selected = state.filtered.nodeById.get(selectedId) || state.graph.nodeById.get(selectedId);
    if (!selected) return;
    const connections = core.connectionsForNode(state.filtered, selectedId);
    const nodes = [
      selected,
      ...connections
        .map((connection) => state.filtered.nodeById.get(connection.collaboratorId))
        .filter(Boolean),
    ];
    fitNodes(nodes, { maximumScale: connections.length ? 560 : 420 });
  }

  function zoomAt(factor, x = state.width / 2, y = state.height / 2) {
    const oldScale = state.transform.k;
    const nextScale = Math.min(1400, Math.max(40, oldScale * factor));
    const actualFactor = nextScale / oldScale;
    state.transform.x = x - (x - state.transform.x) * actualFactor;
    state.transform.y = y - (y - state.transform.y) * actualFactor;
    state.transform.k = nextScale;
    requestRender();
  }

  function worldToScreen(node) {
    return {
      x: state.transform.x + node.x * state.transform.k,
      y: state.transform.y + node.y * state.transform.k,
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
    if (state.filtered) fitVisible();
    else requestRender();
  }

  function drawGrid() {
    context.fillStyle = css("--canvas");
    context.fillRect(0, 0, state.width, state.height);
    context.fillStyle = css("--canvas-grid");
    const spacing = Math.max(34, Math.min(58, state.transform.k / 5));
    const startX = ((state.transform.x % spacing) + spacing) % spacing;
    const startY = ((state.transform.y % spacing) + spacing) % spacing;
    for (let x = startX; x < state.width; x += spacing) {
      for (let y = startY; y < state.height; y += spacing) {
        context.beginPath();
        context.arc(x, y, 1, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function renderGraph() {
    drawGrid();
    if (!state.filtered) return;
    const selectedId = state.view.selectedId;
    const emphasisId = selectedId || state.hoveredId;
    const neighborIds = new Set([emphasisId]);
    if (emphasisId) {
      for (const edge of state.filtered.edges) {
        if (edge.source === emphasisId) neighborIds.add(edge.target);
        if (edge.target === emphasisId) neighborIds.add(edge.source);
      }
    }
    context.lineCap = "round";
    for (const edge of [...state.filtered.edges].reverse()) {
      const source = state.filtered.nodeById.get(edge.source);
      const target = state.filtered.nodeById.get(edge.target);
      if (!source || !target) continue;
      const sourcePoint = worldToScreen(source);
      const targetPoint = worldToScreen(target);
      const highlighted =
        !emphasisId || edge.source === emphasisId || edge.target === emphasisId;
      const ratio = Math.log1p(edge.count) / Math.log1p(state.filtered.maximumEdgeCount);
      context.globalAlpha = emphasisId ? (highlighted ? 0.9 : 0.075) : 0.35 + ratio * 0.28;
      context.strokeStyle = highlighted && emphasisId ? css("--accent") : css("--canvas-edge-strong");
      context.lineWidth = 0.65 + ratio * 3.5;
      context.beginPath();
      context.moveTo(sourcePoint.x, sourcePoint.y);
      context.lineTo(targetPoint.x, targetPoint.y);
      context.stroke();
    }

    const ranked = [...state.filtered.nodes]
      .filter((node) => node.degree > 0)
      .sort((left, right) => right.strength - left.strength || right.degree - left.degree);
    const labelIds = new Set(ranked.slice(0, state.transform.k > 500 ? 14 : 8).map((node) => node.id));
    if (selectedId) labelIds.add(selectedId);
    if (state.hoveredId) labelIds.add(state.hoveredId);

    for (const node of state.filtered.nodes) {
      const point = worldToScreen(node);
      if (point.x < -20 || point.x > state.width + 20 || point.y < -20 || point.y > state.height + 20) {
        continue;
      }
      const radius = nodeRadius(node);
      const related = !emphasisId || neighborIds.has(node.id);
      context.globalAlpha = related ? (node.degree ? 0.94 : 0.42) : 0.13;
      context.fillStyle = node.degree
        ? departmentColor(node.primary_department)
        : css("--canvas-unconnected");
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.lineWidth = node.id === selectedId ? 2.4 : node.id === state.hoveredId ? 1.7 : 0.8;
      context.strokeStyle =
        node.id === selectedId || node.id === state.hoveredId
          ? css("--canvas-selected")
          : colorWithAlpha(css("--canvas-selected"), 0.45);
      context.stroke();
    }
    context.globalAlpha = 1;

    const occupied = [];
    const nodesForLabels = state.filtered.nodes
      .filter((node) => labelIds.has(node.id))
      .sort((left, right) => {
        const leftPriority = left.id === selectedId ? 2 : left.id === state.hoveredId ? 1 : 0;
        const rightPriority = right.id === selectedId ? 2 : right.id === state.hoveredId ? 1 : 0;
        return rightPriority - leftPriority || right.strength - left.strength;
      });
    for (const node of nodesForLabels) {
      drawNodeLabel(node, occupied, node.id === selectedId || node.id === state.hoveredId);
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

  function drawNodeLabel(node, occupied, force) {
    const point = worldToScreen(node);
    context.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
    const width = Math.ceil(context.measureText(node.name).width) + 13;
    const height = 22;
    const radius = nodeRadius(node);
    const rect = {
      x: point.x + radius + 5,
      y: point.y - height / 2,
      width,
      height,
    };
    if (
      !force &&
      occupied.some(
        (other) =>
          rect.x < other.x + other.width + 3 &&
          rect.x + rect.width + 3 > other.x &&
          rect.y < other.y + other.height + 3 &&
          rect.y + rect.height + 3 > other.y,
      )
    ) {
      return;
    }
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
    for (const node of state.filtered?.nodes || []) {
      const point = worldToScreen(node);
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
    const departmentNames = node.departments
      .map((id) => state.graph.departmentById.get(id)?.short_title || id)
      .join(" · ");
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

  function selectFaculty(nodeId, { openDetails = true, focus = false } = {}) {
    if (!state.graph.nodeById.has(nodeId)) return;
    state.view.selectedId = state.view.selectedId === nodeId && !focus ? "" : nodeId;
    state.expandedEdgeId = "";
    applyView();
    if (state.view.selectedId) {
      focusSelected();
      if (openDetails && window.matchMedia("(max-width: 820px)").matches) {
        openMobilePanel("detail");
      }
    }
  }

  function renderDetails() {
    const nodeId = state.view?.selectedId;
    const node = nodeId ? state.graph.nodeById.get(nodeId) : null;
    if (!node) {
      elements.detailContent.hidden = true;
      elements.detailEmpty.hidden = false;
      elements.toggleDetails.disabled = !state.graph;
      return;
    }
    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.detailContent.replaceChildren();
    const filteredNode = state.filtered.nodeById.get(nodeId) || { ...node, degree: 0, strength: 0 };
    const connections = core.connectionsForNode(state.filtered, nodeId);

    const header = element("header", "detail-header");
    header.append(element("p", "eyebrow", "Selected faculty"), element("h2", "detail-name", node.name));
    const departmentList = element("div", "detail-departments");
    for (const departmentId of node.departments) {
      const department = state.graph.departmentById.get(departmentId);
      const chip = element("span", "department-chip");
      chip.style.setProperty("--dot", departmentColor(departmentId));
      chip.append(element("i"), document.createTextNode(department?.short_title || departmentId));
      departmentList.append(chip);
    }
    header.append(departmentList);
    const links = element("div", "detail-links");
    for (const [label, url] of [
      ["Homepage ↗", node.homepage_url],
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

    const metrics = element("div", "detail-metrics");
    for (const [value, label] of [
      [filteredNode.degree, "visible collaborators"],
      [filteredNode.strength, "pair–work records"],
      [node.mapped_publication_count, "mapped works"],
    ]) {
      const metric = element("div", "detail-metric");
      metric.append(element("strong", "", formatNumber(value)), element("span", "", label));
      metrics.append(metric);
    }
    elements.detailContent.append(metrics);

    const heading = element("div", "collaborator-heading");
    heading.append(
      element("h3", "", "Observed collaborators"),
      element("span", "", connections.length ? "Select a row for evidence" : "Current view"),
    );
    elements.detailContent.append(heading);
    if (!connections.length) {
      elements.detailContent.append(
        element(
          "p",
          "detail-no-links",
          node.mapped_publication_count
            ? "No connections meet the current year, department, and strength filters."
            : "No mapped publications are available for this faculty member in the source artifact.",
        ),
      );
      return;
    }

    const list = element("div", "collaborator-list");
    for (const connection of connections) {
      const collaborator = state.graph.nodeById.get(connection.collaboratorId);
      const card = element("article", "collaborator-card");
      const button = element("button", "collaborator-button");
      button.type = "button";
      button.dataset.edgeId = connection.id;
      button.setAttribute("aria-expanded", String(state.expandedEdgeId === connection.id));
      const dot = element("span", "legend-dot");
      dot.style.setProperty("--dot", departmentColor(collaborator.primary_department));
      dot.setAttribute("aria-hidden", "true");
      button.append(
        dot,
        element("strong", "", collaborator.name),
        element("span", "", `${connection.count} ${connection.count === 1 ? "work" : "works"}`),
      );
      card.append(button);
      if (state.expandedEdgeId === connection.id) {
        card.append(renderPublications(connection));
      }
      list.append(card);
    }
    elements.detailContent.append(list);
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
        work.citations ? `${formatNumber(work.citations)} citations` : "",
      ].filter(Boolean);
      item.append(element("span", "publication-meta", details.join(" · ")));
      list.append(item);
    }
    return list;
  }

  function renderSuggestions() {
    const query = elements.facultySearch.value;
    state.suggestionNodes = core.facultyMatches(state.graph, query, 9);
    state.activeSuggestion = state.suggestionNodes.length ? 0 : -1;
    elements.facultySuggestions.replaceChildren();
    if (!query.trim()) {
      closeSuggestions();
      return;
    }
    if (!state.suggestionNodes.length) {
      const empty = element("li", "suggestion-empty", "No faculty match this search.");
      elements.facultySuggestions.append(empty);
    } else {
      state.suggestionNodes.forEach((node, index) => {
        const item = element("li");
        item.setAttribute("role", "option");
        const button = element("button");
        button.type = "button";
        button.dataset.facultyId = node.id;
        button.setAttribute("aria-selected", String(index === state.activeSuggestion));
        const department = node.departments
          .map((id) => state.graph.departmentById.get(id)?.short_title || id)
          .join(" · ");
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
    elements.facultySearch.value = node.name;
    closeSuggestions();
    selectFaculty(node.id, { openDetails: true, focus: true });
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
    link.download = "cmu-engineering-collaborations.csv";
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
      syncControls();
      requestRender();
    });
    window.addEventListener("popstate", () => {
      if (!state.graph) return;
      state.view = core.stateFromSearch(window.location.search, state.graph);
      syncControls();
      applyView({ fit: true, updateUrl: false });
    });

    elements.canvas.addEventListener("pointerdown", (event) => {
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
      else if (event.key === "0" || event.key === "Home") fitVisible();
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
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".faculty-field")) closeSuggestions();
    });

    elements.departmentOptions.addEventListener("change", () => {
      state.view.departments = [...elements.departmentOptions.querySelectorAll("input:checked")].map(
        (input) => input.value,
      );
      applyView({ fit: true });
    });
    elements.departmentLegend.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-department-id]");
      if (!button) return;
      state.view.departments = [button.dataset.departmentId];
      syncControls();
      applyView({ fit: true });
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
        applyView({ fit: true });
      });
    });
    elements.strength.addEventListener("input", () => {
      state.view.minimum = Number(elements.strength.value);
      elements.strengthOutput.textContent = `${state.view.minimum}+ shared ${
        state.view.minimum === 1 ? "work" : "works"
      }`;
      applyView();
    });
    elements.crossDepartment.addEventListener("change", () => {
      state.view.crossDepartment = elements.crossDepartment.checked;
      applyView({ fit: true });
    });
    elements.showUnconnected.addEventListener("change", () => {
      state.view.showUnconnected = elements.showUnconnected.checked;
      applyView({ fit: true });
    });
    elements.detailContent.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edge-id]");
      if (!button) return;
      state.expandedEdgeId =
        state.expandedEdgeId === button.dataset.edgeId ? "" : button.dataset.edgeId;
      renderDetails();
    });

    elements.clear.addEventListener("click", resetFilters);
    elements.fit.addEventListener("click", fitVisible);
    elements.reset.addEventListener("click", resetFilters);
    elements.zoomFit.addEventListener("click", fitVisible);
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
