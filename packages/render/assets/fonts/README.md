# Bundled caption font

Guyditor uses Inconsolata 001.010 by Raph Levien for deterministic caption
measurement and rasterization. `scripts/setup-caption-font.mjs` downloads the
58,464-byte OTF from `https://levien.com/type/myfonts/Inconsolata.otf` and
requires SHA-256
`1561e616c414a1b82d6e6dfbd18e5726fd65028913ade191e5fa38b6ec375a1a`
before atomically installing it as `Inconsolata.otf`.

The generated font is ignored by Git. It is below the repository's 100 KB file
limit and is installed by the fixture/setup and app prebuild steps. Rendering
fails closed when the file or hash differs; system-font fallback is forbidden.
The app postbuild stages the verified bytes under `dist/assets/fonts` so the
Electron main bundle resolves the same font at runtime.

Inconsolata is licensed under the SIL Open Font License 1.0. See `OFL.txt`.
