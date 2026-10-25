"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const core = require("../assets/collaboration-core.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "assets/collaboration.js"), "utf8");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const colors = {
  "--canvas": "#canvas",
  "--canvas-grid": "#grid",
  "--canvas-edge-strong": "#edge",
  "--canvas-school-fill": "#school-fill",
  "--canvas-school-outline": "#school-outline",
  "--canvas-selected": "#selected",
  "--canvas-unconnected": "#unconnected",
  "--tooltip": "#tooltip",
  "--text": "#text",
  "--line": "#line",
  "--primary-unresolved": "#unresolved",
  "--accent": "#accent",
  "--accent-strong": "#accent-strong",
  "--warm": "#warm",
};

function graphFixture() {
  return {
    schema_version: 1,
    title: "CMU fixture",
    generated_at_utc: "2026-10-25T00:00:00Z",
    source: {
      dataset_revision: "a".repeat(40),
      source_data_newest_at_utc: "2026-10-24T00:00:00Z",
    },
    quality: { coverage_note: "Fixture coverage" },
    counts: {
      faculty_count: 2,
      mapped_faculty_count: 2,
      unmapped_faculty_count: 0,
      edge_count: 1,
    },
    years: { minimum: 2020, maximum: 2024, missing_count: 0 },
    schools: [
      { school_id: "engineering", title: "College of Engineering" },
      { school_id: "scs", title: "School of Computer Science" },
    ],
    departments: [
      {
        department_id: "one", school_id: "engineering", unit_type: "department",
        title: "Department One", short_title: "One", color_dark: "#aa1111",
      },
      {
        department_id: "two", school_id: "scs", unit_type: "department",
        title: "Department Two", short_title: "Two", color_dark: "#bb2222",
      },
    ],
    nodes: [
      {
        id: "a", name: "Ada Alpha", departments: ["one"], school_ids: ["engineering"],
        primary_department: "one", x: -0.5, y: 0, mapped_publication_count: 1,
      },
      {
        id: "b", name: "Bela Beta", departments: ["two"], school_ids: ["scs"],
        primary_department: "two", x: 0.5, y: 0, mapped_publication_count: 1,
      },
    ],
    edges: [{
      source: "a", target: "b", cross_department: true, cross_school: true,
      works: [{ id: "w1", title: "Shared work", year: 2023, citations: 1 }],
    }],
  };
}

class MockElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {} };
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.className = "";
  }

  append(...children) {
    for (const child of children) {
      const item = typeof child === "string" ? new MockElement("#text") : child;
      if (!item) continue;
      item.parent = this;
      this.children.push(item);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) {
      listener({ target: this, preventDefault() {}, ...event });
    }
  }

  matches(selector) {
    if (selector === "input") return this.tagName === "input";
    if (selector === "input:checked") return this.tagName === "input" && this.checked;
    if (selector === "button") return this.tagName === "button";
    if (selector === "button[data-department-id]") {
      return this.tagName === "button" && Boolean(this.dataset.departmentId);
    }
    if (selector === 'input[name="graph-layout"]') {
      return this.tagName === "input" && this.name === "graph-layout";
    }
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    return false;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1100, height: 760 }; }
  focus() {}
}

function makeCanvasContext() {
  const calls = [];
  const context = { calls, strokeStyle: "", fillStyle: "" };
  for (const method of [
    "setTransform", "fillRect", "beginPath", "arc", "arcTo", "closePath", "moveTo", "lineTo",
  ]) {
    context[method] = (...args) => calls.push({ method, args });
  }
  context.fill = () => calls.push({ method: "fill", color: context.fillStyle });
  context.stroke = () => calls.push({ method: "stroke", color: context.strokeStyle });
  context.fillText = (value) => calls.push({ method: "fillText", value });
  context.measureText = (value) => ({ width: String(value).length * 7 });
  return context;
}

async function openMap(search) {
  const elements = new Map();
  const context = makeCanvasContext();
  const errors = [];
  const frames = [];
  let copiedUrl = "";
  const url = new URL(`https://example.test/map-of-collaboration/${search}`);
  const elementFor = (selector) => {
    const id = selector.match(/^#([\w-]+)/)?.[1];
    if (id) assert.ok(htmlIds.has(id), `Missing UI control #${id} in index.html`);
    if (!elements.has(selector)) elements.set(selector, new MockElement(selector === "#graph-canvas" ? "canvas" : "div"));
    return elements.get(selector);
  };
  const layoutOptions = elementFor("#layout-options");
  for (const tag of html.matchAll(/<input\b[^>]*name="graph-layout"[^>]*>/gs)) {
    const value = tag[0].match(/\bvalue="([^"]+)"/)?.[1];
    assert.ok(value, "Layout radio is missing a value");
    const input = new MockElement("input");
    input.name = "graph-layout";
    input.value = value;
    layoutOptions.append(input);
  }
  assert.deepEqual(layoutOptions.querySelectorAll("input").map((input) => input.value), [
    "collaboration", "department-force", "departments",
  ]);
  const canvas = elementFor("#graph-canvas");
  canvas.getContext = () => context;
  const document = {
    documentElement: { dataset: { resolvedTheme: "dark" } },
    body: new MockElement("body"),
    addEventListener() {},
    querySelector: elementFor,
    querySelectorAll: () => [],
    createElement: (tag) => new MockElement(tag),
    createTextNode: (value) => Object.assign(new MockElement("#text"), { textContent: value }),
  };
  const window = {
    location: url,
    history: { replaceState(_state, _unused, next) { window.location = new URL(next, url.origin); } },
    matchMedia: (query) => ({ matches: query.includes("prefers-reduced-motion") }),
    addEventListener() {},
    clearTimeout() {},
    setTimeout() { return 1; },
    devicePixelRatio: 1,
    innerWidth: 1100,
    innerHeight: 760,
  };
  const sandbox = {
    CollaborationCore: core,
    document,
    window,
    navigator: { clipboard: { async writeText(value) { copiedUrl = value; } } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
    requestAnimationFrame(callback) { frames.push(callback); },
    getComputedStyle: () => ({ getPropertyValue: (name) => colors[name] || "#other" }),
    fetch: async (request) => ({
      ok: true,
      json: async () => request === "map-config.json"
        ? { graph_artifact: `data/collaborations.${"a".repeat(40)}.json` }
        : graphFixture(),
    }),
    performance: { now: () => 1000 },
    console: { error(error) { errors.push(error); } },
  };
  vm.runInNewContext(script, sandbox, { filename: "assets/collaboration.js" });
  await new Promise(setImmediate);
  assert.deepEqual(errors, [], `Graph failed to load: ${errors.join(", ")}`);
  assert.notEqual(elementFor("#graph-status").textContent,
    "The collaboration graph is unavailable right now.");
  function paint() {
    context.calls.length = 0;
    for (let attempts = 0; frames.length && attempts < 10; attempts += 1) {
      frames.splice(0).forEach((callback) => callback());
    }
    assert.equal(frames.length, 0, "Canvas repaint did not settle");
    return context.calls.slice();
  }
  return {
    elementFor, layoutOptions, window, paint,
    get copiedUrl() { return copiedUrl; },
  };
}

function rendered(calls) {
  const count = (method, color) => calls.filter((call) =>
    call.method === method && call.color === color).length;
  const text = calls.filter((call) => call.method === "fillText").map((call) => call.value);
  return {
    schoolFill: count("fill", colors["--canvas-school-fill"]),
    schoolStroke: count("stroke", colors["--canvas-school-outline"]),
    schoolText: text.filter((value) => ["College of Engineering", "School of Computer Science"].includes(value)),
    homeStroke: calls.filter((call) =>
      call.method === "stroke" && ["#aa1111", "#bb2222"].includes(call.color)).length,
    homeText: text.filter((value) => ["One", "Two"].includes(value)),
    edges: count("stroke", colors["--canvas-edge-strong"]),
    nodeColors: calls.filter((call) => call.method === "fill"
      && ["#aa1111", "#bb2222"].includes(call.color)).map((call) => call.color).sort(),
  };
}

test("Display toggles control outline and label pairs independently in both Home layouts", async () => {
  for (const layout of ["department-force", "departments"]) {
    let baseline;
    for (const showSchool of [true, false]) {
      for (const showHome of [true, false]) {
        const params = new URLSearchParams({ layout });
        if (!showSchool) params.set("school_outlines", "0");
        if (!showHome) params.set("home_outlines", "0");
        const page = await openMap(`?${params}`);
        const schoolControl = page.elementFor("#show-school-outlines");
        const homeControl = page.elementFor("#show-home-outlines");
        assert.equal(schoolControl.checked, showSchool);
        assert.equal(homeControl.checked, showHome);
        assert.equal(page.elementFor("#school-outline-row").hidden,
          layout !== "department-force");
        const picture = rendered(page.paint());
        const schoolVisible = layout === "department-force" && showSchool;
        assert.equal(picture.schoolFill > 0, schoolVisible, `${layout}: school box`);
        assert.equal(picture.schoolStroke > 0, schoolVisible, `${layout}: school border`);
        assert.equal(picture.schoolText.length > 0, schoolVisible, `${layout}: school label`);
        assert.equal(picture.homeStroke > 0, showHome, `${layout}: home box`);
        assert.equal(picture.homeText.length > 0, showHome, `${layout}: home label`);
        const graphMarks = { edges: picture.edges, nodeColors: picture.nodeColors };
        baseline ||= graphMarks;
        assert.deepEqual(graphMarks, baseline, `${layout}: toggles changed graph marks`);
        assert.equal(picture.edges, 1);
        assert.deepEqual(picture.nodeColors, ["#aa1111", "#bb2222"]);
      }
    }
  }
});

test("Display handlers update copied URLs while Reset preserves and Clear restores toggles", async () => {
  const page = await openMap("?layout=department-force&school_spacing=10");
  page.paint();
  const school = page.elementFor("#show-school-outlines");
  const home = page.elementFor("#show-home-outlines");
  school.checked = false;
  school.dispatch("change");
  home.checked = false;
  home.dispatch("change");
  let picture = rendered(page.paint());
  assert.equal(picture.schoolFill, 0);
  assert.equal(picture.schoolText.length, 0);
  assert.equal(picture.homeStroke, 0);
  assert.equal(picture.homeText.length, 0);
  assert.equal(picture.edges, 1);
  assert.deepEqual(picture.nodeColors, ["#aa1111", "#bb2222"]);
  const changedUrl = new URLSearchParams(page.window.location.search);
  assert.equal(changedUrl.get("layout"), "department-force");
  assert.equal(changedUrl.get("school_outlines"), "0");
  assert.equal(changedUrl.get("home_outlines"), "0");
  assert.equal(changedUrl.get("school_spacing"), "10");
  page.elementFor("#copy-view").dispatch("click");
  await new Promise(setImmediate);
  assert.equal(page.copiedUrl, page.window.location.href);

  page.elementFor("#reset-view").dispatch("click");
  picture = rendered(page.paint());
  assert.equal(school.checked, false);
  assert.equal(home.checked, false);
  assert.equal(picture.schoolFill, 0);
  assert.equal(picture.homeStroke, 0);
  assert.equal(page.window.location.search, `?${changedUrl}`);

  page.elementFor("#clear-filters").dispatch("click");
  page.paint();
  assert.equal(page.window.location.search, "");
  assert.equal(school.checked, true);
  assert.equal(home.checked, true);
  assert.equal(page.elementFor("#outline-controls").hidden, true);
  const homeForce = page.layoutOptions.querySelectorAll("input")
    .find((input) => input.value === "department-force");
  page.layoutOptions.dispatch("change", { target: homeForce });
  picture = rendered(page.paint());
  assert.ok(picture.schoolFill > 0);
  assert.ok(picture.schoolText.length > 0);
  assert.ok(picture.homeStroke > 0);
  assert.ok(picture.homeText.length > 0);
});

test("single-school focus hides the college box toggle but keeps home boxes available", async () => {
  const page = await openMap("?layout=department-force&schools=engineering");
  assert.equal(page.elementFor("#outline-controls").hidden, false);
  assert.equal(page.elementFor("#school-outline-row").hidden, true);
  assert.equal(page.elementFor("#show-home-outlines").checked, true);
});
