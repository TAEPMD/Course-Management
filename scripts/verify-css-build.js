import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const assetsDirectory = join(process.cwd(), 'dist', 'assets');
const cssFiles = readdirSync(assetsDirectory).filter((file) => file.endsWith('.css'));

if (!cssFiles.length) {
  throw new Error('CSS build verification failed: no generated CSS asset found.');
}

const css = cssFiles
  .map((file) => readFileSync(join(assetsDirectory, file), 'utf8'))
  .join('\n');

const unresolvedTailwindDirective = /@tailwind\s+(?:base|components|utilities)\s*;/i.test(css);
const hasGridUtility = /\.grid\s*\{[^}]*display\s*:\s*grid/i.test(css);
const hasFlexUtility = /\.flex\s*\{[^}]*display\s*:\s*flex/i.test(css);
const hasDesktopGridBreakpoint = /\.lg\\:grid-cols-4\s*\{/i.test(css);

if (unresolvedTailwindDirective || !hasGridUtility || !hasFlexUtility || !hasDesktopGridBreakpoint) {
  throw new Error(
    'CSS build verification failed: Tailwind utilities were not generated. ' +
    'Refusing to publish a deployment with a broken layout.',
  );
}

console.log('CSS build verification passed.');
