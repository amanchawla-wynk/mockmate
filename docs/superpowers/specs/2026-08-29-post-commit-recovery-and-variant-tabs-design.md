# Post-Commit Recovery And Variant Tabs Design

## Scope

Correct Variant create, fallback, delete, and save flows when their mutation commits but the following canonical Endpoint GET fails. Complete the Variant selector's ARIA tabs interaction model without changing server contracts or unrelated dashboard behavior.

## Recovery Model

`EndpointEditor` owns one post-commit recovery state containing the preferred Variant identity when one remains meaningful. Mutation requests and canonical reloads use separate failure boundaries.

After mutation success:

- Create and delete dialogs close immediately.
- Variant save clears its submitted draft and remains committed.
- Canonical reload is attempted once through the mutation's operation-start publication owner.
- A failed reload records `Change saved, refresh failed` instead of reporting mutation failure.
- Endpoint fields, Variant fields and body actions, Variant selection, and structural actions remain locked while selected detail is known stale.
- Ordinary navigation and close pathways remain available.

The recovery Refresh acquires current publication ownership and performs only `endpointsApi.get()`. It never repeats the committed mutation. Recovery clears only after that owner accepts canonical publication; selection or ownership changes reject stale completion without publishing into a newer owner.

Genuine mutation failures retain current dialog, draft, and 409 behavior because no recovery state is created before mutation success.

## Tabs Model

Each Variant tab receives a stable Endpoint-and-Variant-derived ID, `aria-controls`, `aria-selected`, and roving `tabIndex`. The selected Variant editor is wrapped in a `tabpanel` whose stable ID and `aria-labelledby` point back to the selected tab.

ArrowLeft and ArrowRight wrap through Variants; Home and End select the first and last Variant. Keyboard activation and focus movement share the existing dirty-navigation guard with pointer selection. Locked tabs cannot select or move focus.

## Testing

Add regressions before production changes for committed create, fallback, delete, and Variant save followed by failed GET. Assert dialogs and submitted drafts remain committed, full mutation lock is active, the explicit recovery message and Refresh are available, retry calls only GET, stale ownership cannot publish, and successful canonical publication clears recovery.

Add focused relationship, roving focus, wrapping arrow, Home/End, dirty-guard, and mutation-lock tests. Then run direct, complete focused, full dashboard, typecheck, lint, build, and diff checks.
