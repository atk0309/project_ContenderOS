# Design source of truth (vendored)

This directory is the in-repository, durable reference for the Contender UI. Screen work is
verified against the files here; see
[`../architecture/design-system.md`](../architecture/design-system.md) for the
token/typography/motion specification and per-screen fidelity rubric.

## Canonical source

The tracked source is:

- `Contender.dc.html` — the full application mockup and its synthetic demonstration data;
- `ReviewNote.dc.html` — the inline review-note card and its
  accept/dismiss/sign-off/view-diff states.

The snapshots were authored in a maintainer design workspace. Its private project identifier and
account metadata are intentionally not part of the public repository. Public contributors should
treat the vendored files as canonical.

## Refreshing a snapshot

Maintainers with access to the source design workspace can refresh a snapshot on demand:

1. Export the changed `.dc.html` file and any screenshots needed for the affected screen.
2. Decode the exported `content` field if the tool returns JSON-wrapped HTML.
3. Replace the corresponding vendored snapshot.
4. Review the diff and port only the intended component-level changes into the application.
5. Verify the implementation against the refreshed screenshots and the design-system fidelity
   rubric.

Never copy account details, workspace identifiers, real CV content, or other personal data from a
design workspace into these fixtures.

## Screenshots

Screenshots are not committed as binaries because they are large and can contain live-session data.
During an authorised design refresh, maintainers may pull only the states needed for local
verification. Keep those artifacts untracked.

Typical fidelity states include sign-in, workspace list, workspace editor, master profile, import
and reconciliation, new application, tracker and detail views, diff, gatekeeper, and light/dark
theme variants.

The mockup also includes intentionally unimplemented concepts. See
[`../architecture/design-system.md`](../architecture/design-system.md) for the current divergence
list before porting a surface.
