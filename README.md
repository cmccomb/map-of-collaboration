# CMU Faculty Collaborations

[![Deploy collaboration graph](https://github.com/cmccomb/map-of-collaboration/actions/workflows/deploy.yml/badge.svg)](https://github.com/cmccomb/map-of-collaboration/actions/workflows/deploy.yml)
[![Live site](https://img.shields.io/website?url=https%3A%2F%2Fcmccomb.github.io%2Fmap-of-collaboration%2F&label=live%20site)](https://cmccomb.github.io/map-of-collaboration/)
[![Line coverage: 98.62%](https://img.shields.io/badge/line%20coverage-98.62%25-brightgreen)](#checks)
[![License: MIT](https://img.shields.io/github/license/cmccomb/map-of-collaboration)](LICENSE)

An interactive coauthorship graph built from the canonical
[`ccm/cmu-engineering-publications`](https://huggingface.co/datasets/ccm/cmu-engineering-publications)
artifact maintained by
[`cmccomb/map-of-research`](https://github.com/cmccomb/map-of-research).

Each faculty node is a cataloged CMU faculty member. An edge connects two
faculty members when the source artifact associates both stable faculty IDs
with the same deduplicated work. Edge thickness is the number of shared works
in the selected year range. One or more faculty members can be selected to
compare the union of their visible collaboration neighborhoods and inspect the
publications behind every displayed connection.

The default layout emphasizes the overall collaboration structure. Two
shareable department views make links between groups easier to trace: an
organic force layout with tunable cross-department and cross-school/college distance,
and a compact grid that keeps affiliation clusters aligned. The source registry's
reviewed or inferred primary department sets each faculty node's color and
default layout group. With a department or school filter active, faculty admitted
through a secondary appointment join that selected group's layout cluster but
retain their primary-department color. People without a supported primary remain
neutral and have their own unresolved layout group.

A school selection limits CMU faculty and collaborations to the selected schools
in every layout. Department controls and the color key show those schools'
departments. Cross-appointed faculty remain visible when one of their school
memberships is selected, and take the color and layout group of a selected-school
department. The optional Erdős node remains available for an observed link to a
selected-school faculty member.

The department force layout keeps its previous default (department distance
`3`) and offers levels `1`–`10`. School and college are the same top-level
grouping in this map. Cross-school/college distance has a separate `0`–`10`
control, with `0` neutral by default. At larger values, Engineering, MCS, and
SCS each have a separate layout anchor. A cross-appointed faculty member uses
one display group in the whole-CMU layout; the less populated exclusively
affiliated school gets that member. Selecting a school or college places the
member in the selected unit instead. This display choice does not change the
underlying appointments, filters, or coauthorship links. External coauthors
have no CMU school or college. The shareable URL stores nondefault values as
`spacing` and `school_spacing`.

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

The current 43-test suite reports **98.62% line coverage**, **92.55% branch
coverage**, and **98.71% function coverage** across the instrumented graph
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

## School coverage

The graph builder also accepts additive school fields in the publication
artifact: `catalogs.schools` with `school_id`, `title`, and `directory_url`;
`catalogs.departments[].school_id`; and `catalogs.faculty[].school_ids`.
`points[].school_ids` may be present for provenance. CMU faculty coauthorship
still comes only from shared `points[].faculty_ids`. Existing Engineering-only
artifacts without school fields resolve to one `engineering` school.

The builder reads `catalogs.faculty[].primary_department_id` from the canonical
publication artifact. A blank value stays unresolved, even if a person has a
single included campus membership. For older artifacts without that field, the
builder derives a primary only when there is exactly one academic department;
multiple memberships and the Silicon Valley campus alone remain unresolved.
All included memberships continue to drive search, department filters, and
cross-department edge classification. The source registry's basis and evidence
URL appear in the faculty detail panel when available.

`?schools=scs` shows a CMU faculty edge only when **both** endpoints belong to
SCS, in every layout. The optional historical coauthor can appear through a
selected-school faculty link when enabled. Existing `?departments=`
links keep their original rule for faculty pairs: both endpoints must belong to
a selected department or program. `?cross_school=1` selects faculty pairs with
no school in common; this is separate from the existing cross-department filter.

## Verified historical coauthors

The publication artifact may supply `catalogs.external_coauthors` with a
stable `person_id`, name, and public coauthor source URL. A publication point
may name one of these IDs in `external_coauthor_ids` only when it also has a
`curated_verified` source type and a public paper-level verification URL. The
builder adds an external node and a coauthorship edge only for those exact work
relationships. It does not infer identities from free-text author lists.

External coauthors have no CMU school, department, or faculty role. They remain
separate from CMU faculty and school counts. The current pilot catalogs only
Paul Erdős as an external historical coauthor; it does not index every outside
collaborator. An MCS school or Mathematical Sciences department filter retains
Tetali because he belongs to the selected group. The Tetali–Erdős edge appears
when **Show Erdős** is turned on; the toggle is off by default and can be
shared with `?external=1`. The edge is not classified as cross-school or
cross-department. The graph retains publisher and institutional verification
links on shared works and labels the external node in search, details, the
color key, and CSV export. The normal Engineering artifact, which has no
external coauthor catalog, keeps its original behavior.

The first public graph covered Engineering. The staged CMU registry adds SCS and
MCS faculty to that roster; publication coverage will grow department by
department, starting with Mathematical Sciences. The Hugging Face dataset ID
retains its Engineering name for this rollout. The graph shows only
coauthorship observed in indexed works, even when a faculty roster is broader.
