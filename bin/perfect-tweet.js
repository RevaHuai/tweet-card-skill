#!/usr/bin/env node
/**
 * perfect-tweet CLI
 * 命令：
 *   config  [key=value ...] | --reset     查看 / 设置模板配置（持久化）
 *   template export <文件>                  导出当前模板为 JSON 文件
 *   template import <文件>                  从 JSON 文件导入模板配置
 *   generate <链接...> [--out DIR] [--viral] [--set likes=N,views=N] [--dim KEY] [--scale N]
 *                                          批量抓取推文并生成卡片 PNG
 *   preview [--out FILE]                   用示例数据按当前模板渲染一张预览
 *   help                                   帮助
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, resetConfig, validatePatch, applyTheme, describeConfig, CONFIG_PATH, CONFIG_DIR } from '../lib/config.js';
import { renderCardHTML, DEFAULT_TWEET, DEFAULT_TEMPLATE, DIMENSIONS } from '../lib/render.js';
import { extractTweetIds, fetchTweets, applyStatsOverride } from '../lib/fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', 'ui');

// Puppeteer 体积大，仅在真正需要渲染时动态加载（config 等命令不依赖它）
async function getScreenshotBatch() {
    try {
        return (await import('../lib/screenshot.js')).screenshotBatch;
    } catch (err) {
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error('缺少依赖 puppeteer。请先在 Skill 目录执行：npm install');
        }
        throw err;
    }
}

const USAGE = `perfect-tweet — X 推文卡片批量生成器

用法：
  perfect-tweet config                       查看当前模板配置
  perfect-tweet config key=value ...         修改配置（立即持久化）
  perfect-tweet config --reset               恢复默认模板
  perfect-tweet template export <文件>       导出当前模板为 JSON（供网页版配置工具使用）
  perfect-tweet template import <文件>       从 JSON 导入模板配置
  perfect-tweet generate <链接...>           批量生成卡片（支持多链接混排一段文本）
  perfect-tweet preview                      用示例推文按当前模板渲染预览图
  perfect-tweet ui                           启动可视化配置界面（推荐先用网页版）

generate 选项：
  --out DIR            输出目录（默认取配置 outputDir）
  --dim KEY            临时尺寸：${Object.keys(DIMENSIONS).join(' | ')}
  --scale N            临时导出倍率 1~5（默认取配置 scale）
  --viral              每张卡随机生成爆款互动数据
  --set k=v,k=v        覆盖互动数据（replies/retweets/likes/bookmarks/views）
  --theme KEY          临时主题 black | white

模板工作流（推荐）：
  1. 打开 https://perfect-tweet-a6pm.vercel.app/ 配置模板
  2. 在网页上点"导出模板"下载 JSON
  3. perfect-tweet template import <下载的文件.json>
  4. perfect-tweet generate <推文链接>

示例：
  perfect-tweet template export /tmp/tpl.json
  perfect-tweet template import /tmp/tpl.json
  perfect-tweet config dimension=2:3 fontScale=120 showTranslate=true
  perfect-tweet generate https://x.com/user/status/123
`;

/* ---------- 参数解析 ---------- */
// 已知布尔 flag（后跟的参数不会被吞作值）
const BOOL_FLAGS = new Set(['viral', 'reset', 'help']);

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    let key = null;
    for (const a of argv) {
        if (a.startsWith('--') && a.length > 2) {
            const name = a.slice(2);
            if (BOOL_FLAGS.has(name)) { flags[name] = true; key = null; }
            else { key = name; flags[name] = true; } // 悬挂待值，遇下一个 flag 则保持 true
        } else if (key && flags[key] === true) {
            flags[key] = a; key = null;
        } else {
            positional.push(a);
        }
    }
    return { positional, flags };
}

const expandTilde = (p) => (p && p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p);

/** 解析 --set likes=1000,views=5000 */
function parseStatsOverride(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const out = {};
    for (const pair of raw.split(',')) {
        const m = pair.trim().match(/^(\w+)=(\d+)$/);
        if (!m) throw new Error(`--set 格式错误："${pair}"，应为 key=数字（逗号分隔）`);
        out[m[1]] = Number(m[2]);
    }
    return out;
}

/* ---------- 子命令 ---------- */

async function cmdConfig(args) {
    const { positional, flags } = parseArgs(args);

    if (flags.reset) {
        resetConfig();
        console.log('✅ 已恢复默认模板\n');
        console.log(describeConfig(loadConfig()));
        return;
    }

    const config = loadConfig();

    if (!positional.length) {
        console.log(`📄 配置文件：${CONFIG_PATH}\n`);
        console.log(describeConfig(config));
        console.log('\n提示：perfect-tweet config key=value ... 修改；--reset 恢复默认');
        return;
    }

    // key=value 解析
    const patch = {};
    for (const item of positional) {
        const eq = item.indexOf('=');
        if (eq === -1) { console.error(`❌ 参数 "${item}" 应为 key=value 形式`); process.exitCode = 1; return; }
        const k = item.slice(0, eq).trim();
        let v = item.slice(eq + 1).trim();
        if (v.startsWith('~') || /^https?:/.test(v)) v = v; // 路径/URL 原样
        else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);  // 数字
        patch[k] = v;
    }

    const { ok, patch: clean, errors } = validatePatch(patch);
    if (!ok) {
        console.error('❌ 配置校验失败：\n  - ' + errors.join('\n  - '));
        process.exitCode = 1;
        return;
    }
    applyTheme(clean, config);
    const next = { ...config, ...clean };
    if (next.bgImage) next.bgImage = expandTilde(next.bgImage);
    saveConfig(next);

    console.log('✅ 配置已保存：');
    for (const k of Object.keys(clean)) console.log(`  ${k} = ${clean[k]}`);
    console.log(`\n文件：${CONFIG_PATH}`);
    console.log('\n可运行 perfect-tweet preview 查看效果');
}

async function cmdGenerate(args) {
    const { positional, flags } = parseArgs(args);

    // positional 里可能混着一段多链接文本
    const ids = extractTweetIds(positional.join('\n'));
    if (!ids.length) {
        console.error('❌ 未找到有效的推文链接（需要 x.com 或 twitter.com 的 /status/ 链接）');
        process.exitCode = 1;
        return;
    }

    const config = loadConfig();
    // 临时覆盖（不写入持久配置）
    const style = { ...config };
    if (flags.dim) {
        if (!DIMENSIONS[flags.dim]) { console.error(`❌ 未知尺寸 "${flags.dim}"（可用：${Object.keys(DIMENSIONS).join(', ')}）`); process.exitCode = 1; return; }
        style.dimension = flags.dim;
    }
    if (flags.theme) {
        const r = validatePatch({ theme: flags.theme });
        if (!r.ok) { console.error('❌ ' + r.errors.join('; ')); process.exitCode = 1; return; }
        Object.assign(style, applyTheme(r.patch, style));
    }
    if (flags.scale) {
        const r = validatePatch({ scale: flags.scale });
        if (!r.ok) { console.error('❌ ' + r.errors.join('; ')); process.exitCode = 1; return; }
        style.scale = r.patch.scale;
    }

    let statsOverride = null;
    if (flags.set) {
        try { statsOverride = parseStatsOverride(flags.set); }
        catch (e) { console.error('❌ ' + e.message); process.exitCode = 1; return; }
    }

    console.log(`🔍 抓取 ${ids.length} 条推文…`);
    const { tweets, failed } = await fetchTweets(ids, {
        timeZone: style.timeZone,
        bearerToken: process.env.X_API_BEARER_TOKEN || null,
    });
    if (!tweets.length) {
        console.error('❌ 全部链接抓取失败，未生成任何卡片');
        process.exitCode = 1;
        return;
    }

    const outDir = expandTilde(flags.out || style.outputDir || DEFAULT_TEMPLATE.outputDir);
    console.log(`🎨 渲染 ${tweets.length} 张卡片 → ${outDir}`);

    const jobs = tweets.map((tweet, i) => {
        const t = applyStatsOverride(tweet, { statsOverride, viral: !!flags.viral });
        return {
            html: renderCardHTML(t, style),
            outPath: path.join(outDir, `tweet-${t.handle.replace('@', '')}-${i + 1}.png`),
        };
    });

    const screenshotBatch = await getScreenshotBatch();
    const done = await screenshotBatch(jobs, style.scale);

    console.log(`\n✅ 完成 ${done.length}/${ids.length} 张：`);
    for (const f of done) console.log('  ' + f);
    if (failed.length) {
        console.error(`\n⚠️  ${failed.length} 条失败：` + failed.map(f => `${f.id} (${f.error})`).join('、'));
    }
}

async function cmdPreview(args) {
    const { flags } = parseArgs(args);
    const config = loadConfig();
    const tweet = DEFAULT_TWEET();

    const outPath = expandTilde(flags.out || path.join(os.tmpdir(), 'perfect-tweet-preview.png'));
    console.log(`🎨 按当前模板渲染示例卡片（${DIMENSIONS[config.dimension]?.label}）…`);
    const screenshotBatch = await getScreenshotBatch();
    await screenshotBatch([{ html: renderCardHTML(tweet, config), outPath }], config.scale);
    console.log('✅ 预览图：' + outPath);
    console.log('\n' + describeConfig(config));
}

/** 启动可视化配置 Web UI */
async function cmdUI(args) {
    const PORT = 3456;
    const HOST = '127.0.0.1';

    // 读取 index.html
    let indexHtml;
    try {
        indexHtml = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
    } catch (e) {
        console.error('❌ 找不到 UI 文件：' + path.join(UI_DIR, 'index.html'));
        console.error('   请确保 skill/ui/index.html 已正确安装');
        process.exit(1);
    }

    // ===== Puppeteer 浏览器复用（性能优化） =====
    let browserInstance = null;
    let browserClosing = false;

    async function getBrowser() {
        if (browserClosing) {
            // 等待关闭完成
            await new Promise(resolve => setTimeout(resolve, 100));
            return getBrowser();
        }
        if (!browserInstance) {
            browserInstance = await puppeteer.launch({
                headless: 'new',
                executablePath: resolveExecutable(),
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            console.log('[UI] Puppeteer 浏览器已启动（复用实例）');
        }
        return browserInstance;
    }

    async function closeBrowser() {
        if (browserInstance && !browserClosing) {
            browserClosing = true;
            try {
                await browserInstance.close();
                console.log('[UI] Puppeteer 浏览器已关闭');
            } catch (e) {
                console.error('[UI] 关闭浏览器失败:', e.message);
            }
            browserInstance = null;
            browserClosing = false;
        }
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // CORS（本地开发用）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // ===== 静态文件 =====
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexHtml);
            return;
        }

        // ===== API: 读取配置 =====
        if (req.method === 'GET' && url.pathname === '/api/config') {
            const config = loadConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }

        // ===== API: 保存配置 =====
        if (req.method === 'POST' && url.pathname === '/api/config') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const patch = JSON.parse(body);
                    const { ok, patch: clean, errors } = validatePatch(patch);
                    if (!ok) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: errors.join('; ') }));
                        return;
                    }
                    const current = loadConfig();
                    applyTheme(clean, current);
                    const next = { ...current, ...clean };
                    if (next.bgImage && next.bgImage.startsWith('~')) {
                        next.bgImage = expandTilde(next.bgImage);
                    }
                    saveConfig(next);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, path: CONFIG_PATH }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // ===== API: 重置配置 =====
        if (req.method === 'POST' && url.pathname === '/api/reset') {
            const config = resetConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }

        // ===== API: 生成预览图 =====
        if (req.method === 'POST' && url.pathname === '/api/preview') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const config = JSON.parse(body);
                    const tweet = DEFAULT_TWEET();
                    const html = renderCardHTML(tweet, config);

                    // 使用复用的浏览器实例（性能优化）
                    const browser = await getBrowser();
                    const page = await browser.newPage();
                    await page.setViewport({
                        width: Math.round(DIMENSIONS[config.dimension]?.height * (DIMENSIONS[config.dimension]?.aspect || 9/16) * 2),
                        height: Math.round(DIMENSIONS[config.dimension]?.height * 2) || 1500,
                        deviceScaleFactor: 1
                    });
                    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
                    await waitAssets(page);
                    const pngBuffer = await page.screenshot({ type: 'png', fullPage: true });
                    await page.close(); // 只关闭 page，不关闭 browser

                    res.writeHead(200, { 'Content-Type': 'image/png' });
                    res.end(pngBuffer);
                } catch (e) {
                    console.error('[UI] 预览渲染失败:', e);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('预览渲染失败: ' + e.message);
                }
            });
            return;
        }

        // ===== API: 上传背景图 =====
        if (req.method === 'POST' && url.pathname === '/api/upload-bg') {
            // 使用 busboy 健壮解析 multipart/form-data
            let busboy;
            try {
                busboy = (await import('busboy')).default;
            } catch (e) {
                if (e.code === 'ERR_MODULE_NOT_FOUND') {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '缺少 busboy 依赖。请执行：npm install' }));
                    return;
                }
                throw e;
            }

            const bb = busboy({ headers: req.headers });
            let savedPath = null;
            let errorMsg = null;

            bb.on('file', (name, file, info) => {
                const { filename, mimeType } = info;
                if (!filename) {
                    errorMsg = '未找到文件名';
                    return;
                }
                // 验证 MIME 类型
                if (!mimeType.startsWith('image/')) {
                    errorMsg = `不支持的文件类型：${mimeType}，仅支持图片`;
                    file.resume(); // 丢弃内容
                    return;
                }
                const ext = path.extname(filename) || '.png';
                const saveName = 'bg-' + Date.now() + ext;
                const savePath = path.join(CONFIG_DIR, saveName);

                fs.mkdirSync(CONFIG_DIR, { recursive: true });
                const writeStream = fs.createWriteStream(savePath);
                file.pipe(writeStream);

                writeStream.on('finish', () => {
                    savedPath = savePath;
                });
                writeStream.on('error', (err) => {
                    errorMsg = '文件写入失败: ' + err.message;
                });
            });

            bb.on('error', (err) => {
                errorMsg = '解析上传失败: ' + err.message;
            });

            bb.on('finish', () => {
                if (errorMsg) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: errorMsg }));
                } else if (savedPath) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, path: savedPath }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '未收到文件' }));
                }
            });

            req.pipe(bb);
            return;
        }

        // ===== API: 返回背景图文件 =====
        if (req.method === 'GET' && url.pathname === '/api/bg-image') {
            const config = loadConfig();
            if (!config.bgImage || !fs.existsSync(config.bgImage)) {
                res.writeHead(404);
                res.end('背景图不存在');
                return;
            }
            const ext = path.extname(config.bgImage).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
            const stream = fs.createReadStream(config.bgImage);
            res.writeHead(200, { 'Content-Type': mime });
            stream.pipe(res);
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    server.listen(PORT, HOST, async () => {
        const url = `http://${HOST}:${PORT}`;
        console.log(`\n🚀 Perfect Tweet 可视化配置界面已启动\n`);
        console.log(`   访问地址: ${url}`);
        console.log(`   配置文件: ${CONFIG_PATH}\n`);
        console.log(`   按 Ctrl+C 停止服务器\n`);

        // 自动打开浏览器（跨平台）
        const { exec } = await import('node:child_process');
        const openCmd = {
            darwin: `open ${url}`,
            win32: `start ${url}`,
            linux: `xdg-open ${url}`
        }[process.platform] || `open ${url}`;

        exec(openCmd, (err) => {
            if (err) {
                console.log(`   请手动在浏览器中打开: ${url}\n`);
            }
        });
    });

    // 优雅退出
    process.on('SIGINT', () => {
        console.log('\n👋 服务器已停止');
        server.close();
        process.exit(0);
    });
}

/** 辅助函数：解析 Chrome 可执行文件（供 cmdUI 使用） */
async function resolveExecutable() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        const env = process.env.PUPPETEER_EXECUTABLE_PATH;
        if (fs.existsSync(env)) return env;
    }
    try {
        const p = (await import('puppeteer')).executablePath();
        if (fs.existsSync(p)) {
            const stat = fs.statSync(p);
            // Puppeteer 23+ 使用 Chrome for Testing，文件较小但完整
            if (stat.size > 100 * 1024) return p; // >100KB 即可
        }
    } catch {}
    const systemPaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
    for (const p of systemPaths) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('未找到 Chrome/Chromium');
}

/** 辅助函数：等待资源加载（供 cmdUI 使用） */
async function waitAssets(page) {
    await page.evaluate(() => {
        return new Promise(resolve => {
            if (document.readyState === 'complete') {
                setTimeout(resolve, 300);
            } else {
                window.addEventListener('load', () => setTimeout(resolve, 300));
            }
        });
    });
}

/* ---------- 模板导出 / 导入 ---------- */

async function cmdTemplateExport(args) {
    const { positional } = parseArgs(args);
    if (!positional.length) {
        console.error('❌ 用法：perfect-tweet template export <文件路径>\n  例：perfect-tweet template export /tmp/tpl.json');
        process.exitCode = 1;
        return;
    }
    const config = loadConfig();
    const outPath = expandTilde(positional[0]);
    // 只导出模板字段，排除运行时状态
    const exportKeys = [
        'theme','cardColor','textColor','dimension','fontScale','contentScale','contentWidth',
        'showDate','showViews','showTranslate','showStats','bgImage','cardOpacity',
        'cardOffsetX','cardOffsetY','scale','timeZone'
    ];
    const tpl = {};
    for (const k of exportKeys) {
        if (k in config) tpl[k] = config[k];
    }
    fs.mkdirSync(path.dirname(outPath) || '.', { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
    console.log('✅ 模板已导出：' + outPath);
    console.log('\n' + JSON.stringify(tpl, null, 2));
}

async function cmdTemplateImport(args) {
    const { positional } = parseArgs(args);
    if (!positional.length) {
        console.error('❌ 用法：perfect-tweet template import <文件路径>\n  例：perfect-tweet template import /tmp/tpl.json');
        process.exitCode = 1;
        return;
    }
    const inPath = expandTilde(positional[0]);
    if (!fs.existsSync(inPath)) {
        console.error('❌ 文件不存在：' + inPath);
        process.exitCode = 1;
        return;
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    } catch (e) {
        console.error('❌ JSON 解析失败：' + e.message);
        process.exitCode = 1;
        return;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        console.error('❌ 模板 JSON 应为对象格式');
        process.exitCode = 1;
        return;
    }
    const { ok, patch: clean, errors } = validatePatch(raw);
    if (!ok) {
        console.error('❌ 模板校验失败：\n  - ' + errors.join('\n  - '));
        process.exitCode = 1;
        return;
    }
    const current = loadConfig();
    applyTheme(clean, current);
    const next = { ...current, ...clean };
    if (next.bgImage && next.bgImage.startsWith('~')) {
        next.bgImage = expandTilde(next.bgImage);
    }
    saveConfig(next);
    console.log('✅ 模板已导入并保存：');
    for (const k of Object.keys(clean)) console.log('  ' + k + ' = ' + JSON.stringify(next[k]));
    console.log('\n文件：' + CONFIG_PATH);
    console.log('\n可运行 perfect-tweet preview 查看效果');
}

/* ---------- 入口 ---------- */

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);

    switch (cmd) {
        case 'config': await cmdConfig(rest); break;
        case 'template':
            const [sub, ...subRest] = rest;
            if (sub === 'export') await cmdTemplateExport(subRest);
            else if (sub === 'import') await cmdTemplateImport(subRest);
            else {
                console.error('❌ template 子命令：export | import\n  例：perfect-tweet template export /tmp/tpl.json');
                process.exitCode = 1;
            }
            break;
        case 'generate': case 'gen': await cmdGenerate(rest); break;
        case 'preview': await cmdPreview(rest); break;
        case 'ui': case 'web': await cmdUI(rest); break;
        case 'help': case '--help': case '-h': case undefined:
            console.log(USAGE);
            break;
        default:
            console.error(`❌ 未知命令 "${cmd}"\n`);
            console.log(USAGE);
            process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('❌ 运行失败：' + (err && err.stack ? err.stack.split('\n')[0] : err));
    process.exit(1);
});
