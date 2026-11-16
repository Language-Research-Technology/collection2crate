# collection2crate

Turn a folder of files into an [RO-Crate](https://www.researchobject.org/ro-crate/), in the browser.

This repo is an [npm workspaces](https://docs.npmjs.com/cli/v8/using-npm/workspaces) monorepo with two packages:

| Workspace | Folder | What it is |
| --- | --- | --- |
| `collection2crate` | [`packages/app`](packages/app) | The browser app and its plugin engine. Spec: [`SPEC.md`](packages/app/SPEC.md), [`SPEC-UI.md`](packages/app/SPEC-UI.md) |
| `collection2crate-plugins` | [`packages/plugins`](packages/plugins) | The build plugins the app bundles. See [`README.md`](packages/plugins/README.md), [`SPEC-PLUGINS.md`](packages/plugins/SPEC-PLUGINS.md) |

## Getting started

Needs Node 22 and a Chromium-based browser (the app uses the File System Access API).

```bash
npm install
```

```bash
npm run dev
```

Other commands, all run from the repo root:

```bash
npm test                                # every suite in both packages
npm run build                           # production build into packages/app/dist
npm test -w collection2crate-plugins    # one package's tests
PLUGINS=merge,validate-crate,ro-crate-json-output npm run build   # bundle only some plugins
```

Extra arguments reach Vite after `--`, e.g. `npm run dev -- --port 3000`.

`npm install` links `node_modules/collection2crate-plugins` to `packages/plugins`, so an edit to a plugin shows up in the dev server straight away. Add a dependency to one package with `npm install <pkg> -w collection2crate` or `-w collection2crate-plugins`.

## License

[Apache 2.0](LICENSE)
