"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CollaborationCore = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const GRAPH_SCHEMA_VERSION = 1;
  const SAFE_PROTOCOLS = new Set(["https:", "http:"]);

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
        directory_url: safeExternalUrl(department.directory_url),
        color_dark: String(department.color_dark || "#73c5df"),
        color_light: String(department.color_light || "#197b99"),
        faculty_count: Math.max(0, integer(department.faculty_count)),
      };
    });

    const nodeIds = new Set();
    const nodes = input.nodes.map((node) => {
      const id = String(node.id || "");
      assert(id && !nodeIds.has(id), `Invalid or duplicate faculty ID: ${id}`);
      nodeIds.add(id);
      const departmentsForNode = uniqueStrings(node.departments).filter((item) =>
        departmentIds.has(item),
      );
      assert(departmentsForNode.length > 0, `Faculty ${id} has no valid department`);
      assert(Number.isFinite(node.x) && Number.isFinite(node.y), `Faculty ${id} has no position`);
      return {
        id,
        name: String(node.name || id),
        departments: departmentsForNode,
        primary_department: departmentIds.has(node.primary_department)
          ? node.primary_department
          : departmentsForNode[0],
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
          topic: String(work.topic || ""),
        };
      });
      return {
        id: key,
        source,
        target,
        cross_department: Boolean(edge.cross_department),
        works,
      };
    });

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
      nodes,
      edges,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
      departmentById: new Map(
        departments.map((department) => [department.department_id, department]),
      ),
      edgeById: new Map(edges.map((edge) => [edge.id, edge])),
    };
  }

  function defaultState(graph) {
    return {
      departments: [],
      fromYear: graph.years.minimum,
      toYear: graph.years.maximum,
      minimum: 1,
      crossDepartment: false,
      showUnconnected: false,
      selectedId: "",
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function stateFromSearch(search, graph) {
    const defaults = defaultState(graph);
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const allowedDepartments = new Set(graph.departments.map((item) => item.department_id));
    const departments = uniqueStrings((params.get("departments") || "").split(","))
      .filter(Boolean)
      .filter((id) => allowedDepartments.has(id));
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
    const selectedId = graph.nodeById.has(params.get("faculty"))
      ? params.get("faculty")
      : "";
    return {
      departments,
      fromYear,
      toYear,
      minimum: clamp(integer(params.get("minimum"), 1), 1, 20),
      crossDepartment: params.get("cross") === "1",
      showUnconnected: params.get("unconnected") === "1",
      selectedId,
    };
  }

  function stateToSearch(state, graph) {
    const defaults = defaultState(graph);
    const params = new URLSearchParams();
    if (state.departments?.length) params.set("departments", [...state.departments].sort().join(","));
    if (state.fromYear !== defaults.fromYear) params.set("from", String(state.fromYear));
    if (state.toYear !== defaults.toYear) params.set("to", String(state.toYear));
    if (state.minimum !== 1) params.set("minimum", String(state.minimum));
    if (state.crossDepartment) params.set("cross", "1");
    if (state.showUnconnected) params.set("unconnected", "1");
    if (state.selectedId && graph.nodeById.has(state.selectedId)) {
      params.set("faculty", state.selectedId);
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
    const selectedDepartments = new Set(state.departments || []);
    const candidateIds = new Set(
      graph.nodes
        .filter((node) => nodeMatchesDepartments(node, selectedDepartments))
        .map((node) => node.id),
    );
    const filteredEdges = [];
    const visibleIds = new Set();
    const visibleWorkIds = new Set();
    const metrics = new Map(
      graph.nodes.map((node) => [node.id, { degree: 0, strength: 0 }]),
    );

    for (const edge of graph.edges) {
      if (!candidateIds.has(edge.source) || !candidateIds.has(edge.target)) continue;
      if (state.crossDepartment && !edge.cross_department) continue;
      const works = edge.works.filter((work) => includesYear(work, state, graph));
      if (works.length < state.minimum) continue;
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
      candidateIds.forEach((id) => visibleIds.add(id));
    }
    if (state.selectedId && graph.nodeById.has(state.selectedId)) {
      visibleIds.add(state.selectedId);
    }

    const nodes = graph.nodes
      .filter((node) => visibleIds.has(node.id))
      .map((node) => ({ ...node, ...metrics.get(node.id) }));
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

  function facultyMatches(graph, query, limit = 10) {
    const normalized = String(query || "").trim().toLocaleLowerCase();
    if (!normalized) return [];
    const terms = normalized.split(/\s+/).filter(Boolean);
    return graph.nodes
      .map((node) => {
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

  function layoutHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
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

  function simulateLayout(filtered, seed) {
    const nodes = filtered.nodes;
    const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
    const x = nodes.map((node) => seed.get(node.id).x);
    const y = nodes.map((node) => seed.get(node.id).y);
    const dx = new Float64Array(nodes.length);
    const dy = new Float64Array(nodes.length);
    const edgePairs = filtered.edges
      .map((edge) => ({
        source: nodeIndex.get(edge.source),
        target: nodeIndex.get(edge.target),
        weight: 0.82 + Math.log1p(edge.count || 1) * 0.16,
      }))
      .filter((edge) => edge.source !== undefined && edge.target !== undefined);
    const spacing = Math.max(0.12, 2.25 / Math.sqrt(Math.max(1, nodes.length)));
    const iterations = nodes.length <= 55 ? 220 : nodes.length <= 140 ? 165 : 115;

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
          const force = (spacing * spacing) / distance;
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
        const force = ((distance * distance) / spacing) * edge.weight;
        const forceX = (deltaX / distance) * force;
        const forceY = (deltaY / distance) * force;
        dx[edge.source] -= forceX;
        dy[edge.source] -= forceY;
        dx[edge.target] += forceX;
        dy[edge.target] += forceY;
      }

      const progress = iteration / Math.max(1, iterations - 1);
      const temperature = 0.17 * Math.pow(1 - progress, 1.55) + 0.002;
      for (let index = 0; index < nodes.length; index += 1) {
        dx[index] -= x[index] * 0.12;
        dy[index] -= y[index] * 0.12;
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

  function selectionLayout(filtered, nodeId) {
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
    const rows = [
      [
        "faculty_1",
        "faculty_2",
        "shared_works",
        "earliest_year",
        "latest_year",
        "cross_department",
      ],
    ];
    for (const edge of filtered.edges) {
      const years = edge.works.map((work) => work.year).filter(Number.isInteger);
      rows.push([
        graph.nodeById.get(edge.source)?.name || edge.source,
        graph.nodeById.get(edge.target)?.name || edge.target,
        edge.count,
        years.length ? Math.min(...years) : "",
        years.length ? Math.max(...years) : "",
        edge.cross_department ? "yes" : "no",
      ]);
    }
    return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  }

  return Object.freeze({
    GRAPH_SCHEMA_VERSION,
    collaborationLayout,
    connectionsForNode,
    defaultState,
    doiUrl,
    edgeKey,
    edgeCrossingCount,
    edgesToCsv,
    facultyMatches,
    filterGraph,
    parseGraph,
    safeExternalUrl,
    selectionLayout,
    stateFromSearch,
    stateToSearch,
  });
});
