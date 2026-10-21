# Agent character assets

The curated catalog is owned by `public/agent-characters/manifest.json` and rendered by
`characters.tsx` and `AgentIdentityAvatar.tsx`. The catalog contains 22 mature, restrained,
front-facing head portraits (12 selected portraits and 10 additional faces).

Existing character IDs and file names remain stable so saved `character:<id>` references
need no database migration. Nine new IDs extend the original 13-entry catalog. Custom
uploads and generated portraits are not replaced. Product assets are 512×512 WebP;
experimental source sheets are not runtime dependencies. List crops use a centered 1.01
scale rather than the former bust-oriented crops.

The automatic fallback hash continues to use only the original `korean-*` pool in its
original order. Adding selectable characters must not silently reassign existing fallback
identities. Tests: `characters.test.ts`, `AgentIdentityAvatar.test.tsx`.

Validation: catalog and avatar tests plus visual inspection of the extracted contact
sheet. Deployment and live-browser verification are separate from local asset changes.

## Visual standard: refined-colleagues-v1

Catalog version 4 preserves the same 22 IDs and adds expression metadata. Keep mature
face proportions, direct eye contact, large simplified hair masses, restrained warm
colors and subtle matte volume. Avoid enlarged childlike eyes, puffed cheeks, detailed
hair strands and exaggerated open-mouth laughter. Hair color must not be the sole
identity cue: vary face shape, eyebrow geometry, eyelids and mouth corners.

A composed smile is not mandatory. The reviewed expression set includes empathetic
inward-raised brows (Korean palja brows), reassuring brows, inquisitive asymmetric brows,
a wry one-corner smile, a welcoming smile and focused straight brows. Six portraits
were revised; the remaining sixteen retain their approved appearance. Expression names
are art-direction metadata, not claims about an agent's abilities or personality.

Delivery standard: 512px square RGBA WebP with transparent background, centered complete
hair silhouette, maximum content dimension 492px (10px safety margin per side), and
centered list crop at 1.01. Remove only border-connected pale background to preserve
light hair and facial highlights. Inspect dark and light composites before release. Keep
stable IDs, original fallback pool and custom portraits unchanged. This standard does
not authorize an automatic image-generation call or deployment.

### Transparent portrait framing

Identity and curated avatar wrappers do not paint an opaque background. AI Team
cards omit portrait borders and discovery-list accent rings so transparent hair
silhouettes sit directly on the card. Card borders and interactive focus indicators
remain unchanged. Regression coverage: `AgentIdentityAvatar.test.tsx` and
`../../components/agents/AITeamHome.directory-card.source.test.ts`.

### Expanded colleague catalog

The picker contains 73 portraits: the original 22, 28 `colleague-expanded-*`, 8 `colleague-bold-*`, 8 `colleague-distinct-*`, and 7 `colleague-expression-*`
entries. Existing IDs and the `korean-*` automatic fallback pool are unchanged,
so expanding the picker does not reassign existing colleagues. New images use
512px transparent WebP, complete silhouettes within 492px, and varied adult
face shapes, hair silhouettes and restrained expressions.

The visually redundant `colleague-distinct-4` keeps its stable ID but now uses the
silver-forelock/moustache portrait with an asymmetric skeptical brow. Seven
additional expression portraits vary brow angle, height and eyelids. Existing
assignments retain their IDs; users of the replaced ID see its updated image.

List accent rings are opt-in (`showListAccent` defaults to `false`) in both
`AgentCharacterAvatar` and `AgentIdentityAvatar`. Discovery callers that omit
the option therefore cannot accidentally restore colored portrait frames.
