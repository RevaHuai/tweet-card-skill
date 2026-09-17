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
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, resetConfig, validatePatch, applyTheme, describeConfig, CONFIG_PATH, CONFIG_DIR } from '../lib/config.js';
import { renderCardHTML, DEFAULT_TWEET, DEFAULT_TEMPLATE, DIMENSIONS } from '../lib/render.js';
import { extractTweetIds, fetchTweets, applyStatsOverride } from '../lib/fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 渲染依赖（puppeteer-core）仅在真正需要出图时动态加载，config 等命令启动更快
async function getScreenshotBatch() {
    try {
        return (await import('../lib/screenshot.js')).screenshotBatch;
    } catch (err) {
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error('缺少依赖（puppeteer-core）。请先在 Skill 目录执行：npm install');
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
  perfect-tweet help                         帮助

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

const FIRST_RUN_GUIDE = `
🎨 欢迎使用 perfect-tweet！

首次使用请先配置模板：
  1. 打开 https://perfect-tweet-a6pm.vercel.app/
  2. 调整主题、尺寸、字号等参数
  3. 点 ↓ 按钮导出模板 JSON
  4. 运行：perfect-tweet template import <下载的文件.json>
  5. 然后运行：perfect-tweet generate <推文链接>

或直接运行 perfect-tweet config 手动调整参数。
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

/** 检测是否为首次运行（config.json 不存在） */
function isFirstRun() {
    return !fs.existsSync(CONFIG_PATH);
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
    for (const k of Object.keys(clean)) console.log('  ' + k + ' = ' + clean[k]);
    console.log('\n文件：' + CONFIG_PATH);
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
    // 首次运行检测：引导用户去网页版配置模板
    if (isFirstRun() && process.argv.length <= 2) {
        console.log(FIRST_RUN_GUIDE);
        console.log(USAGE);
        return;
    }

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
        case 'ui': case 'web':
            console.log('ℹ️  本地 UI 已移除，请使用网页版配置工具：');
            console.log('   https://perfect-tweet-a6pm.vercel.app/');
            console.log('\n   配置完成后导出模板 JSON，然后运行：');
            console.log('   perfect-tweet template import <文件.json>');
            break;
        case 'help': case '--help': case '-h': case undefined:
            console.log(USAGE);
            if (isFirstRun()) console.log(FIRST_RUN_GUIDE);
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
