# Help documentation maintenance

The in-app Help Panel requests localized topics with `?lang=en` or `?lang=ko`.

## Canonical language sources

- `docs/help/en/` — canonical English help
- `docs/help/ko/` — canonical Korean help

English is the default authoring language for new public OSS documentation unless a feature specifically requires a Korean-first guide. Important user-facing changes should update both language sets when practical.

## Root-level topic files

Files such as `docs/help/01-getting-started.md` are legacy compatibility copies from the original help system. They are not the authoring source for localized in-app help.

Do not add a third independent version of new content to the root directory. Until the compatibility files are removed from the public export and any legacy consumers, either:

- leave them unchanged and add a clear historical-status notice when they describe retired UI; or
- update them only when a known compatibility consumer still depends on that exact path.

## Documentation rules

1. Describe the current public product, not private fleet or customer operations.
2. Use the current product terms: AI teammate, Project, Session, Files, My Work, Automations, Skills, and Connections.
3. Mark retired or substantially changed screens as **Historical UI guide**.
4. Do not document Credential values, customer infrastructure, private domains, or internal deployment procedures.
5. Validate all relative Markdown links after moving or renaming a page.
6. Keep screenshots generic and review them for user, customer, domain, and Session content before publishing.
7. Link to `INSTALL.md` for installation and `docs/tower-guide/architecture.md` for system architecture instead of duplicating those contracts.

## Runtime guides

`docs/tower-guide/resources/` is not part of the localized Help authoring tree. Those files are application runtime-guide contracts loaded and packaged by backend code. Renaming or moving them requires a coordinated code and test change.
