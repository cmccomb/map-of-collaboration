# CMU Engineering Collaborations

An interactive coauthorship graph built from the canonical
[`ccm/cmu-engineering-publications`](https://huggingface.co/datasets/ccm/cmu-engineering-publications)
artifact maintained by
[`cmccomb/map-of-research`](https://github.com/cmccomb/map-of-research).

Each node is a cataloged CMU Engineering faculty member. An edge connects two
faculty members when the source artifact associates both stable faculty IDs
with the same deduplicated work. Edge thickness is the number of shared works
in the selected year range. Selecting a person exposes the publications behind
every displayed connection.

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
