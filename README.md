# CMU Engineering Collaborations

[![Deploy collaboration graph](https://github.com/cmccomb/map-of-collaboration/actions/workflows/deploy.yml/badge.svg)](https://github.com/cmccomb/map-of-collaboration/actions/workflows/deploy.yml)
[![Live site](https://img.shields.io/website?url=https%3A%2F%2Fcmccomb.github.io%2Fmap-of-collaboration%2F&label=live%20site)](https://cmccomb.github.io/map-of-collaboration/)
[![Line coverage: 98.44%](https://img.shields.io/badge/line%20coverage-98.44%25-brightgreen)](#checks)
[![License: MIT](https://img.shields.io/github/license/cmccomb/map-of-collaboration)](LICENSE)

An interactive coauthorship graph built from the canonical
[`ccm/cmu-engineering-publications`](https://huggingface.co/datasets/ccm/cmu-engineering-publications)
artifact maintained by
[`cmccomb/map-of-research`](https://github.com/cmccomb/map-of-research).

Each node is a cataloged CMU Engineering faculty member. An edge connects two
faculty members when the source artifact associates both stable faculty IDs
with the same deduplicated work. Edge thickness is the number of shared works
in the selected year range. One or more faculty members can be selected to
compare the union of their visible collaboration neighborhoods and inspect the
publications behind every displayed connection.

The default layout emphasizes the overall collaboration structure. Two
shareable department views make links between groups easier to trace: an
organic force layout with tunable cross-department distance, and a compact grid
that keeps affiliation clusters aligned. With department filters active,
faculty admitted through a secondary appointment join a selected affiliation's
layout cluster while retaining their primary-affiliation color.

## What this graph does—and does not—show

The graph shows **observed coauthorship within the cataloged faculty set**. It
does not infer collaboration from topical similarity, shared affiliations, or
physical proximity. A missing edge is not proof that two people have never
collaborated: faculty without a verified Scholar profile, works omitted by the
source quality policy, and publications absent from the collected profiles are
not represented.

The build validates work-key uniqueness and faculty-reference integrity before
creating the graph. It records coverage and missing-year counts in the deployed
artifact so the interface can state its limits precisely.

## Local preview

The build resolves the current Hugging Face dataset revision, derives the graph,
and stages a same-origin static site in `_site/`.

```bash
npm run build
python -m http.server 8000 --directory _site
```

Then open <http://localhost:8000>.

## Checks

```bash
npm run check
npm test
```

The current 28-test suite reports **98.44% line coverage**, **92.36% branch
coverage**, and **97.85% function coverage** across the instrumented graph
logic and site-build pipeline. The test command enforces a 90% minimum for all
three measures.

## Deployment

GitHub Actions validates, builds, and deploys the site to GitHub Pages. A daily
run checks the upstream immutable dataset revision and skips deployment when the
published graph is already current. Manual runs are available from the Actions
tab.

## Data provenance

The browser never contacts Google Scholar or Hugging Face. The Pages build pins
an immutable Hugging Face revision, derives `data/collaborations.json`, and
ships that compact artifact with the site. The source publication artifact is
not committed here.

## School-aware pilot contract

The graph builder also accepts additive school fields in the publication
artifact: `catalogs.schools` with `school_id`, `title`, and `directory_url`;
`catalogs.departments[].school_id`; and `catalogs.faculty[].school_ids`.
`points[].school_ids` may be present for provenance, while coauthorship still
comes only from shared `points[].faculty_ids`. Existing Engineering-only
artifacts without school fields resolve to one `engineering` school.

`?schools=scs` shows an observed edge when **either** endpoint belongs to SCS,
so collaborators in another school remain visible. Existing `?departments=`
links keep their original rule: both endpoints must belong to a selected
department or program. `?cross_school=1` selects pairs with no school in
common; this is separate from the existing cross-department filter.

The committed `map-config.json` remains pointed at the published Engineering
dataset. A school pilot requires a separately reviewed publication artifact
and a preview build before changing the public source.
