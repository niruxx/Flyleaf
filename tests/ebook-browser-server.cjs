// Local browser regression fixture. No database or real books/accounts are used.
// Run: node tests/ebook-browser-server.cjs; open http://127.0.0.1:8198/race and /reader.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('jszip');
const { patchPaginator } = require('../server/foliate-patch');
const root = path.resolve(__dirname, '..');
const upstream = fs.readFileSync(path.join(root, 'node_modules/foliate-js/paginator.js'), 'utf8');
const patched = patchPaginator(upstream);
const defaultsSource = fs.readFileSync(path.join(root, 'server/profiles.js'), 'utf8').match(/const DEFAULT_SETTINGS = (\{[\s\S]*?\n\});/)[1];
const defaults = vm.runInNewContext('(' + defaultsSource + ')');
const chapter = (i) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i}</title></head><body><h1>Chapter ${i}</h1>${Array.from({length:8},(_,n)=>`<p>This is paragraph ${n+1} of chapter ${i}. This fixture checks chapter transitions, mobile taps and recovery without contacting a library.</p>`).join('')}</body></html>`;
async function epub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-regression</dc:identifier><dc:title>Mobile reader regression</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-28T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>${[1,2,3,4,5].map(i=>`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${[1,2,3,4,5].map(i=>`<itemref idref="c${i}"/>`).join('')}</spine></package>`);
  zip.file('OPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${[1,2,3,4,5].map(i=>`<li><a href="c${i}.xhtml">Chapter ${i}</a></li>`).join('')}</ol></nav></body></html>`);
  for (const i of [1,2,3,4,5]) zip.file(`OPS/c${i}.xhtml`, chapter(i));
  return zip.generateAsync({ type: 'nodebuffer' });
}
const book = epub();
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const html = mode => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/m3.css"><link rel="stylesheet" href="/css/reader.css"><style>html,body{margin:0}#race{position:fixed;inset:0;display:block}</style><main id="view"></main><script type="module">import {run} from '/tests/ebook-browser-fixture.js';window.results=await run(${JSON.stringify(mode)});</script>`;
http.createServer(async (req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');const p=url.pathname;
  res.setHeader('Cache-Control','no-store');
  if(p==='/race'||p==='/reader'||p==='/reader-slide'){res.setHeader('Content-Type','text/html');res.end(html(p.startsWith('/reader')?p.slice(1):url.searchParams.has('raw')?'raw':'patched'));return;}
  if(p==='/vendor/foliate/paginator.js'||p==='/vendor/raw/paginator.js'){res.setHeader('Content-Type','text/javascript');res.end(p.includes('/raw/')?upstream:patched);return;}
  if(/^\/api\/books\/[12]\/file$/.test(p)){res.setHeader('Content-Type','application/epub+zip');res.end(await book);return;}
  if(p.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(/^\/api\/books\/[12]\/reader$/.test(p)?{book:{id:p.includes('/2/')?2:1,title:'Mobile reader regression',label:'Test book',format:'epub',engine:'text',kind:'books',version:1,seriesId:1},settings:{...defaults,pageTurn:p.includes('/2/')?'slide':'book'},annotations:[],keybinds:null,profile:{name:'Test'}}:p==='/api/fonts'?[]:{ok:true}));return;}
  let file;
  if(p==='/tests/ebook-browser-fixture.js')file=path.join(__dirname,'ebook-browser-fixture.js');
  else if(p.startsWith('/vendor/foliate/'))file=path.join(root,'node_modules/foliate-js',p.slice('/vendor/foliate/'.length));
  else if(p.startsWith('/vendor/roboto-flex/'))file=path.join(root,'node_modules/@fontsource-variable/roboto-flex',p.slice('/vendor/roboto-flex/'.length));
  else if(p.startsWith('/vendor/symbols/'))file=path.join(root,'node_modules/material-symbols',p.slice('/vendor/symbols/'.length));
  else file=path.join(root,'public',p);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data)});
}).listen(8198,'127.0.0.1',()=>console.log('Ebook fixtures: http://127.0.0.1:8198/race?raw and /race and /reader'));
