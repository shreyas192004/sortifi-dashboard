const fs = require('fs');

// Read the original HTML file to extract pristine CSS
const html = fs.readFileSync('Cluedox-complete (1) (1).html', 'utf8');
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) {
  console.log('No style tag found.');
  process.exit(1);
}

let css = styleMatch[1]; // pristine original CSS

// We want to scope things cleanly.
// A safe way: PostCSS isn't installed, so we'll do careful regex.
// Find ALL blocks: `selector { rules }`
// The CSS is nicely formatted.

// 1. Replace resets
css = css.replace(/(\*,\s*\*\:\:before,\s*\*\:\:after)\s*\{/g, '.Cluedox-landing-page *, .Cluedox-landing-page *::before, .Cluedox-landing-page *::after {');

// 2. Prefix specific root tags
const tags = ['html', 'body', 'nav', 'h1', 'h2', 'h3', 'p', 'strong', 'a', 'ul', 'li', 'input', 'span', 'footer'];

for (let tag of tags) {
  // We match: start of line + tag + (optional pseudo) + optional comma/brace
  // e.g. `nav {` or `nav.scrolled {` or `a:hover {` or `html {`
  const regex = new RegExp('^(' + tag + ')([:\\.\\s,{]+)', 'gm');
  css = css.replace(regex, '.Cluedox-landing-page $1$2');
}

// 3. The `body` block itself becomes the `.Cluedox-landing-page` wrapper style
css = css.replace(/\.Cluedox-landing-page body\s*\{/g, '.Cluedox-landing-page {');

// 4. Write to CSS file natively
fs.writeFileSync('src/pages/CluedoxLandingPage.css', css, 'utf8');
console.log('Restored pristine CSS and applied clean scope.');
