## What this changes

<!-- And why. The reasoning is more useful to a reviewer than the diff. -->

## Type

- [ ] Bug fix
- [ ] New tool or capability
- [ ] Documentation
- [ ] Companion plugin
- [ ] Refactor or internal change

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] PHP changes lint clean (`php -l`)
- [ ] New tools have descriptions that say when to use them, and `.describe()` on every parameter
- [ ] Destructive behaviour previews first and requires a confirmation token
- [ ] Writes call `audit({...})`
- [ ] No `node:fs`, `node:path`, `process` or `Buffer` added under `src/lib/` or `src/tools/`
- [ ] `docs/TOOLS.md` updated if tools changed
