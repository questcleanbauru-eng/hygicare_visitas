import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const WATCH = process.argv.includes('--watch');
const SERVE = process.argv.includes('--serve');

const ENTRY_POINTS = [
    { in: path.join(__dirname, 'src/js/app.js'), out: 'app' },
    { in: path.join(__dirname, 'src/css/base.css'), out: 'base' },
    { in: path.join(__dirname, 'src/css/components.css'), out: 'components' },
    { in: path.join(__dirname, 'src/css/pages/login.css'), out: 'login' },
    { in: path.join(__dirname, 'src/css/pages/dashboard.css'), out: 'dashboard' },
    { in: path.join(__dirname, 'src/css/pages/visits.css'), out: 'css/visits' },
    { in: path.join(__dirname, 'src/css/pages/proposals.css'), out: 'css/proposals' },
    { in: path.join(__dirname, 'src/css/pages/funil.css'), out: 'css/funil' },
    { in: path.join(__dirname, 'src/css/pages/admin.css'), out: 'css/admin' },
    { in: path.join(__dirname, 'src/css/pages/report.css'), out: 'css/report' },
    { in: path.join(__dirname, 'src/css/pages/radar.css'), out: 'css/radar' }
];

function rimraf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function toDistUrl(absOutPath) {
    return './' + path.relative(DIST, absOutPath).split(path.sep).join('/');
}

// Version shown in the header so it's obvious a deploy actually landed.
// The build number comes from version.json (bumped via `npm run version:bump`
// before a commit meant to be deployed) — deliberate, not auto-derived from
// git history, since Vercel's shallow clone makes commit counts unreliable.
function getBuildInfo() {
    let sha = process.env.VERCEL_GIT_COMMIT_SHA || null;
    if (!sha) {
        try { sha = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(); } catch (e) { /* not a git checkout */ }
    }
    const short = sha ? sha.slice(0, 7) : 'dev';
    let build = 0;
    try { build = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).build; } catch (e) { /* missing file */ }
    const builtAt = new Date();
    const label = builtAt.toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    return { build, short, builtAtMs: builtAt.getTime(), label };
}

async function runBuild() {
    const start = Date.now();
    rimraf(DIST);
    fs.mkdirSync(DIST, { recursive: true });

    // Static assets (icons, manifest) copied as-is.
    copyDir(path.join(__dirname, 'public'), DIST);

    const result = await esbuild.build({
        entryPoints: ENTRY_POINTS,
        bundle: true,
        splitting: true,
        format: 'esm',
        outdir: DIST,
        entryNames: '[dir]/[name]-[hash]',
        chunkNames: 'chunks/[name]-[hash]',
        assetNames: 'assets/[name]-[hash]',
        minify: true,
        sourcemap: true,
        target: ['es2020'],
        metafile: true,
        logLevel: 'info',
        // leaflet.css referencia .png (ícones padrão de marker/layers) via
        // url() — não usamos esses ícones (pins são L.circleMarker, sem
        // imagem), mas o esbuild ainda precisa saber empacotar o arquivo CSS
        // de origem. 'file' copia como asset com hash, igual o resto.
        loader: { '.png': 'file' }
    });

    // Map each declared entry ("app", "base", "css/visits", ...) to its hashed output URL.
    const outputsByEntry = {};
    for (const [outPath, info] of Object.entries(result.metafile.outputs)) {
        if (info.entryPoint) {
            outputsByEntry[path.resolve(info.entryPoint)] = path.resolve(outPath);
        }
    }
    const urls = {};
    for (const ep of ENTRY_POINTS) {
        const outPath = outputsByEntry[path.resolve(ep.in)];
        if (outPath) urls[ep.out] = toDistUrl(outPath);
    }

    // CSS manifest consumed at runtime by ensureStyles() (utils/ui.js) for lazy page stylesheets.
    const cssManifest = {
        'css/visits': urls['css/visits'],
        'css/proposals': urls['css/proposals'],
        'css/funil': urls['css/funil'],
        'css/admin': urls['css/admin'],
        'css/report': urls['css/report'],
        'css/radar': urls['css/radar']
    };

    const buildInfo = getBuildInfo();
    writeIndexHtml(urls, cssManifest, buildInfo);
    writeServiceWorker(urls, buildInfo);

    console.log(`Build finished in ${Date.now() - start}ms -> dist/ (v${buildInfo.build} · ${buildInfo.short})`);
    return urls;
}

function writeIndexHtml(urls, cssManifest, buildInfo) {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

    html = html
        .replace('<link rel="stylesheet" href="style.css?v=45">', [
            `<link rel="stylesheet" href="${urls.base}">`,
            `<link rel="stylesheet" href="${urls.components}">`,
            `<link rel="stylesheet" href="${urls.login}">`,
            `<link rel="stylesheet" href="${urls.dashboard}">`
        ].join('\n    '))
        .replace('<link rel="manifest" href="manifest.json">', '<link rel="manifest" href="./manifest.webmanifest">')
        .replace('<span class="header-brand-name">App de Visitas</span>', [
            '<span class="header-brand-name">App de Visitas</span>',
            `<span class="header-version-tag" title="Build ${buildInfo.label} · commit ${buildInfo.short}">v${buildInfo.build}</span>`
        ].join('\n                    '))
        .replace('<script src="script.js?v=45" defer></script>', [
            `<link rel="modulepreload" href="${urls.app}">`,
            `<script>window.__ASSET_MANIFEST__ = ${JSON.stringify(cssManifest)}; window.__APP_VERSION__ = ${JSON.stringify(buildInfo)};</script>`,
            `<script type="module" src="${urls.app}"></script>`
        ].join('\n    '));

    fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');
}

function writeServiceWorker(urls, buildInfo) {
    let sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
    const precache = [
        './',
        './index.html',
        './manifest.webmanifest',
        './icons/icon.svg',
        './icons/icon-maskable.svg',
        urls.app,
        urls.base,
        urls.components,
        urls.login,
        urls.dashboard
    ];
    sw = sw
        .replace('__CACHE_VERSION__', 'v' + buildInfo.build + '-' + buildInfo.builtAtMs)
        .replace('__PRECACHE_URLS__', JSON.stringify(precache));
    fs.writeFileSync(path.join(DIST, 'sw.js'), sw, 'utf8');
}

function serve() {
    const MIME = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json',
        '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
        '.map': 'application/json'
    };
    const port = 5174;
    http.createServer((req, res) => {
        let reqPath = decodeURIComponent(req.url.split('?')[0]);
        if (reqPath === '/') reqPath = '/index.html';
        let filePath = path.join(DIST, reqPath);
        if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                fs.readFile(path.join(DIST, 'index.html'), (e2, fallback) => {
                    if (e2) { res.writeHead(404); res.end('Not found'); return; }
                    res.writeHead(200, { 'Content-Type': MIME['.html'] });
                    res.end(fallback);
                });
                return;
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
            res.end(data);
        });
    }).listen(port, () => console.log(`Serving dist/ at http://localhost:${port}`));
}

async function main() {
    await runBuild();

    if (WATCH) {
        let pending = false;
        const trigger = () => {
            if (pending) return;
            pending = true;
            setTimeout(async () => {
                pending = false;
                try { await runBuild(); } catch (e) { console.error(e); }
            }, 150);
        };
        for (const dir of ['src', 'public']) {
            fs.watch(path.join(__dirname, dir), { recursive: true }, trigger);
        }
        fs.watch(path.join(__dirname, 'index.html'), trigger);
        fs.watch(path.join(__dirname, 'sw.js'), trigger);
        console.log('Watching for changes...');
    }

    if (SERVE) serve();
}

main().catch((err) => { console.error(err); process.exit(1); });
