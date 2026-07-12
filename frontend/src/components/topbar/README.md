# Top bar components

Focused top-bar controls live here when their interaction contract would push the `TopBar` facade beyond its enforced source budget.

- `LayoutMenu.tsx` owns layout selection, the four-distinct-markets action, outside-click dismissal and the complete vertical ARIA menu keyboard contract (`ArrowUp`, `ArrowDown`, `Home`, `End`, `Escape`).

Components receive typed state and callbacks. They do not mutate shell persistence or fetch catalogs directly.
