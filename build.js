/* build.js -- bundles public/app.jsx (which imports public/proof-ui.jsx) into
   public/bundle.js. One app, one bundle, one server: there is deliberately no
   second tree anywhere in this repo. public/bundle.js is a gitignored build
   artifact -- the deploy builds it (see .replit [deployment].build). */
const esbuild = require("esbuild");

esbuild.build({
  entryPoints: ["public/app.jsx"],
  outfile: "public/bundle.js",
  bundle: true,
  minify: true,
  sourcemap: false,
  jsx: "automatic",
  loader: { ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
}).then(() => console.log("Built public/bundle.js")).catch((e) => { console.error(e); process.exit(1); });
