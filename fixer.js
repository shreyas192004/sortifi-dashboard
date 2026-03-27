const fs = require('fs');
let css = fs.readFileSync('src/pages/CluedoxLandingPage.css', 'utf8');

// The issue was that `.Cluedox-landing-page nav` is missing a `{`.
// We can find any `.Cluedox-landing-page [a-z]+` that is immediately followed by a newline and a CSS property.
// Example:
// .Cluedox-landing-page nav
//   position: fixed;
// Should become:
// .Cluedox-landing-page nav {
//   position: fixed;

css = css.replace(/(\.Cluedox-landing-page\s+[a-z1-6]+)\s*?\n(?=\s+[a-z\-]+:|\s*})/g, '$1 {\n');

// Also for html and body:
// .Cluedox-landing-page html
//   scroll-behavior: auto;
// }
//
// .Cluedox-landing-page body
//   font-family: var(--sans);
css = css.replace(/(\.Cluedox-landing-page\s+html)\s*?\n/g, '$1 {\n');
css = css.replace(/(\.Cluedox-landing-page\s+body)\s*?\n/g, '.Cluedox-landing-page {\n'); // Convert body to wrapper class

fs.writeFileSync('src/pages/CluedoxLandingPage.css', css, 'utf8');
console.log('Fixed missing braces in CSS.');
