# Third-party notices

MarginFront is released under the MIT License (see `LICENSE`). It includes data
copied from the projects below. Their notices are reproduced here as their
licenses ask.

Packages installed from npm keep their own license files inside
`node_modules`; they are not listed here.

## LiteLLM model price data

- **What is included:** model prices and context-window sizes taken from
  LiteLLM's `model_prices_and_context_window.json`.
- **Where it is in this repository:**
  - `packages/db/data/price-catalog-snapshot.json`: rows whose `source` is
    `litellm`, taken from the copy of 2026-11-18 (the file's `capturedOn`).
  - `apps/dashboard/public/data/litellm-model-prices.json`: a full,
    unchanged copy of the file, taken on 2026-11-18.
  - `packages/db/scripts/__tests__/fixtures/price-catalog-2026-08-17.json`:
    rows whose `source` is `litellm`, taken on 2026-08-17 and kept as they
    were so the tests that read them stay fixed.
- **Source:** <https://github.com/BerriAI/litellm>
- **License:** MIT

```
MIT License

Copyright (c) 2023 Berri AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
