// What the bus gives worker:workbus-app (design/workbus.md §5.1): the most any seat may have, as
// one grant an owner makes (scripts/org-setup.ts). Each seat is narrowed to its doc's can, which
// the reconciler checks is within this. The app itself also edits org/, to seed it; seats only
// post there.
export const APP_CAN = {
  'org/': ['read', 'post', 'react', 'label', 'edit'],
  'eng/': ['read', 'post', 'react', 'label', 'edit'],
  'ops/': ['read', 'post', 'react', 'label', 'edit'],
  'dm/': ['read', 'post', 'react', 'label', 'edit'],
  // Plans the advisor writes (docs/plans/), and in time other seats' docs.
  'docs/': ['read', 'post', 'react', 'label', 'edit'],
}
