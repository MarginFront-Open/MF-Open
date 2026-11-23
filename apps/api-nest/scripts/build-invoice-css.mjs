#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, '..', 'src', 'templates', 'invoice.hbs');

const BEGIN_MARKER = '/* BEGIN INLINED TAILWIND CSS */';
const END_MARKER = '/* END INLINED TAILWIND CSS */';

/**
 * Minify compiled CSS safely via PostCSS AST traversal so string literals,
 * calc() expressions, and media queries remain intact.
 */
function minifyCss(css) {
  const root = postcss.parse(css);
  root.walkComments((comment) => {
    comment.remove();
  });
  root.walkDecls((decl) => {
    decl.raws.before = '';
    decl.raws.between = ':';
    decl.value = decl.value.replace(/\s+/g, ' ').trim();
  });
  root.walkRules((rule) => {
    rule.raws.before = '';
    rule.raws.between = '';
    rule.raws.after = '';
    rule.raws.semicolon = false;
    rule.selector = rule.selector.replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
  });
  root.walkAtRules((atRule) => {
    atRule.raws.before = '';
    atRule.raws.between = '';
    atRule.raws.after = '';
    atRule.raws.semicolon = false;
    if (atRule.params) {
      atRule.params = atRule.params.replace(/\s+/g, ' ').trim();
    }
  });
  return root.toString().trim();
}

export async function generateInlinedInvoiceCss(templateSource) {
  const beginIndex = templateSource.indexOf(BEGIN_MARKER);
  const endIndex = templateSource.indexOf(END_MARKER);

  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    throw new Error(
      `Missing or malformed Tailwind CSS markers (${BEGIN_MARKER} ... ${END_MARKER}) in ${TEMPLATE_PATH}`,
    );
  }

  // Scan the template without the previously inlined CSS block or HTML comments so compilation is idempotent.
  const templateForScan = (
    templateSource.slice(0, beginIndex + BEGIN_MARKER.length) +
    '\n' +
    templateSource.slice(endIndex)
  ).replace(/<!--[\s\S]*?-->/g, '');

  const tailwindConfig = {
    content: [{ raw: templateForScan, extension: 'html' }],
    theme: {
      extend: {},
    },
    corePlugins: {
      preflight: true,
    },
  };

  const compiled = await postcss([tailwindcss(tailwindConfig)]).process(
    '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
    { from: undefined },
  );

  const minified = minifyCss(compiled.css);

  if (/<\/style/i.test(minified) || minified.includes(END_MARKER)) {
    throw new Error('Compiled Tailwind CSS contains unexpected style-closing sequence');
  }

  const updatedTemplate =
    templateSource.slice(0, beginIndex + BEGIN_MARKER.length) +
    `\n      ${minified}\n      ` +
    templateSource.slice(endIndex);

  return { minified, updatedTemplate };
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const currentTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const { minified, updatedTemplate } = await generateInlinedInvoiceCss(currentTemplate);

  if (checkOnly) {
    if (currentTemplate !== updatedTemplate) {
      console.error(
        'Inlined Tailwind CSS in apps/api-nest/src/templates/invoice.hbs is out of date. Run: node apps/api-nest/scripts/build-invoice-css.mjs',
      );
      process.exit(1);
    }
    console.log(`Invoice CSS check passed (${minified.length} bytes).`);
    return;
  }

  fs.writeFileSync(TEMPLATE_PATH, updatedTemplate, 'utf8');
  console.log(`Updated ${TEMPLATE_PATH} with ${minified.length} bytes of inlined Tailwind CSS.`);
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
